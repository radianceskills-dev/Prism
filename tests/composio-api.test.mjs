import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, conversationSearchCount } from '../api.js';
import { createComposioClient } from '../composio.js';

// Every model and Worker response is local. No fetch falls back to the network.
const KEY = 'private-model-api-key';
const tools = [{ name: 'app.read', description: 'Read connected app data.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const input = { query: 'Current project', nested: { values: [1, true, null] } };
const connector = (id = 'c1', args = { name: tools[0].name, arguments_json: JSON.stringify(input) }, name = 'composio_tool') => ({ id, name, args });
const search = id => ({ id, name: 'parallel_search', args: { objective: 'Current official facts', search_queries: ['current official facts'] } });
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const unknownOutcome = /Execution outcome may be unknown.*do not retry automatically/s;

function harness(protocol, batches = [[]], extra = {}) {
  const requests = [], events = [], executed = [];
  let round = 0;
  const response = batch => protocol === 'openai'
    ? { choices: [{ message: { role: 'assistant', content: batch.length ? null : 'Finished.', ...(batch.length ? { reasoning_content: 'Opaque reasoning', tool_calls: batch.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args) } })) } : {}) }, finish_reason: batch.length ? 'tool_calls' : 'stop' }] }
    : { candidates: [{ content: { role: 'model', parts: batch.length ? batch.map(functionCall => ({ functionCall, thoughtSignature: 'opaque-signature' })) : [{ text: 'Finished.' }] }, finishReason: 'STOP' }] };
  const options = {
    endpoint: 'https://model.example.com/v1', key: KEY, model: protocol === 'openai' ? 'org/model' : 'models/gemini-flash', protocol,
    contents: [{ role: 'user', parts: [{ text: 'Inspect my connected apps.' }] }], composioTools: tools,
    composioCall: async (name, args, context) => { executed.push({ name, args, context }); return { text: 'Connected app result' }; },
    onTool: event => events.push(event),
    fetchImpl: async (url, init) => {
      assert.equal(url, protocol === 'openai' ? 'https://model.example.com/v1/chat/completions' : 'https://model.example.com/v1/models/gemini-flash:generateContent');
      requests.push(JSON.parse(init.body));
      assert.ok(round < batches.length, 'Unexpected extra model request or automatic retry');
      return json(response(batches[round++]));
    },
    ...extra,
  };
  return { options, requests, events, executed, run: () => generateReply(options) };
}
function declarations(request, protocol) { return protocol === 'openai' ? request.tools.map(tool => tool.function) : request.tools[0].functionDeclarations; }
function instructions(request, protocol) { return protocol === 'openai' ? request.messages[0].content : request.systemInstruction.parts[0].text; }
function replies(request, protocol) { return protocol === 'openai' ? request.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, response: JSON.parse(message.content) })) : request.contents.at(-1).parts.map(part => part.functionResponse); }

