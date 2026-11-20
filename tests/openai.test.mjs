import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ENDPOINT, DEFAULT_OPENAI_ENDPOINT, normalizeProtocol, fetchModels, generateReply, getArtefactInstruction, conversationSearchCount } from '../api.js';

const endpoint = 'https://compatible.example/v1', key = 'oa-secret-test', model = 'org/deepseek:free';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (message = { content: 'Hello' }, finish_reason = 'stop', usage) => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }], ...(usage ? { usage } : {}) });
const call = (id, name = 'notion_tool', args = { name: 'read', arguments_json: '{}' }) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const toolCompletion = (...calls) => completion({ content: null, tool_calls: calls }, 'tool_calls');
const options = extra => ({ endpoint, key, model, protocol: 'openai', contents: [{ role: 'user', parts: [{ text: 'Question' }] }], ...extra });
const notionTools = [{ name: 'read', description: 'Read a page', inputSchema: { type: 'object' } }];
function sequence(values, inspect = () => {}) {
  let count = 0;
  return async (url, init) => {
    assert.ok(count < values.length, 'Unexpected additional API request');
    const body = init.body ? JSON.parse(init.body) : undefined;
    inspect(url, init, body, count);
    const value = values[count++];
    return value instanceof Response ? value : json(value);
  };
}

