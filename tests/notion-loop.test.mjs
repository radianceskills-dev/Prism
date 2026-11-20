import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReply } from '../api.js';

const base = { endpoint: 'https://example.com/v1beta', key: 'gemini-private-key', model: 'models/gemini-flash', contents: [{ role: 'user', parts: [{ text: 'Inspect my Notion workspace' }] }] };
const discovered = [{ name: 'notion-search', description: 'Search Notion workspace pages.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const args = { query: 'Find project pages', nested: { values: [1, true, null] } };
const wrapped = (extra = {}) => ({ name: 'notion_tool', args: { name: discovered[0].name, arguments_json: JSON.stringify(args) }, id: 'external-1', ...extra });
const search = { name: 'parallel_search', args: { objective: 'Find Node.js documentation', search_queries: ['Node.js docs'] }, id: 'search-1' };
const toolReply = (...calls) => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'Reasoning retained', thought: true }, ...calls.map(functionCall => ({ functionCall, thoughtSignature: 'keep-this-signature' }))] } }] });
const answer = { candidates: [{ content: { role: 'model', parts: [{ text: 'Finished.' }] }, finishReason: 'STOP' }] };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function sequence(replies, requests = []) {
  return async (_, request) => {
    requests.push(JSON.parse(request.body));
    assert.ok(replies.length, 'Unexpected automatic retry/model request');
    return json(replies.shift());
  };
}
function options(extra = {}) {
  return { ...base, notionTools: discovered, notionCall: async () => ({ content: [{ type: 'text', text: 'Notion page result' }] }), fetchImpl: sequence([toolReply(wrapped()), answer]), ...extra };
}

