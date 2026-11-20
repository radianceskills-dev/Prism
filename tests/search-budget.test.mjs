import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, MAX_CHAT_SEARCHES, conversationSearchCount } from '../api.js';

const options = { endpoint: 'https://example.com/v1beta', key: 'secret', model: 'models/gemini-flash', contents: [{ role: 'user', parts: [{ text: 'Search' }] }], searchEnabled: true };
const args = { objective: 'Find documentation', search_queries: ['official documentation'] };
const call = { functionCall: { name: 'parallel_search', args } };
const reply = (...parts) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
const answer = reply({ text: 'Finished.' });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('conversation search budget is20 and legacy activity/history are not double-counted', () => {
  assert.equal(MAX_CHAT_SEARCHES, 20);
  assert.equal(conversationSearchCount(), 0);
  assert.equal(conversationSearchCount({ transcript: [{ searches: [1, 2] }], history: [{ parts: [call, call] }] }), 2);
  assert.equal(conversationSearchCount({ searchCount: 7, transcript: [{ searches: [1, 2] }] }), 7);
  assert.equal(conversationSearchCount({ searchCount: -1, history: [{ parts: [call] }] }), 1);
  assert.equal(conversationSearchCount({ searchCount: 100 }), 20);
  assert.equal(conversationSearchCount({ searchCount: '19', transcript: [{ searches: [1] }] }), 1);
  assert.equal(conversationSearchCount({ transcript: Array.from({ length: 21 }, () => ({ searches: [1] })) }), 20);
});

test('remaining conversation budget is enforced within a mixed-size batch', async () => {
  let requests = 0, searches = 0, starts = 0;
  const result = await generateReply({ ...options, searchesUsed: 19,
    onSearch: event => { if (event.status === 'searching') starts++; },
    searchImpl: async () => { searches++; return { text: 'Result' }; },
    fetchImpl: async (_, request) => {
      const body = JSON.parse(request.body);
      assert.match(body.systemInstruction.parts[0].text, /20 search attempts per conversation/);
      assert.ok(body.systemInstruction.parts[0].text.includes(`${requests === 0 ? 1 : 0} searches remain`));
      if (++requests === 1) return json(reply(call, call, call));
      assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
      assert.deepEqual(body.tools[0].functionDeclarations.map(tool => tool.name), ['prism_help']);
      const responses = body.contents.at(-1).parts;
      assert.equal(responses.length, 3);
      assert.equal(responses[0].functionResponse.response.text, 'Result');
      assert.match(responses[1].functionResponse.response.error, /Search limit reached/);
      assert.match(responses[2].functionResponse.response.error, /Search limit reached/);
      return json(answer);
    },
  });
  assert.equal(searches, 1);
  assert.equal(starts, 1);
  assert.equal(result.searches.length, 1);
});

test('exhausted chats can answer without search declarations and refuse fabricated search calls', async () => {
  await generateReply({ ...options, searchesUsed: 20, searchImpl: async () => assert.fail('Exhausted search'), fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body);
    assert.deepEqual(body.tools[0].functionDeclarations.map(tool => tool.name), ['prism_help']);
    assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
    assert.match(body.systemInstruction.parts[0].text, /search limit is reached/);
    return json(answer);
  } });
  await assert.rejects(generateReply({ ...options, searchesUsed: 20, searchImpl: async () => assert.fail('Exhausted search'), fetchImpl: async () => json(reply(call)) }), /requesting searches after the search limit/);
});

test('invalid persisted usage fails closed before model or search requests', async () => {
  for (const searchesUsed of [-1, 21, NaN, 1.5, '2', null]) {
    await assert.rejects(generateReply({ ...options, searchesUsed, fetchImpl: async () => assert.fail('Invalid usage request') }), /Invalid conversation search usage/);
  }
});

test('a search waits for durable usage reservation before dispatch', async () => {
  const order = [];
  let requests = 0;
  await generateReply({ ...options, onSearch: async event => {
    if (event.status === 'searching') { order.push('saving'); await Promise.resolve(); order.push('saved'); }
  }, searchImpl: async () => { assert.deepEqual(order, ['saving', 'saved']); order.push('sent'); return { text: 'Result' }; }, fetchImpl: async () => json(++requests === 1 ? reply(call) : answer) });
  assert.deepEqual(order, ['saving', 'saved', 'sent']);
  await assert.rejects(generateReply({ ...options, onSearch: async () => { throw new Error('Reservation failed'); }, searchImpl: async () => assert.fail('Unreserved search'), fetchImpl: async () => json(reply(call)) }), /Reservation failed/);
});