test('public protocol contract preserves native defaults and normalizes only the exact OpenAI value', () => {
  assert.equal(DEFAULT_ENDPOINT, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(DEFAULT_OPENAI_ENDPOINT, 'https://api.openai.com/v1');
  assert.equal(normalizeProtocol('openai'), 'openai');
  for (const value of [undefined, null, '', false, 'OpenAI', 'OPENAI', ' openai ', 'gemini', {}, ['openai']]) assert.equal(normalizeProtocol(value), 'gemini');
});

test('OpenAI discovery uses bearer-only safe transport, all model IDs, stable sorted dedupe and optional context', async () => {
  const models = await fetchModels({ endpoint: `${endpoint}///`, key: ` ${key} `, protocol: 'openai', fetchImpl: async (url, init) => {
    assert.equal(url, `${endpoint}/models`);
    assert.deepEqual(init.headers, { Authorization: `Bearer ${key}` });
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer');
    return json({ data: [{ id: 'z/audio', context_window: 4096 }, { id: model, context_length: 128000 }, { id: model, context_length: 1 }, { id: 'a/image', max_model_len: -2 }, { id: '' }, null, { id: ' bad ' }, { id: 'bad\u0000id' }] });
  } });
  assert.deepEqual(models, [{ name: 'a/image', displayName: 'a/image' }, { name: model, displayName: model, contextWindow: 128000 }, { name: 'z/audio', displayName: 'z/audio', contextWindow: 4096 }]);
});

test('OpenAI optional keys omit Authorization entirely; Gemini still fails before unauthenticated fetch', async () => {
  for (const absent of [undefined, '', '   ']) {
    await fetchModels({ endpoint: 'http://localhost:1234/v1', protocol: 'openai', key: absent, fetchImpl: async (_, init) => { assert.deepEqual(init.headers, {}); return json({ data: [] }); } });
    const result = await generateReply(options({ key: absent, fetchImpl: async (_, init) => { assert.deepEqual(init.headers, { 'Content-Type': 'application/json' }); return json(completion()); } }));
    assert.equal(result.text, 'Hello');
  }
  await assert.rejects(fetchModels({ endpoint: DEFAULT_ENDPOINT, fetchImpl: async () => assert.fail('Unauthorized Gemini fetch') }), /API key/);
});

test('OpenAI pagination uses only encoded after cursors at the original origin, never supplied next URLs', async () => {
  const result = await fetchModels({ endpoint, key, protocol: 'openai', fetchImpl: sequence([
    { data: [{ id: 'z' }], has_more: true, last_id: 'https://evil.invalid/?steal=x&y=z', next: 'https://evil.invalid/' },
    { data: [{ id: 'a' }, { id: 'z' }], has_more: true },
    { data: [{ id: 'b' }], has_more: false, next: 'https://evil.invalid/' },
  ], (url, _, __, index) => {
    const parsed = new URL(url); assert.equal(parsed.origin, 'https://compatible.example'); assert.equal(parsed.pathname, '/v1/models');
    assert.equal(parsed.searchParams.get('after'), index === 0 ? null : index === 1 ? 'https://evil.invalid/?steal=x&y=z' : 'z');
  }) });
  assert.deepEqual(result.map(item => item.name), ['a', 'b', 'z']);
});

test('OpenAI discovery rejects malformed lists, cursor loops and excessive pagination', async () => {
  for (const value of [{}, null, { data: {} }, { models: [] }, { data: [], has_more: true }, { data: [], has_more: 'true', last_id: 'x' }, { data: [], has_more: true, last_id: {} }]) await assert.rejects(fetchModels({ endpoint, key, protocol: 'openai', fetchImpl: async () => json(value) }), /model list|pagination/);
  await assert.rejects(fetchModels({ endpoint, key, protocol: 'openai', fetchImpl: async () => json({ data: [], has_more: true, last_id: 'repeat' }) }), /pagination/);
  let pages = 0;
  await assert.rejects(fetchModels({ endpoint, key, protocol: 'openai', fetchImpl: async () => json({ data: [], has_more: true, last_id: `page-${++pages}` }) }), /pagination/);
  assert.equal(pages, 100);
});

test('plain OpenAI multi-turn sends fixed chat URL, model ID in JSON, system guidance, messages and usage', async () => {
  const contents = [{ role: 'user', parts: [{ text: 'Hello' }] }, { role: 'model', parts: [{ text: 'Hi' }] }, { role: 'user', parts: [{ text: 'More' }, { text: ' please' }] }];
  const snapshot = structuredClone(contents);
  const result = await generateReply(options({ model: 'org/model:free?not=a/url', contents, systemInstruction: 'Be concise', artefactMode: 'off', fetchImpl: async (url, init) => {
    assert.equal(url, `${endpoint}/chat/completions`); assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'org/model:free?not=a/url'); assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, 'system');
    assert.ok(body.messages[0].content.startsWith(`Be concise\n\n${getArtefactInstruction('off')}\n\n`));
    assert.match(body.messages[0].content, /prism_help is an available read-only local hint tool/);
    assert.deepEqual(body.messages.slice(1), [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'More please' }]);
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['prism_help']); assert.equal(body.tool_choice, 'auto'); assert.equal(body.contents, undefined);
    return json(completion({ content: [{ type: 'text', text: 'An' }, { type: 'text', text: ' answer' }] }, 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }));
  } }));
  assert.equal(result.text, 'An answer'); assert.equal(result.warning, '');
  assert.deepEqual(result.usage, { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 });
  assert.deepEqual(contents, snapshot); assert.equal(result.contents.at(-1).role, 'model'); assert.equal(result.contents.at(-1).parts[0].text, 'An answer');
});

test('OpenAI warnings, refusals, empty/malformed completions and invalid model names fail clearly', async () => {
  const truncated = await generateReply(options({ fetchImpl: async () => json(completion({ content: 'Partial' }, 'length')) }));
  assert.match(truncated.warning, /output limit/);
  const filtered = await generateReply(options({ fetchImpl: async () => json(completion({ content: 'Safe partial' }, 'content_filter')) }));
  assert.match(filtered.warning, /SAFETY/);
  for (const [value, expected] of [[completion({ content: null, refusal: 'Denied' }), /REFUSAL/], [completion({ content: '' }), /no text/], [{ choices: [] }, /Unexpected completion/], [completion({ content: 3 }), /text completion/], [completion({ content: [{ type: 'image_url' }] }), /text completion/], [completion({ role: 'user', content: 'Wrong' }), /Unexpected completion/]]) await assert.rejects(generateReply(options({ fetchImpl: async () => json(value) })), expected);
  for (const invalid of ['', ' bad ', 'x\u0000y', null]) await assert.rejects(generateReply(options({ model: invalid, fetchImpl: async () => assert.fail('Invalid model sent') })), /valid model/);
});