test('Notion wrapper is opt-in and is absent with no discovered tools', async () => {
  const requests = [];
  const result = await generateReply({ ...base, fetchImpl: sequence([answer], requests) });
  assert.deepEqual(requests[0].tools[0].functionDeclarations.map(tool => tool.name), ['prism_help']);
  assert.equal(requests[0].toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.match(requests[0].systemInstruction.parts[0].text, /Prism can render interactive HTML artefacts/);
  assert.doesNotMatch(requests[0].systemInstruction.parts[0].text, /Notion tools are available|user has enabled Notion/);
  assert.deepEqual(result.tools, []);
  await assert.rejects(generateReply({ ...base, notionCall: async () => assert.fail('Disabled Notion action executed'), fetchImpl: sequence([toolReply(wrapped())]) }), /unsupported tools/);
});

test('wrapper describes discovered schemas, runs automatically, and history preserves IDs/signatures', async () => {
  const requests = [], events = [], executionOrder = [];
  const initial = toolReply(wrapped());
  const original = structuredClone(initial.candidates[0].content);
  const controller = new AbortController();
  const result = await generateReply(options({ signal: controller.signal, fetchImpl: sequence([initial, answer], requests),
    notionCall: async (name, input, context) => {
      executionOrder.push('execute');
      assert.equal(name, discovered[0].name);
      assert.deepEqual(input, args);
      assert.deepEqual(Object.keys(context), ['signal']);
      assert.equal(context.signal, controller.signal);
      return { content: [{ type: 'text', text: 'private-result-not-for-activity' }] };
    }, onTool: event => events.push(event),
  }));
  const declaration = requests[0].tools[0].functionDeclarations.find(tool => tool.name === 'notion_tool');
  assert.equal(declaration.name, 'notion_tool');
  assert.deepEqual(declaration.parameters.properties.name.enum, [discovered[0].name]);
  assert.equal(declaration.parameters.properties.arguments_json.type, 'STRING');
  assert.match(declaration.description, /Search Notion workspace pages/);
  assert.match(declaration.description, /required/);
  assert.match(requests[0].systemInstruction.parts[0].text, /untrusted data/);
  assert.match(requests[0].systemInstruction.parts[0].text, /authorization links/);
  assert.deepEqual(executionOrder, ['execute']);
  assert.deepEqual(events.map(event => event.status), ['running', 'complete']);
  assert.match(declaration.description, /automatically without a per-call approval prompt/);
  assert.match(requests[0].systemInstruction.parts[0].text, /valid calls run automatically/);
  assert.ok(events.every(event => event.index === 1 && event.name === discovered[0].name));
  assert.ok(!JSON.stringify(events).includes('private-result-not-for-activity'));
  assert.ok(!JSON.stringify(result.tools).includes('private-result-not-for-activity'));
  assert.deepEqual(requests[1].contents[1], original);
  assert.equal(requests[1].contents[2].parts[0].functionResponse.id, 'external-1');
  assert.equal(requests[1].contents[2].parts[0].functionResponse.name, 'notion_tool');
  assert.match(requests[1].contents[2].parts[0].functionResponse.response.text, /private-result-not-for-activity/);
  assert.deepEqual(result.contents[1], original);
  assert.equal(result.tools[0].status, 'complete');
  assert.deepEqual(result.searches, []);
});

test('activity callback mutation cannot change execution arguments', async () => {
  const original = structuredClone(args);
  await generateReply(options({
    onTool: event => { event.name = 'DELETE_EVERYTHING'; event.arguments.query = 'changed by render'; event.arguments.nested = {}; },
    notionCall: async (name, input) => { assert.equal(name, discovered[0].name); assert.deepEqual(input, original); input.query = 'changed by connector'; return { text: 'Done' }; },
  }));
  assert.deepEqual(args, original);
});

test('activity observer errors cannot fail or repeat a completed external action', async () => {
  let executions = 0;
  const result = await generateReply(options({ onTool: () => { throw new Error('Render failure'); }, notionCall: async () => { executions++; return { text: 'Done' }; } }));
  assert.equal(executions, 1);
  assert.equal(result.tools[0].status, 'complete');
});

test('enabled tools execute without an approval callback', async () => {
  const events = [];
  let executions = 0;
  const result = await generateReply(options({
    notionCall: async () => { executions++; return { text: 'Done' }; },
    onTool: event => events.push(event.status),
  }));
  assert.equal(executions, 1);
  assert.deepEqual(events, ['running', 'complete']);
  assert.equal(result.tools[0].status, 'complete');
});

test('absent connector never executes or reveals Gemini key', async () => {
  for (const overrides of [{ notionCall: undefined }]) {
    const requests = [];
    const result = await generateReply(options({ ...overrides, fetchImpl: sequence([toolReply(wrapped()), answer], requests) }));
    assert.equal(result.tools[0].status, 'error');
    assert.match(result.tools[0].error, /not executed/);
    assert.ok(!JSON.stringify(result.tools).includes(base.key));
    assert.ok(!JSON.stringify(requests[1].contents.at(-1)).includes(base.key));
  }
});

test('malformed, unknown, oversized, too-deep and credential-bearing arguments cannot execute', async () => {
  const deep = '{"x":'.repeat(34) + '0' + '}'.repeat(34);
  const wrappers = [
    null, [], {},
    { name: 'NOT_DISCOVERED', arguments_json: '{}' },
    { name: discovered[0].name, arguments_json: '{}', authorization: 'untrusted' },
    ...['{bad', '[]', 'null', 'true', '42', '"text"', '{"overflow":1e400}', deep, JSON.stringify({ value: 'x'.repeat(30000) }), JSON.stringify({ value: '界'.repeat(11000) }), JSON.stringify({ key: base.key }), JSON.stringify({ key: base.key }).replace('g', '\\u0067')].map(arguments_json => ({ name: discovered[0].name, arguments_json })),
    { name: discovered[0].name, arguments_json: {} },
  ];
  for (const invalid of wrappers) {
    const events = [], requests = [];
    const result = await generateReply(options({ fetchImpl: sequence([toolReply(wrapped({ args: invalid })), answer], requests),
      notionCall: async () => assert.fail('Invalid arguments executed'), onTool: event => events.push(event),
    }));
    assert.equal(result.tools[0].status, 'error');
    assert.deepEqual(result.tools[0].arguments, {});
    assert.deepEqual(events.map(event => event.status), ['error']);
    assert.ok(requests[1].contents.at(-1).parts[0].functionResponse.response.error);
    assert.ok(!JSON.stringify(events).includes(base.key));
  }
});

test('unrecognized Gemini function names and search-off requests reject entire batch before actions', async () => {
  for (const extra of [{ name: discovered[0].name, args }, { name: 'evil', args: {} }, search]) {
    await assert.rejects(generateReply(options({ fetchImpl: sequence([toolReply(wrapped(), extra)]), notionCall: async () => assert.fail('Unsupported batch executed') })), /unsupported tools/);
  }
});

test('discovered names cannot collide with wrapper or Parallel dispatch', async () => {
  const calls = [];
  await generateReply(options({ notionTools: [{ name: 'parallel_search', inputSchema: { type: 'object' } }],
    fetchImpl: sequence([toolReply(wrapped({ args: { name: 'parallel_search', arguments_json: '{}' } })), answer]),
    searchImpl: async () => assert.fail('Wrong tool dispatch'), notionCall: async (name, input) => { calls.push([name, input]); return { text: 'MCP-specific tool' }; },
  }));
  assert.deepEqual(calls, [['parallel_search', {}]]);
});

test('tool metadata is bounded and invalid names are excluded', async () => {
  const requests = [];
  const oversized = Array.from({ length: 80 }, (_, i) => ({ name: 'TOOL_' + i, description: 'd'.repeat(5000), inputSchema: { example: 's'.repeat(6000) } }));
  oversized.unshift({ name: '<script>alert(1)</script>' }, { name: 'x'.repeat(200) });
  let executed;
  await generateReply(options({ notionTools: oversized,
    fetchImpl: sequence([toolReply(wrapped({ args: { name: 'TOOL_79', arguments_json: '{}' } })), answer], requests),
    notionCall: async name => { executed = name; return { text: 'Done' }; },
  }));
  assert.equal(executed, 'TOOL_79');
  const declaration = requests[0].tools[0].functionDeclarations.find(tool => tool.name === 'notion_tool');
  assert.equal(declaration.parameters.properties.name.enum.length, 80);
  assert.ok(declaration.description.length < 25000);
  assert.ok(!declaration.parameters.properties.name.enum.some(name => name.includes('<')));
});

test('Notion result and Parallel result stay within 50K serialized characters, with no raw result activity', async () => {
  for (const useSearch of [false, true]) {
    const requests = [], events = [];
    const huge = ('"\\\n' + base.key).repeat(12000);
    const result = await generateReply(options({ searchEnabled: useSearch,
      fetchImpl: sequence([toolReply(useSearch ? search : wrapped()), answer], requests),
      notionCall: async () => ({ content: [{ type: 'text', text: huge }] }), searchImpl: async () => ({ text: huge }), onTool: event => events.push(event),
    }));
    const response = requests[1].contents.at(-1).parts[0].functionResponse.response;
    assert.ok(JSON.stringify(response).length <= 50000);
    assert.match(response.text, /truncated/);
    assert.ok(!response.text.includes(base.key));
    assert.ok(!JSON.stringify(events).includes('truncated'));
    assert.equal(useSearch ? result.searches[0].status : result.tools[0].status, 'complete');
  }
});

test('tool errors disclose unknown outcome and are not automatically retried', async () => {
  const requests = [];
  let executions = 0;
  const result = await generateReply(options({ fetchImpl: sequence([toolReply(wrapped()), answer], requests), notionCall: async () => { executions++; throw new Error(`Network interrupted ${base.key}`); } }));
  assert.equal(executions, 1);
  assert.equal(result.tools[0].status, 'error');
  assert.match(result.tools[0].error, /outcome may be unknown/);
  assert.match(result.tools[0].error, /do not retry automatically/);
  assert.ok(!result.tools[0].error.includes(base.key));
  assert.match(requests[1].contents.at(-1).parts[0].functionResponse.response.error, /outcome may be unknown/);
});

test('MCP isError results become visible tool errors without retrying', async () => {
  const result = await generateReply(options({ notionCall: async () => ({ isError: true, content: [{ type: 'text', text: 'App rejected the operation' }] }) }));
  assert.equal(result.tools[0].status, 'error');
  assert.match(result.tools[0].error, /Notion reported a tool error/);
});

test('already cancelled turn never executes a Notion action', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateReply(options({ signal: controller.signal,
    fetchImpl: async () => assert.fail('Cancelled turn requested a model response'),
    notionCall: async () => assert.fail('Cancelled turn executed a tool'),
  })), { name: 'AbortError' });
});

