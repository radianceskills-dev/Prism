import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, runParallelSearch } from '../api.js';
const options = { endpoint: 'https://example.com/v1beta', key: 'secret', model: 'models/gemini-flash', contents: [{ role: 'user', parts: [{ text: 'Find current Node docs' }] }] };
const args = { objective: 'Find official Node.js documentation', search_queries: ['Node.js official docs'] };
const call = (extra = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'parallel_search', args, id: 'call-1', ...extra }, thoughtSignature: 'signature-must-survive' }] }, finishReason: 'STOP' }] });
const final = { candidates: [{ content: { role: 'model', parts: [{ text: 'See [Node.js](https://nodejs.org/docs/).' }] }, finishReason: 'STOP' }] };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('search is absent by default and never runs without permission', async () => {
  let searches = 0;
  await generateReply({ ...options, searchImpl: async () => searches++, fetchImpl: async (_, request) => {
    assert.deepEqual(JSON.parse(request.body).tools[0].functionDeclarations.map(tool => tool.name), ['prism_help']);
    return json(final);
  } });
  await assert.rejects(generateReply({ ...options, searchImpl: async () => searches++, fetchImpl: async () => json(call()) }), /unsupported tools/);
  assert.equal(searches, 0);
});

test('executes Gemini search requests, returns results and preserves thought signatures/history', async () => {
  const requests = [];
  const events = [];
  const result = await generateReply({ ...options, searchEnabled: true, onSearch: event => events.push(event.status), searchImpl: async input => {
    assert.deepEqual(input, args);
    return { text: 'https://nodejs.org/docs/ Official documentation' };
  }, fetchImpl: async (_, request) => {
    requests.push(JSON.parse(request.body));
    return json(requests.length === 1 ? call() : final);
  } });
  assert.deepEqual(requests[0].tools[0].functionDeclarations.map(tool => tool.name), ['prism_help', 'parallel_search']);
  assert.equal(requests[0].toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.equal(requests[1].contents[1].parts[0].thoughtSignature, 'signature-must-survive');
  assert.equal(requests[1].contents[2].parts[0].functionResponse.id, 'call-1');
  assert.match(requests[1].contents[2].parts[0].functionResponse.response.text, /nodejs.org/);
  assert.equal(result.contents.length, 4);
  assert.deepEqual(events, ['searching', 'complete']);
  assert.equal(result.searches[0].status, 'complete');
});

test('search-enabled model may choose to answer without searching', async () => {
  const result = await generateReply({ ...options, searchEnabled: true, searchImpl: async () => assert.fail('Unnecessary search'), fetchImpl: async () => json(final) });
  assert.deepEqual(result.searches, []);
});

test('failed searches become explicit error responses, not invented results', async () => {
  let count = 0;
  const result = await generateReply({ ...options, searchEnabled: true, searchImpl: async () => { throw new Error('Parallel free tier rate limit'); }, fetchImpl: async (_, request) => {
    if (++count === 1) return json(call());
    assert.match(JSON.parse(request.body).contents.at(-1).parts[0].functionResponse.response.error, /rate limit/);
    return json(final);
  } });
  assert.equal(result.searches[0].status, 'error');
});

test('limits searches to twenty, retains read-only help, and refuses further search execution', async () => {
  let count = 0;
  let searches = 0;
  await generateReply({ ...options, searchEnabled: true, searchImpl: async () => { searches++; return { text: 'Results' }; }, fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body);
    if (++count <= 20) return json(call());
    assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
    assert.deepEqual(body.tools[0].functionDeclarations.map(tool => tool.name), ['prism_help']);
    return json(final);
  } });
  assert.equal(searches, 20);
  await assert.rejects(generateReply({ ...options, searchEnabled: true, searchImpl: async () => ({ text: 'Results' }), fetchImpl: async () => json(call()) }), /search limit/);
});

test('unknown tools, too many calls and malformed arguments cannot execute', async () => {
  for (const reply of [call({ name: 'web_fetch' }), { candidates: [{ content: { parts: Array(21).fill(call().candidates[0].content.parts[0]) } }] }]) {
    await assert.rejects(generateReply({ ...options, searchEnabled: true, searchImpl: async () => assert.fail('Forbidden'), fetchImpl: async () => json(reply) }), /unsupported tools|too many/);
  }
  let count = 0;
  const result = await generateReply({ ...options, searchEnabled: true, searchImpl: async () => assert.fail('Invalid args'), fetchImpl: async () => json(++count === 1 ? call({ args: { objective: '', search_queries: [] } }) : final) });
  assert.match(result.searches[0].error, /Invalid search arguments/);
});

test('cancellation during tool execution prevents any further Gemini request', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(generateReply({ ...options, signal: controller.signal, searchEnabled: true, searchImpl: async () => { controller.abort(); throw controller.signal.reason; }, fetchImpl: async () => { requests++; return json(call()); } }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('direct browser search sends MCP query metadata, never Gemini key or local API requests', async () => {
  const methods = [];
  const result = await runParallelSearch(args, { model: options.model, sessionId: 'session', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://search.parallel.ai/mcp');
    assert.equal(request.headers['x-goog-api-key'], undefined);
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.credentials, 'omit');
    const body = JSON.parse(request.body);
    methods.push(body.method);
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(body.params.name, 'web_search');
    assert.deepEqual(body.params.arguments, { ...args, session_id: 'session', model_name: options.model });
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Results' }] } });
  } });
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(result.text, 'Results');
});