test('OpenAI HTTP errors redact trimmed secrets, nonJSON and browser/CORS failures are clear', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) await assert.rejects(generateReply(options({ key: ` ${key} `, fetchImpl: async () => json({ error: { message: `Denied ${key}` } }, status) })), error => { assert.match(error.message, new RegExp(`API error ${status}`)); assert.ok(!error.message.includes(key)); assert.match(error.message, /redacted/); return true; });
  await assert.rejects(generateReply(options({ fetchImpl: async () => new Response('<html>no</html>', { status: 502 }) })), /non-JSON.*OpenAI-compatible/);
  await assert.rejects(generateReply(options({ fetchImpl: async () => { throw new TypeError(key); } })), error => { assert.match(error.message, /CORS.*Redirects/); assert.ok(!error.message.includes(key)); return true; });
});

test('OpenAI cancellation is respected before fetch, during fetch and after asynchronous JSON parsing', async () => {
  const before = new AbortController(); before.abort(new DOMException('Stop', 'AbortError'));
  await assert.rejects(generateReply(options({ signal: before.signal, fetchImpl: async () => assert.fail('Cancelled request sent') })), { name: 'AbortError' });
  await assert.rejects(fetchModels({ endpoint, protocol: 'openai', signal: before.signal, fetchImpl: async () => assert.fail('Cancelled discovery sent') }), { name: 'AbortError' });
  for (const discover of [false, true]) {
    const controller = new AbortController();
    const fetchImpl = async () => ({ ok: true, status: 200, async json() { controller.abort(new DOMException('Stopped', 'AbortError')); return discover ? { data: [] } : completion(); } });
    await assert.rejects(discover ? fetchModels({ endpoint, protocol: 'openai', signal: controller.signal, fetchImpl }) : generateReply(options({ signal: controller.signal, fetchImpl })), { name: 'AbortError' });
  }
  const during = new AbortController();
  await assert.rejects(generateReply(options({ signal: during.signal, fetchImpl: async () => { during.abort(new DOMException('Stop', 'AbortError')); throw during.signal.reason; } })), { name: 'AbortError' });
});