test('abort immediately before execution never performs the action', async () => {
  const controller = new AbortController();
  await assert.rejects(generateReply(options({ signal: controller.signal, fetchImpl: sequence([toolReply(wrapped())]),
    onTool: event => { if (event.status === 'running') controller.abort(); },
    notionCall: async () => assert.fail('Cancelled-before-start tool executed'),
  })), error => error.name === 'AbortError' && error.executionOutcomeUnknown === false);
});

test('abort or timeout during execution reports unknown outcome and never continues generation', async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController(), events = [];
    let executions = 0;
    await assert.rejects(generateReply(options({ signal: controller.signal, fetchImpl: sequence([toolReply(wrapped())]),
      notionCall: () => { executions++; queueMicrotask(() => controller.abort(timeout ? new DOMException('Time expired', 'TimeoutError') : undefined)); return new Promise(() => {}); },
      onTool: event => events.push(event),
    })), error => error.name === (timeout ? 'TimeoutError' : 'AbortError') && error.executionOutcomeUnknown === true && /outcome may be unknown/.test(error.message));
    assert.equal(executions, 1);
    assert.deepEqual(events.map(event => event.status), ['running', 'error']);
    assert.match(events.at(-1).error, /outcome may be unknown/);
  }
});

test('Notion continues beyond six calls and the Parallel budget without approval prompts', async () => {
  const requests = [];
  let executions = 0;
  const result = await generateReply(options({ searchEnabled: true, searchesUsed: 20,
    fetchImpl: sequence([...Array.from({ length: 25 }, () => toolReply(wrapped())), answer], requests),
    notionCall: async () => { executions++; return { text: 'Done' }; },
    searchImpl: async () => assert.fail('Exhausted Parallel search executed'),
  }));
  assert.equal(executions, 25);
  assert.equal(result.tools.length, 25);
  assert.deepEqual(result.tools.map(tool => tool.index), Array.from({ length: 25 }, (_, index) => index + 1));
  for (const request of requests) {
    assert.equal(request.toolConfig.functionCallingConfig.mode, 'AUTO');
    assert.deepEqual(request.tools[0].functionDeclarations.map(tool => tool.name), ['prism_help', 'notion_tool']);
    assert.match(request.systemInstruction.parts[0].text, /without a per-turn or per-conversation call-count limit/);
  }
});