for (const protocol of ['gemini', 'openai']) {
  test(`${protocol}: Composio wrapper is opt-in and disabled calls never execute`, async () => {
    const normal = harness(protocol, [[]], { composioTools: [] });
    const result = await normal.run();
    assert.deepEqual(declarations(normal.requests[0], protocol).map(tool => tool.name), ['prism_help']);
    assert.doesNotMatch(instructions(normal.requests[0], protocol), /Composio MCP tools are available/);
    assert.deepEqual(result.tools, []);
    const disabled = harness(protocol, [[connector()], []], { composioTools: [], composioCall: () => assert.fail('Disabled connector executed') });
    if (protocol === 'gemini') await assert.rejects(disabled.run(), /unsupported tools/);
    else {
      const result = await disabled.run(); assert.deepEqual(result.tools, []);
      assert.match(replies(disabled.requests[1], protocol)[0].response.error, /disabled.*not executed/i);
    }
  });

  test(`${protocol}: declarations describe discovered schemas, execute automatically and preserve wire identity`, async () => {
    const controller = new AbortController();
    const h = harness(protocol, [[connector()], []], { signal: controller.signal });
    const result = await h.run();
    const declaration = declarations(h.requests[0], protocol).find(tool => tool.name === 'composio_tool');
    assert.deepEqual(declaration.parameters.properties.name.enum, ['app.read']);
    assert.equal(declaration.parameters.type, protocol === 'openai' ? 'object' : 'OBJECT');
    assert.equal(declaration.parameters.properties.arguments_json.type, protocol === 'openai' ? 'string' : 'STRING');
    assert.match(declaration.description, /connected Composio MCP tools.*automatically without a per-call approval prompt/s);
    assert.match(declaration.description, /Read connected app data.*required/s);
    assert.match(instructions(h.requests[0], protocol), /Composio.*Worker.*independently of Notion/s);
    assert.match(instructions(h.requests[0], protocol), /untrusted|Never.*retry/i);
    assert.deepEqual(h.executed.map(({ name, args }) => [name, args]), [['app.read', input]]);
    assert.deepEqual(Object.keys(h.executed[0].context), ['signal']); assert.equal(h.executed[0].context.signal, controller.signal);
    assert.deepEqual(h.events.map(event => [event.provider, event.status, event.index]), [['composio', 'running', 1], ['composio', 'complete', 1]]);
    assert.equal(result.tools[0].provider, 'composio'); assert.equal(result.tools[0].status, 'complete');
    assert.deepEqual(result.searches, []);
    assert.equal(replies(h.requests[1], protocol)[0].id, 'c1');
    assert.match(replies(h.requests[1], protocol)[0].response.text, /Connected app result/);
    if (protocol === 'gemini') assert.equal(h.requests[1].contents[1].parts[0].thoughtSignature, 'opaque-signature');
    else assert.equal(h.requests[1].messages.find(message => message.tool_calls).reasoning_content, 'Opaque reasoning');
    assert.equal(result.contents[1].parts[0].functionCall.name, 'composio_tool');
  });

  test(`${protocol}: both providers coexist with identical discovered names and isolated dispatch/audit`, async () => {
    const dispatched = [], h = harness(protocol, [[connector('c1'), connector('n1', undefined, 'notion_tool'), connector('c2')], []], {
      notionTools: tools,
      composioCall: async (name, args) => { dispatched.push(['composio', name, args]); return { text: 'Composio-only' }; },
      notionCall: async (name, args) => { dispatched.push(['notion', name, args]); return { text: 'Notion-only' }; },
    });
    const result = await h.run();
    assert.deepEqual(declarations(h.requests[0], protocol).map(tool => tool.name), ['prism_help', 'notion_tool', 'composio_tool']);
    assert.deepEqual(dispatched.map(([provider, name]) => [provider, name]), [['composio', 'app.read'], ['notion', 'app.read'], ['composio', 'app.read']]);
    assert.deepEqual(result.tools.map(entry => [entry.index, entry.provider]), [[1, 'composio'], [2, undefined], [3, 'composio']]);
    assert.equal(Object.hasOwn(result.tools[1], 'provider'), false, 'Existing Notion audit shape must remain unchanged');
    const responses = replies(h.requests[1], protocol);
    assert.deepEqual(responses.map(response => response.id), ['c1', 'n1', 'c2']);
    assert.deepEqual(responses.map(response => response.response.text), ['Composio-only', 'Notion-only', 'Composio-only']);
  });

  test(`${protocol}: provider allowlists cannot invoke tools discovered only by the other connector`, async () => {
    const h = harness(protocol, [[connector('c1', { name: 'notion-only', arguments_json: '{}' }), connector('n1', { name: 'composio-only', arguments_json: '{}' }, 'notion_tool')], []], {
      composioTools: [{ name: 'composio-only' }], notionTools: [{ name: 'notion-only' }],
      composioCall: () => assert.fail('Cross-provider action executed'), notionCall: () => assert.fail('Cross-provider action executed'),
    });
    const result = await h.run(); assert.equal(result.tools.length, 2);
    assert.ok(result.tools.every(entry => entry.status === 'error' && /only discovered, allowlisted/.test(entry.error)));
    assert.ok(h.events.every(entry => entry.status === 'error'));
  });

  test(`${protocol}: discovered names cannot collide with Parallel or wrapper dispatch`, async () => {
    for (const name of ['parallel_search', 'notion_tool', 'composio_tool']) {
      const dispatched = [], h = harness(protocol, [[connector('c1', { name, arguments_json: '{}' })], []], {
        composioTools: [{ name }], composioCall: async (...args) => { dispatched.push(args); return { text: 'MCP result' }; },
        searchImpl: () => assert.fail('Wrong search dispatch'), notionCall: () => assert.fail('Wrong Notion dispatch'),
      });
      await h.run(); assert.equal(dispatched.length, 1); assert.equal(dispatched[0][0], name);
    }
  });

  test(`${protocol}: malformed, oversized, deep and credential-bearing arguments never execute`, async () => {
    const deep = '{"x":'.repeat(34) + '0' + '}'.repeat(34);
    const invalid = [null, [], {}, { name: 'unknown', arguments_json: '{}' }, { name: 'app.read', arguments_json: '{}', token: 'untrusted' },
      ...['{bad', '[]', 'null', 'true', '42', '"text"', '{"overflow":1e400}', deep, JSON.stringify({ value: '界'.repeat(11000) }), JSON.stringify({ key: KEY }), JSON.stringify({ key: KEY }).replace('p', '\\u0070')].map(arguments_json => ({ name: 'app.read', arguments_json })),
      { name: 'app.read', arguments_json: {} }];
    for (const args of invalid) {
      const h = harness(protocol, [[connector('c1', args)], []], { composioCall: () => assert.fail('Invalid arguments executed') });
      const result = await h.run();
      assert.equal(result.tools[0].status, 'error'); assert.deepEqual(result.tools[0].arguments, {});
      assert.deepEqual(h.events.map(event => event.status), ['error']);
      assert.match(replies(h.requests[1], protocol)[0].response.error, /not executed/);
      assert.equal(JSON.stringify(h.events).includes(KEY), false);
    }
  });

  test(`${protocol}: absent connector reports nonexecution without exposing credentials`, async () => {
    const h = harness(protocol, [[connector()], []], { composioCall: undefined });
    const result = await h.run(); assert.equal(result.tools[0].status, 'error');
    assert.match(result.tools[0].error, /Composio connector is unavailable.*not executed/);
    assert.deepEqual(h.events.map(event => event.status), ['error']);
    assert.doesNotMatch(result.tools[0].error, /outcome may be unknown/);
  });

  test(`${protocol}: mixed valid and invalid connector arguments execute only allowlisted valid entries`, async () => {
    const h = harness(protocol, [[connector('valid1'), connector('bad', { name: 'unknown', arguments_json: '{}' }), connector('valid2')], []]);
    const result = await h.run(); assert.equal(h.executed.length, 2);
    assert.deepEqual(result.tools.map(entry => entry.status), ['complete', 'error', 'complete']);
    assert.deepEqual(replies(h.requests[1], protocol).map(response => response.id), ['valid1', 'bad', 'valid2']);
  });

  test(`${protocol}: unrecognized function names never fall through to Composio execution`, async () => {
    const h = harness(protocol, [[connector(), { id: 'bad', name: 'not_declared', args: {} }], []]);
    if (protocol === 'gemini') { await assert.rejects(h.run(), /unsupported tools/); assert.equal(h.executed.length, 0); }
    else {
      const result = await h.run(); assert.equal(h.executed.length, 1); assert.equal(result.tools.length, 1);
      assert.match(replies(h.requests[1], protocol)[1].response.error, /Unknown or disabled tool.*not executed/);
    }
  });

  test(`${protocol}: result bounds and API-key redaction apply without leaking output to activity`, async () => {
    const marker = 'PRIVATE_CONNECTED_APP_PAYLOAD', huge = (`"\\\n${marker}${KEY}`).repeat(8000);
    const h = harness(protocol, [[connector()], []], {
      key: ` ${KEY} `,
      composioTools: [{ ...tools[0], description: `Untrusted schema reference ${KEY}` }],
      composioCall: async () => ({ content: [{ type: 'text', text: huge }] }),
    });
    const result = await h.run(), response = replies(h.requests[1], protocol)[0].response;
    assert.ok(JSON.stringify(response).length <= 50000); assert.match(response.text, /truncated/);
    assert.equal(response.text.includes(KEY), false);
    assert.equal(declarations(h.requests[0], protocol).find(tool => tool.name === 'composio_tool').description.includes(KEY), false);
    assert.equal(JSON.stringify(h.events).includes(marker), false); assert.equal(JSON.stringify(result.tools).includes(marker), false);
  });

  test(`${protocol}: API observers and connectors cannot mutate execution inputs or audit snapshots`, async () => {
    const original = structuredClone(input), events = [];
    const h = harness(protocol, [[connector()], []], {
      onTool: event => { events.push(structuredClone(event)); event.provider = 'notion'; event.arguments.query = 'Changed by renderer'; event.arguments.nested.values.push('mutated'); throw new Error('Renderer failed'); },
      composioCall: async (name, args) => { assert.deepEqual(args, original); args.query = 'Changed by connector'; return { text: 'Done' }; },
    });
    const result = await h.run(); assert.deepEqual(input, original); assert.deepEqual(result.tools[0].arguments, original);
    assert.equal(result.tools[0].provider, 'composio'); assert.equal(result.tools[0].status, 'complete');
    assert.deepEqual(events.map(event => event.status), ['running', 'complete']);
  });

  test(`${protocol}: Composio calls do not consume the remaining Parallel search budget`, async () => {
    let searches = 0;
    const h = harness(protocol, [[connector('c1'), search('s1'), connector('c2')], [connector('c3'), search('s2')], []], {
      searchEnabled: true, searchesUsed: 19, searchImpl: async () => { searches++; return { text: 'Public evidence' }; },
    });
    const result = await h.run(); assert.equal(searches, 1); assert.equal(h.executed.length, 3);
    assert.equal(result.searches.length, 1);
    // Durable history conservatively counts both model search requests, including
    // the rejected over-budget request, but never any of the three MCP actions.
    assert.equal(conversationSearchCount({ history: result.contents }), 2);
    assert.equal(declarations(h.requests[0], protocol).some(tool => tool.name === 'parallel_search'), true);
    assert.equal(declarations(h.requests[1], protocol).some(tool => tool.name === 'parallel_search'), false);
    assert.equal(declarations(h.requests[2], protocol).some(tool => tool.name === 'composio_tool'), true);
    assert.match(replies(h.requests[2], protocol).at(-1).response.error, /Search limit reached|disabled/);
  });

  test(`${protocol}: Composio continues beyond six and twenty calls with no stated or enforced call-count cap`, async () => {
    const h = harness(protocol, [...Array.from({ length: 25 }, (_, index) => [connector(`c${index}`)]), []], {
      searchEnabled: true, searchesUsed: 20, searchImpl: () => assert.fail('Exhausted search executed'),
    });
    const result = await h.run(); assert.equal(h.executed.length, 25); assert.equal(result.tools.length, 25);
    assert.deepEqual(result.tools.map(tool => tool.index), Array.from({ length: 25 }, (_, index) => index + 1));
    for (const request of h.requests) {
      assert.deepEqual(declarations(request, protocol).map(tool => tool.name), ['prism_help', 'composio_tool']);
      assert.equal(protocol === 'openai' ? request.tool_choice : request.toolConfig.functionCallingConfig.mode, protocol === 'openai' ? 'auto' : 'AUTO');
      assert.match(instructions(request, protocol), /no per-turn or (?:per-)?conversation call-count (?:cap|limit)|without a per-turn or per-conversation call-count limit/);
    }
  });

  test(`${protocol}: large mixed provider batches are not confused with the twenty-search bound`, async () => {
    let notionActions = 0;
    const batch = Array.from({ length: 40 }, (_, index) => connector(`action_${index}`, undefined, index % 2 ? 'notion_tool' : 'composio_tool'));
    const h = harness(protocol, [batch, []], { notionTools: tools, notionCall: async () => { notionActions++; return { text: 'Notion result' }; } });
    const result = await h.run(); assert.equal(h.executed.length, 20); assert.equal(notionActions, 20);
    assert.equal(result.tools.length, 40); assert.equal(replies(h.requests[1], protocol).length, 40);
    assert.deepEqual(result.searches, []);
  });

  test(`${protocol}: connector failures are not retried and disclose unknown outcome with redacted diagnostics`, async () => {
    for (const status of [401, 404, 500]) {
      let actions = 0;
      const h = harness(protocol, [[connector()], []], { composioCall: async () => { actions++; throw Object.assign(new Error(`HTTP ${status} interrupted ${KEY}`), { status }); } });
      const result = await h.run(); assert.equal(actions, 1); assert.equal(h.requests.length, 2);
      assert.equal(result.tools[0].status, 'error'); assert.match(result.tools[0].error, unknownOutcome);
      assert.equal(result.tools[0].error.includes(KEY), false); assert.match(replies(h.requests[1], protocol)[0].response.error, unknownOutcome);
      assert.deepEqual(h.events.map(event => event.status), ['running', 'error']);
    }
  });

  test(`${protocol}: MCP isError results retain content but mark audit errors and unknown outcomes`, async () => {
    let actions = 0;
    const h = harness(protocol, [[connector()], []], { composioCall: async () => { actions++; return { isError: true, content: [{ type: 'text', text: 'App rejected operation' }] }; } });
    const result = await h.run(); assert.equal(actions, 1); assert.equal(result.tools[0].status, 'error');
    assert.match(result.tools[0].error, /Composio reported a tool error/); assert.match(result.tools[0].error, unknownOutcome);
    assert.match(replies(h.requests[1], protocol)[0].response.text, /App rejected operation/);
  });

  test(`${protocol}: cancellation before dispatch never performs the action and has known nonexecution`, async () => {
    const before = new AbortController(); before.abort();
    const cancelled = harness(protocol, [[connector()]], { signal: before.signal, composioCall: () => assert.fail('Cancelled action executed') });
    await assert.rejects(cancelled.run(), { name: 'AbortError' }); assert.equal(cancelled.requests.length, 0);
    const controller = new AbortController(), events = [];
    const h = harness(protocol, [[connector()]], {
      signal: controller.signal, onTool: event => { events.push(event); if (event.status === 'running') controller.abort(); },
      composioCall: () => assert.fail('Cancelled-before-dispatch action executed'),
    });
    await assert.rejects(h.run(), error => error.name === 'AbortError' && error.executionOutcomeUnknown === false && /not executed/.test(error.message));
    assert.deepEqual(events.map(event => event.status), ['running', 'error']); assert.equal(h.requests.length, 1);
  });

  test(`${protocol}: cancellation and deadlines during an uncooperative action stop generation without replay`, async () => {
    for (const timeout of [false, true]) {
      const controller = new AbortController(), events = []; let actions = 0;
      const h = harness(protocol, [[connector()]], {
        signal: controller.signal, onTool: event => events.push(event),
        composioCall: () => { actions++; queueMicrotask(() => controller.abort(new DOMException('Interrupted', timeout ? 'TimeoutError' : 'AbortError'))); return new Promise(() => {}); },
      });
      await assert.rejects(h.run(), error => error.name === (timeout ? 'TimeoutError' : 'AbortError') && error.executionOutcomeUnknown === true && unknownOutcome.test(error.message));
      assert.equal(actions, 1); assert.equal(h.requests.length, 1); assert.deepEqual(events.map(event => event.status), ['running', 'error']);
      assert.equal(events.at(-1).provider, 'composio'); assert.match(events.at(-1).error, unknownOutcome);
    }
  });

  test(`${protocol}: connector-originated timeout is an interrupted unknown outcome, never a generation retry`, async () => {
    const h = harness(protocol, [[connector()]], { composioCall: async () => { throw new DOMException('Worker timed out', 'TimeoutError'); } });
    await assert.rejects(h.run(), error => error.name === 'TimeoutError' && error.executionOutcomeUnknown === true && unknownOutcome.test(error.message));
    assert.equal(h.requests.length, 1); assert.deepEqual(h.events.map(event => event.status), ['running', 'error']);
  });

  test(`${protocol}: browser client redacts its bearer/refresh/client credentials before API history receives results`, async () => {
    const worker = 'https://worker.example.com', access = 'worker-private-access', refresh = 'worker-private-refresh', clientId = 'worker-public-registration';
    const localData = new Map([
      ['prism.composio.worker.client', JSON.stringify({ workerURL: worker, clientId, redirectUri: 'https://prism.example.com/' })],
      ['prism.composio.worker.tokens', JSON.stringify({ workerURL: worker, accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3600000 })],
    ]);
    const store = data => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) });
    const methods = [];
    const client = createComposioClient(worker, {
      localStorage: store(localData), sessionStorage: store(new Map()), location: { href: 'https://prism.example.com/' },
      fetchImpl: async (url, init) => {
        assert.equal(url, `${worker}/mcp`); assert.equal(init.headers.Authorization, `Bearer ${access}`);
        assert.equal(JSON.stringify(init).includes(KEY), false);
        const body = JSON.parse(init.body); methods.push(body.method);
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {} }
          : body.method === 'tools/list' ? { tools }
            : { content: [{ type: 'text', text: `${access} ${refresh} ${clientId}` }] };
        return json({ jsonrpc: '2.0', id: body.id, result });
      },
    });
    const discovered = await client.listTools();
    const h = harness(protocol, [[connector()], []], { composioTools: discovered, composioCall: (...args) => client.callTool(...args) });
    const result = await h.run();
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    const history = JSON.stringify(result.contents); for (const secret of [access, refresh, clientId]) assert.equal(history.includes(secret), false);
    assert.match(replies(h.requests[1], protocol)[0].response.text, /REDACTED/);
    assert.equal(JSON.stringify(result.tools).includes('REDACTED'), false, 'Activity must not retain even the scrubbed result payload');
  });
}

test('OpenAI malformed wire batch rejects all calls before any external action', async () => {
  for (const variant of ['duplicate', 'missing-id', 'bad-arguments-type']) {
    let actions = 0;
    const good = { id: 'valid', type: 'function', function: { name: 'composio_tool', arguments: JSON.stringify(connector().args) } };
    const bad = structuredClone(good);
    if (variant === 'missing-id') delete bad.id;
    else if (variant === 'bad-arguments-type') { bad.id = 'second'; bad.function.arguments = {}; }
    const h = harness('openai', [], { composioCall: async () => { actions++; }, fetchImpl: async () => json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [good, bad] }, finish_reason: 'tool_calls' }] }) });
    await assert.rejects(h.run(), /Invalid or duplicate OpenAI tool call IDs or structure/); assert.equal(actions, 0);
  }
});