test('OpenAI translates lowercase function schemas and reuses automatic Notion/search rounds and reasoning', async () => {
  const raw = '{ "name" : "read", "arguments_json" : "{\\"page\\":1}" }';
  const bodies = [], executions = [], searchEvents = [], toolEvents = [];
  const reasoning_details = [{ type: 'reasoning.encrypted', data: 'opaque' }];
  const result = await generateReply(options({ systemInstruction: 'Custom', artefactMode: 'enforced', searchEnabled: true, notionTools,
    notionCall: async (name, args) => { executions.push([name, args]); return { text: 'Notion result' }; },
    searchImpl: async () => ({ text: 'Search result' }), onSearch: event => searchEvents.push(event), onTool: event => toolEvents.push(event),
    fetchImpl: sequence([
      completion({ content: 'I will check.', reasoning_content: 'Private reasoning', reasoning_details, tool_calls: [call('n1', 'notion_tool', raw)] }, 'tool_calls'),
      toolCompletion(call('s1', 'parallel_search', { objective: 'Current facts', search_queries: ['current facts'] })),
      toolCompletion(call('n2')),
      completion({ content: 'Done', reasoning_content: 'Finished' }),
    ], (_, __, body) => { bodies.push(body); assert.match(body.messages[0].content, /Custom/); assert.ok(body.messages[0].content.includes(getArtefactInstruction('enforced'))); assert.equal(body.tool_choice, 'auto');
      for (const tool of body.tools) { assert.equal(tool.type, 'function'); assert.equal(tool.function.parameters.type, 'object'); }
      assert.equal(body.tools.find(tool => tool.function.name === 'parallel_search').function.parameters.properties.search_queries.items.type, 'string');
    })
  }));
  assert.deepEqual(executions, [['read', { page: 1 }], ['read', {}]]); assert.equal(result.tools.length, 2); assert.equal(result.searches.length, 1); assert.equal(searchEvents.length, 2); assert.equal(toolEvents.length, 4);
  const echoed = bodies[1].messages.find(message => message.tool_calls);
  assert.equal(echoed.reasoning_content, 'Private reasoning'); assert.deepEqual(echoed.reasoning_details, reasoning_details); assert.equal(echoed.content, 'I will check.');
  assert.equal(echoed.tool_calls[0].function.arguments, raw); assert.equal(echoed.tool_calls[0].id, 'n1');
  assert.equal(bodies[1].messages.at(-1).role, 'tool'); assert.equal(bodies[1].messages.at(-1).tool_call_id, 'n1');
  assert.equal(result.contents[1].prismOpenAI.reasoning_content, 'Private reasoning'); assert.deepEqual(result.contents[1].prismOpenAI.toolCalls, [{ id: 'n1', arguments: raw }]);
  assert.equal(conversationSearchCount({ history: result.contents }), 1);
});

test('OpenAI shared search budget reaches twenty across batches, then retains help without further search execution', async () => {
  let searches = 0; const bodies = [];
  const result = await generateReply(options({ searchesUsed: 18, searchEnabled: true, searchImpl: async () => { searches++; return { text: 'result' }; }, fetchImpl: sequence([
    toolCompletion(call('s1', 'parallel_search', { objective: 'Facts', search_queries: ['facts'] }), call('s2', 'parallel_search', { objective: 'More', search_queries: ['more'] }), call('s3', 'parallel_search', { objective: 'Extra', search_queries: ['extra'] })), completion({ content: 'Within budget' }),
  ], (_, __, body) => bodies.push(body)) }));
  assert.equal(searches, 2); assert.equal(result.searches.length, 2); assert.equal(bodies[1].tool_choice, 'auto');
  assert.deepEqual(bodies[1].tools.map(tool => tool.function.name), ['prism_help']);
  assert.match(bodies[1].messages[0].content, /0 searches remain/); assert.match(bodies[1].messages.at(-1).content, /Search limit reached/);
  assert.equal(conversationSearchCount({ history: result.contents, searchCount: 20 }), 20);
});

test('OpenAI exhausted search does not limit Notion across more than twenty calls or rounds', async () => {
  let executed = 0;
  const batches = [toolCompletion(...Array.from({ length: 21 }, (_, i) => call(`n${i}`))), toolCompletion(call('n21')), completion({ content: 'All finished' })];
  const result = await generateReply(options({ searchEnabled: true, searchesUsed: 20, notionTools, notionCall: async () => { executed++; return { text: 'ok' }; }, fetchImpl: sequence(batches, (_, __, body) => { assert.deepEqual(body.tools.map(tool => tool.function.name), ['prism_help', 'notion_tool']); assert.equal(body.tool_choice, 'auto'); }) }));
  assert.equal(executed, 22); assert.equal(result.tools.length, 22); assert.equal(result.searches.length, 0);
});