test('large Notion batches have no call-count cap and run without user interaction', async () => {
  const requests = [];
  let executions = 0;
  const result = await generateReply(options({
    fetchImpl: sequence([toolReply(...Array.from({ length: 32 }, (_, index) => wrapped({ id: `call-${index}` }))), answer], requests),
    notionCall: async () => { executions++; return { text: 'Done' }; },
  }));
  assert.equal(executions, 32);
  assert.equal(result.tools.length, 32);
  assert.equal(requests[1].contents.at(-1).parts.length, 32);
  assert.equal(requests[1].toolConfig.functionCallingConfig.mode, 'AUTO');
});

test('an invalid call does not prevent the next valid automatic call', async () => {
  const requests = [];
  let executions = 0;
  const result = await generateReply(options({
    fetchImpl: sequence([toolReply(wrapped({ args: { name: 'UNKNOWN', arguments_json: '{}' } })), toolReply(wrapped()), answer], requests),
    notionCall: async () => { executions++; return { text: 'Done' }; },
  }));
  assert.deepEqual(result.tools.map(tool => tool.status), ['error', 'complete']);
  assert.equal(executions, 1);
  assert.equal(requests[2].toolConfig.functionCallingConfig.mode, 'AUTO');
});

test('Stop still cancels a long Notion loop without an automatic retry', async () => {
  const controller = new AbortController();
  let requests = 0, executions = 0, started = 0;
  await assert.rejects(generateReply(options({ signal: controller.signal,
    fetchImpl: async () => { requests++; return json(toolReply(wrapped())); },
    onTool: event => { if (event.status === 'running' && ++started === 26) controller.abort(); },
    notionCall: async () => { executions++; return { text: 'Done' }; },
  })), { name: 'AbortError' });
  assert.equal(requests, 26);
  assert.equal(started, 26);
  assert.equal(executions, 25);
});