test('OpenAI malformed argument JSON/primitive/array and unknown calls return errors without executing', async () => {
  for (const malformed of ['{bad', 'null', '[]', '4', '{"name":"unlisted","arguments_json":"{}"}', JSON.stringify({ name: 'read', arguments_json: '{broken' }), JSON.stringify({ name: 'read', arguments_json: JSON.stringify({ leaked: key }) })]) {
    let followup;
    const result = await generateReply(options({ notionTools, notionCall: async () => assert.fail('Malformed tool executed'), fetchImpl: sequence([toolCompletion(call('bad', 'notion_tool', malformed)), completion({ content: 'Recovered' })], (_, __, body, i) => { if (i) followup = body; }) }));
    assert.equal(result.tools[0].status, 'error'); assert.match(followup.messages.at(-1).content, /error/); assert.equal(followup.messages.at(-2).tool_calls[0].function.arguments, malformed);
  }
  let followup;
  await generateReply(options({ notionTools, searchEnabled: false, notionCall: async () => assert.fail('Unknown tool executed'), searchImpl: async () => assert.fail('Disabled search executed'), fetchImpl: sequence([toolCompletion(call('unknown', 'remove_everything'), call('disabled', 'parallel_search', { objective: 'x', search_queries: ['x'] })), completion()], (_, __, body, i) => { if (i) followup = body; }) }));
  for (const message of followup.messages.slice(-2)) assert.match(message.content, /Unknown or disabled tool/);
});

test('OpenAI validates every batch ID and call structure before any valid action dispatch', async () => {
  for (const invalid of [call('duplicate'), { ...call('bad'), id: undefined }, { ...call('bad'), type: 'other' }, { ...call('bad'), function: { name: 'notion_tool', arguments: {} } }, { ...call('bad'), function: { name: '', arguments: '{}' } }, { ...call('bad'), function: { name: 'invalid.name', arguments: '{}' } }, { ...call('bad'), function: { name: 'bad\nname', arguments: '{}' } }, { ...call('bad'), id: '\u0000' }, null]) {
    const first = call('duplicate');
    await assert.rejects(generateReply(options({ notionTools, notionCall: async () => assert.fail('Partially valid batch executed'), fetchImpl: async () => json(toolCompletion(first, invalid)) })), /Invalid|duplicate/);
  }
  const history = [{ role: 'model', parts: [{ functionCall: { id: 'used', name: 'notion_tool', args: { name: 'read', arguments_json: '{}' } } }] }, { role: 'user', parts: [{ functionResponse: { id: 'used', name: 'notion_tool', response: { text: 'already executed' } } }] }];
  await assert.rejects(generateReply(options({ contents: history, notionTools, notionCall: async () => assert.fail('Duplicate historical action executed'), fetchImpl: async () => json(toolCompletion(call('used'))) })), /Duplicate.*history/);
});

test('OpenAI malformed search consumes a reserved attempt but does not execute and echoes raw arguments', async () => {
  let followup;
  const result = await generateReply(options({ searchEnabled: true, searchesUsed: 19, searchImpl: async () => assert.fail('Malformed search executed'), fetchImpl: sequence([toolCompletion(call('search', 'parallel_search', 'not JSON')), completion({ content: 'No search' })], (_, __, body, i) => { if (i) followup = body; }) }));
  assert.equal(result.searches.length, 1); assert.equal(result.searches[0].status, 'error'); assert.equal(followup.tool_choice, 'auto'); assert.deepEqual(followup.tools.map(tool => tool.function.name), ['prism_help']); assert.equal(followup.messages.at(-2).tool_calls[0].function.arguments, 'not JSON');
});

test('OpenAI tool failures are bounded and redacted; interrupted automatic actions are never retried', async () => {
  let followup, executed = 0;
  await generateReply(options({ notionTools, notionCall: async () => { executed++; throw new Error(`failed ${key}`); }, fetchImpl: sequence([toolCompletion(call('n1')), completion({ content: 'Failed safely' })], (_, __, body, i) => { if (i) followup = body; }) }));
  assert.equal(executed, 1); assert.match(followup.messages.at(-1).content, /outcome may be unknown/); assert.ok(!followup.messages.at(-1).content.includes(key));
  const controller = new AbortController(); executed = 0;
  await assert.rejects(generateReply(options({ signal: controller.signal, notionTools, notionCall: async () => { executed++; controller.abort(new DOMException('Stop', 'AbortError')); return { text: 'maybe done' }; }, fetchImpl: sequence([toolCompletion(call('n1'))]) })), error => error.name === 'AbortError' && error.executionOutcomeUnknown === true);
  assert.equal(executed, 1);
  const result = await generateReply(options({ notionTools, notionCall: async () => ({ text: `${key}${'"'.repeat(100000)}` }), fetchImpl: sequence([toolCompletion(call('n1')), completion()], (_, __, body, i) => { if (i) { const text = body.messages.at(-1).content; assert.ok(text.length <= 50000); assert.ok(!text.includes(key)); assert.match(text, /truncated/); } }) }));
  assert.equal(result.tools[0].status, 'complete');
});

test('Gemini history converts to deterministic valid OpenAI call IDs and name/order-matched responses without replay', async () => {
  const history = [
    { role: 'user', parts: [{ text: 'Earlier question' }] },
    { role: 'model', parts: [{ text: 'Visible' }, { thought: true, text: 'Hidden thought', thoughtSignature: 'secret-sig' }, { thoughtSignature: 'call-sig', functionCall: { name: 'notion_tool', args: { name: 'read', arguments_json: '{}' } } }, { functionCall: { name: 'notion_tool', args: { name: 'read', arguments_json: '{"page":2}' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'notion_tool', response: { text: 'First result' } } }, { functionResponse: { name: 'notion_tool', response: { text: 'Second result' } } }] },
    { role: 'model', parts: [{ text: 'Summary' }] }, { role: 'user', parts: [{ text: 'Continue' }] },
  ];
  let first;
  for (let pass = 0; pass < 2; pass++) await generateReply(options({ contents: history, notionTools, notionCall: async () => assert.fail('Saved action replayed'), fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body); assert.ok(!init.body.includes('thoughtSignature')); assert.ok(!init.body.includes('Hidden thought')); assert.ok(!init.body.includes('secret-sig'));
    const assistant = body.messages.find(message => message.tool_calls); assert.equal(assistant.content, 'Visible'); assert.deepEqual(assistant.tool_calls.map(tool => tool.id), ['prism_1_0', 'prism_1_1']);
    const responses = body.messages.filter(message => message.role === 'tool'); assert.deepEqual(responses.map(message => message.tool_call_id), ['prism_1_0', 'prism_1_1']); assert.match(responses[0].content, /First/); assert.match(responses[1].content, /Second/);
    if (first) assert.deepEqual(body, first); else first = body;
    return json(completion());
  } }));
});

test('OpenAI metadata survives canonical storage and OA continuation but never leaks into Gemini requests', async () => {
  const initial = await generateReply(options({ fetchImpl: async () => json(completion({ content: 'Visible answer', reasoning_content: 'private reasoning', reasoning_details: [{ text: 'private detail' }] })) }));
  const contents = JSON.parse(JSON.stringify([...initial.contents, { role: 'user', parts: [{ text: 'Continue' }] }]));
  await generateReply(options({ contents, fetchImpl: async (_, init) => { const assistant = JSON.parse(init.body).messages.find(message => message.role === 'assistant'); assert.equal(assistant.reasoning_content, 'private reasoning'); assert.deepEqual(assistant.reasoning_details, [{ text: 'private detail' }]); return json(completion()); } }));
  await generateReply({ endpoint: DEFAULT_ENDPOINT, key, model: 'models/gemini-flash', contents, fetchImpl: async (url, init) => {
    assert.equal(url, `${DEFAULT_ENDPOINT}/models/gemini-flash:generateContent`); assert.equal(init.headers['x-goog-api-key'], key); assert.equal(init.headers.Authorization, undefined);
    assert.ok(!init.body.includes('prismOpenAI')); assert.ok(!init.body.includes('private reasoning')); assert.ok(!init.body.includes('reasoning_details')); assert.match(init.body, /Visible answer/);
    return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Native reply' }] }, finishReason: 'STOP' }] });
  } });
  assert.equal(contents[1].prismOpenAI.reasoning_content, 'private reasoning');
});