test('exhausted conversation search budget does not disable Notion tools', async () => {
  const requests = [];
  let executions = 0;
  await generateReply(options({ searchEnabled: true, searchesUsed: 20,
    fetchImpl: sequence([toolReply(wrapped()), answer], requests),
    searchImpl: async () => assert.fail('Exhausted public-web search executed'),
    notionCall: async () => { executions++; return { text: 'Workspace result' }; },
  }));
  assert.equal(executions, 1);
  assert.deepEqual(requests[0].tools[0].functionDeclarations.map(tool => tool.name), ['prism_help', 'notion_tool']);
});

test('mixed loop keeps Notion available when the Parallel budget is exhausted, with responses in order', async () => {
  const requests = [];
  let searches = 0, executions = 0;
  const result = await generateReply(options({ searchEnabled: true, searchesUsed: 17,
    fetchImpl: sequence([toolReply(search, wrapped()), toolReply(search, wrapped()), toolReply(search, wrapped()), toolReply(wrapped(), wrapped(), wrapped()), answer], requests),
    searchImpl: async () => { searches++; return { text: 'Public search result' }; },
    notionCall: async () => { executions++; return { text: 'Connected account result' }; },
  }));
  assert.equal(searches, 3);
  assert.equal(executions, 6);
  assert.equal(result.searches.length, 3);
  assert.equal(result.tools.length, 6);
  assert.deepEqual(requests[0].tools[0].functionDeclarations.map(tool => tool.name), ['prism_help', 'parallel_search', 'notion_tool']);
  assert.deepEqual(requests[3].tools[0].functionDeclarations.map(tool => tool.name), ['prism_help', 'notion_tool']);
  assert.equal(requests[4].toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.deepEqual(requests[4].tools[0].functionDeclarations.map(tool => tool.name), ['prism_help', 'notion_tool']);
  assert.deepEqual(requests[1].contents.at(-1).parts.map(part => part.functionResponse.name), ['parallel_search', 'notion_tool']);
});

test('mixed batches enforce the Parallel budget without imposing a Notion count limit', async () => {
  let searches = 0, executions = 0;
  const requests = [];
  await generateReply(options({ searchEnabled: true, searchesUsed: 17, fetchImpl: sequence([toolReply(...Array.from({ length: 4 }, () => search), ...Array.from({ length: 30 }, () => wrapped())), answer], requests),
    searchImpl: async () => { searches++; return { text: 'Public result' }; }, notionCall: async () => { executions++; return { text: 'Done' }; },
  }));
  assert.equal(searches, 3);
  assert.equal(executions, 30);
  assert.match(requests[1].contents.at(-1).parts[3].functionResponse.response.error, /Search limit reached/);
});