test('duplicate generated legacy wire IDs and refusal batches never dispatch actions', async () => {
  const contents = [{ role: 'model', parts: [{ functionCall: { name: 'notion_tool', args: { name: 'read', arguments_json: '{}' } } }] }, { role: 'user', parts: [{ functionResponse: { name: 'notion_tool', response: { text: 'Saved result' } } }] }];
  await assert.rejects(generateReply(options({ contents, notionTools, notionCall: async () => assert.fail('Historical wire ID replayed'), fetchImpl: async () => json(toolCompletion(call('prism_0_0'))) })), /Duplicate.*history/);
  await assert.rejects(generateReply(options({ notionTools, notionCall: async () => assert.fail('Refused batch executed'), fetchImpl: async () => json(completion({ content: 'I cannot do that', refusal: 'Not allowed', tool_calls: [call('n1')] }, 'tool_calls')) })), /REFUSAL/);
});

test('conversion reserves genuine OpenAI IDs before allocating missing legacy IDs', async () => {
  const contents = [{ role: 'model', parts: [{ functionCall: { name: 'notion_tool', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { name: 'notion_tool', response: { text: 'Legacy result' } } }] }, { role: 'model', parts: [{ functionCall: { id: 'prism_0_0', name: 'notion_tool', args: {} } }], prismOpenAI: { toolCalls: [{ id: 'prism_0_0', arguments: '{ }' }], reasoning_content: 'Preserve' } }, { role: 'user', parts: [{ functionResponse: { id: 'prism_0_0', name: 'notion_tool', response: { text: 'OpenAI result' } } }] }];
  await generateReply(options({ contents, fetchImpl: async (_, init) => { const messages = JSON.parse(init.body).messages; const calls = messages.flatMap(message => message.tool_calls || []); assert.deepEqual(calls.map(item => item.id), ['prism_0_0_', 'prism_0_0']); assert.equal(calls[1].function.arguments, '{ }'); assert.deepEqual(messages.filter(message => message.role === 'tool').map(item => item.tool_call_id), ['prism_0_0_', 'prism_0_0']); return json(completion()); } }));
});

test('OpenAI search errors are redacted and returned through tool responses without retries', async () => {
  let searches = 0;
  const result = await generateReply(options({ searchEnabled: true, searchImpl: async () => { searches++; throw new Error(`Search failed ${key}`); }, fetchImpl: sequence([toolCompletion(call('s1', 'parallel_search', { objective: 'Facts', search_queries: ['facts'] })), completion({ content: 'Could not search' })], (_, __, body, i) => { if (i) { assert.match(body.messages.at(-1).content, /Search failed/); assert.ok(!body.messages.at(-1).content.includes(key)); } }) }));
  assert.equal(searches, 1); assert.equal(result.searches[0].status, 'error'); assert.ok(!result.searches[0].error.includes(key));
});

test('conversion handles interrupted legacy calls and orphan results without dispatching or invalid tool messages', async () => {
  const contents = [{ role: 'model', parts: [{ functionCall: { name: 'notion_tool', args: { name: 'read', arguments_json: '{}' } } }] }, { role: 'user', parts: [{ text: 'Do not repeat' }] }, { role: 'user', parts: [{ functionResponse: { name: 'old_tool', response: { text: 'Historical value' } } }] }];
  await generateReply(options({ contents, notionTools, notionCall: async () => assert.fail('Old call replayed'), fetchImpl: async (_, init) => { const messages = JSON.parse(init.body).messages; assert.match(messages.find(message => message.role === 'tool').content, /outcome may be unknown/); assert.match(messages.at(-1).content, /Historical value/); assert.equal(messages.at(-1).role, 'user'); return json(completion()); } }));
});
