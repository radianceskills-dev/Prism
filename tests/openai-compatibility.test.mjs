import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReply } from '../api.js';

const endpoint = 'https://compatible.example/v1', key = 'compatibility-secret-key', model = 'compatible-model';
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const completion = (message, finish_reason = 'stop') => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] });
const options = extra => ({ endpoint, key, model, protocol: 'openai', contents: [{ role: 'user', parts: [{ text: 'Question' }] }], ...extra });
const notionTools = [{ name: 'read', description: 'Read a page', inputSchema: { type: 'object' } }];
const call = (id, page = 'page-1') => ({ id, type: 'function', function: { name: 'notion_tool', arguments: JSON.stringify({ name: 'read', arguments_json: JSON.stringify({ page }) }) } });
const toolCompletion = (...calls) => completion({ content: null, tool_calls: calls }, 'tool_calls');
const absenceCases = [
  ['omitted', {}],
  ['null', { tool_calls: null }],
  ['empty array', { tool_calls: [] }],
];

function sequence(responses, bodies = []) {
  let count = 0;
  return {
    get count() { return count; },
    fetchImpl: async (url, init) => {
      assert.equal(url, `${endpoint}/chat/completions`);
      assert.equal(init.method, 'POST');
      assert.ok(count < responses.length, 'Unexpected retry or additional completion request');
      bodies.push(JSON.parse(init.body));
      return json(responses[count++]);
    },
  };
}

function toolProbe(enabled = true) {
  const executions = [], searches = [], activities = [];
  return {
    executions, searches, activities,
    settings: {
      searchEnabled: enabled,
      notionTools: enabled ? notionTools : [],
      notionCall: async (name, args) => { executions.push([name, args]); return { text: 'Read page result' }; },
      searchImpl: async args => { searches.push(args); return { text: 'Search result' }; },
      onTool: event => activities.push(event),
    },
  };
}

function assertNoExecution(probe) {
  assert.deepEqual(probe.executions, []);
  assert.deepEqual(probe.searches, []);
  assert.deepEqual(probe.activities, []);
}

function assertBatchError(error, { type, empty = false, privateValues = [] } = {}) {
  assert.match(error.message, /^Invalid OpenAI tool call batch\./);
  assert.match(error.message, /tool_calls/);
  assert.match(error.message, /No tools from this batch were executed\./);
  assert.doesNotMatch(error.message, /No tools were executed\./);
  if (type) {
    assert.match(error.message, new RegExp(`\\b${type}\\b`, 'i'));
    assert.match(error.message, /array/i);
  }
  if (empty) {
    assert.match(error.message, /finish_reason/);
    assert.match(error.message, /(?:no|zero) (?:tool )?calls|without (?:any )?(?:tool )?calls|empty/i);
  }
  for (const value of [key, ...privateValues]) assert.ok(!error.message.includes(value), 'Provider response values must not appear in diagnostics');
  return true;
}

test('OpenAI-compatible final text accepts explicit tool_calls:null', async () => {
  const result = await generateReply(options({ fetchImpl: async () => json(completion({ content: 'Compatible final answer', tool_calls: null })) }));
  assert.equal(result.text, 'Compatible final answer');
});

for (const enabled of [false, true]) for (const [label, property] of absenceCases) {
  test(`OpenAI-compatible ${label} tool_calls is an ordinary final response with tools ${enabled ? 'both enabled' : 'disabled'}`, async () => {
    const probe = toolProbe(enabled), bodies = [];
    const mocked = sequence([completion({ content: 'No tools needed', ...property })], bodies);
    const contents = [{ role: 'user', parts: [{ text: 'Question' }] }], snapshot = structuredClone(contents);
    const result = await generateReply(options({ contents, ...probe.settings, fetchImpl: mocked.fetchImpl }));
    assert.equal(mocked.count, 1);
    assert.equal(result.text, 'No tools needed');
    assert.equal(result.warning, '');
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.searches, []);
    assertNoExecution(probe);
    assert.deepEqual(contents, snapshot);
    assert.deepEqual(result.contents.map(item => item.role), ['user', 'model']);
    assert.deepEqual(result.contents.at(-1).parts, [{ text: 'No tools needed' }]);
    assert.equal(result.contents.at(-1).prismOpenAI?.toolCalls, undefined);
    assert.deepEqual(bodies[0].tools.map(tool => tool.function.name), enabled ? ['prism_help', 'parallel_search', 'notion_tool'] : ['prism_help']);
    assert.equal(bodies[0].tool_choice, 'auto');
  });
}

test('a valid Notion round followed by tool_calls:null preserves wire IDs, results and history without retry', async () => {
  const probe = toolProbe(), bodies = [];
  const first = call('notion-read-1');
  const mocked = sequence([toolCompletion(first), completion({ content: 'Final summary', tool_calls: null })], bodies);
  const result = await generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl }));
  assert.equal(mocked.count, 2);
  assert.deepEqual(probe.executions, [['read', { page: 'page-1' }]]);
  assert.deepEqual(probe.searches, []);
  assert.deepEqual(probe.activities.map(event => event.status), ['running', 'complete']);
  assert.equal(result.text, 'Final summary');
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].status, 'complete');
  assert.deepEqual(result.contents.map(item => item.role), ['user', 'model', 'user', 'model']);
  assert.equal(result.contents[1].parts[0].functionCall.id, first.id);
  assert.equal(result.contents[2].parts[0].functionResponse.id, first.id);
  assert.deepEqual(result.contents[1].prismOpenAI.toolCalls, [{ id: first.id, arguments: first.function.arguments }]);
  const assistant = bodies[1].messages.find(message => message.tool_calls);
  assert.deepEqual(assistant.tool_calls, [first]);
  const response = bodies[1].messages.at(-1);
  assert.equal(response.role, 'tool');
  assert.equal(response.tool_call_id, first.id);
  assert.deepEqual(JSON.parse(response.content), { text: 'Read page result' });
  assert.deepEqual(result.contents.at(-1).parts, [{ text: 'Final summary' }]);
});

for (const scenario of [
  { name: 'stop', content: 'Complete answer', finish: 'stop', text: 'Complete answer', warning: '' },
  { name: 'length with partial content', content: 'Partial answer', finish: 'length', text: 'Partial answer', warning: /output limit/ },
  { name: 'filtered partial content', content: 'Safe partial', finish: 'content_filter', text: 'Safe partial', warning: /SAFETY/ },
  { name: 'refusal without content', content: null, refusal: 'Private refusal reason', finish: 'stop', error: /blocked.*REFUSAL/ },
  { name: 'refusal alongside visible text', content: 'Visible answer', refusal: 'Private refusal reason', finish: 'stop', text: 'Visible answer', warning: '' },
  { name: 'null content at stop', content: null, finish: 'stop', error: /no text \(STOP\)/ },
  { name: 'empty string content', content: '', finish: 'stop', error: /no text \(STOP\)/ },
  { name: 'empty array content', content: [], finish: 'stop', error: /no text \(STOP\)/ },
  { name: 'length without content', content: null, finish: 'length', error: /no text \(MAX_TOKENS\)/ },
]) {
  test(`tool_calls:null preserves existing ${scenario.name} behavior`, async () => {
    const probe = toolProbe();
    const message = { content: scenario.content, tool_calls: null, ...(scenario.refusal ? { refusal: scenario.refusal } : {}) };
    const mocked = sequence([completion(message, scenario.finish)]);
    const promise = generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl }));
    if (scenario.error) {
      await assert.rejects(promise, error => {
        assert.match(error.message, scenario.error);
        assert.doesNotMatch(error.message, /Invalid OpenAI tool call batch/);
        assert.ok(!error.message.includes('Private refusal reason'));
        return true;
      });
    } else {
      const result = await promise;
      assert.equal(result.text, scenario.text);
      if (typeof scenario.warning === 'string') assert.equal(result.warning, scenario.warning);
      else assert.match(result.warning, scenario.warning);
    }
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  });
}

for (const [label, property] of absenceCases) {
  test(`finish_reason:tool_calls rejects ${label} calls without dispatching or hiding its contradictory finish reason`, async () => {
    const probe = toolProbe();
    const mocked = sequence([completion({ content: 'This is not a completed tool request', ...property }, 'tool_calls')]);
    await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), error => assertBatchError(error, { empty: true }));
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  });
}

const privateID = 'PRIVATE_CALL_ID_37', privateArgs = 'PRIVATE_TOOL_ARGUMENT_41', privateBody = 'PRIVATE_RESPONSE_BODY_43';
for (const enabled of [false, true]) for (const [label, value, type] of [
  ['false', false, 'boolean'],
  ['zero', 0, 'number'],
  ['string', JSON.stringify([call(privateID, `${privateArgs}-${key}`)]), 'string'],
  ['object', { ...call(privateID, `${privateArgs}-${key}`), provider_private: privateBody }, 'object'],
]) {
  test(`nonarray tool_calls ${label} rejects safely with tools ${enabled ? 'both enabled' : 'disabled'}`, async () => {
    const probe = toolProbe(enabled);
    const mocked = sequence([completion({ content: `${privateBody}-${key}`, tool_calls: value })]);
    await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), error => assertBatchError(error, { type, privateValues: [privateID, privateArgs, privateBody] }));
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  });
}

test('valid calls earlier in a malformed initial array never dispatch before complete batch validation', async () => {
  const first = call('valid-first');
  for (const malformed of [null, { ...call('invalid-type'), type: 'unknown' }, { ...call('invalid-args'), function: { name: 'notion_tool', arguments: { privateArgs, key } } }, call('valid-first')]) {
    const probe = toolProbe();
    const mocked = sequence([toolCompletion(first, malformed)]);
    await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), error => {
      assert.match(error.message, /Invalid|duplicate/);
      for (const value of [key, privateArgs, first.id]) assert.ok(!error.message.includes(value));
      return true;
    });
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  }
});

for (const [label, invalid] of [
  ['nonarray response', completion({ content: privateBody, tool_calls: { ...call(privateID, `${privateArgs}-${key}`) } })],
  ['valid call followed by invalid call', toolCompletion(call('second-round-action', 'page-2'), { ...call(privateID), function: { name: 'notion_tool', arguments: { privateArgs, key } } })],
  ['duplicate call from previous round', toolCompletion(call('already-executed-once', 'page-2'))],
]) {
  test(`a later ${label} does not repeat prior actions or dispatch any action from the rejected batch`, async () => {
    const probe = toolProbe(), bodies = [];
    const mocked = sequence([toolCompletion(call('already-executed-once', 'page-1')), invalid], bodies);
    await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), error => {
      assert.match(error.message, /Invalid|Duplicate|duplicate/);
      assert.match(error.message, /No tools from this batch were executed\./);
      assert.doesNotMatch(error.message, /No tools were executed\./);
      for (const value of [key, privateID, privateArgs, privateBody, 'already-executed-once', 'second-round-action']) assert.ok(!error.message.includes(value));
      return true;
    });
    assert.equal(mocked.count, 2);
    assert.deepEqual(probe.executions, [['read', { page: 'page-1' }]]);
    assert.deepEqual(probe.searches, []);
    assert.deepEqual(probe.activities.map(event => event.status), ['running', 'complete']);
    assert.equal(bodies[1].messages.at(-1).role, 'tool');
    assert.equal(bodies[1].messages.at(-1).tool_call_id, 'already-executed-once');
    assert.deepEqual(JSON.parse(bodies[1].messages.at(-1).content), { text: 'Read page result' });
  });
}

function assertLegacyError(error) {
  assert.match(error.message, /legacy OpenAI function_call/);
  assert.match(error.message, /modern tool_calls/);
  assert.match(error.message, /No tools from this batch were executed\./);
  assert.doesNotMatch(error.message, /No tools were executed\./);
  for (const value of [key, privateID, privateArgs, privateBody, 'mixed-modern-action', 'legacy-read-secret']) assert.ok(!error.message.includes(value), 'Legacy diagnostics must not expose provider fields');
  return true;
}

for (const [legacyLabel, legacyProperty] of [['omitted', {}], ['null', { function_call: null }]]) for (const [label, property] of absenceCases) {
  test(`legacy function_call ${legacyLabel} does not reject ordinary ${label} modern calls`, async () => {
    const probe = toolProbe();
    const mocked = sequence([completion({ content: 'Ordinary compatible answer', ...property, ...legacyProperty })]);
    const result = await generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl }));
    assert.equal(result.text, 'Ordinary compatible answer');
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  });
}

test('legacy function_call:null does not block a legitimate modern call round', async () => {
  const probe = toolProbe(), bodies = [];
  const first = call('modern-with-null-legacy');
  const mocked = sequence([
    completion({ content: null, tool_calls: [first], function_call: null }, 'tool_calls'),
    completion({ content: 'Modern round completed', tool_calls: null, function_call: null }),
  ], bodies);
  const result = await generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl }));
  assert.equal(mocked.count, 2);
  assert.equal(result.text, 'Modern round completed');
  assert.deepEqual(probe.executions, [['read', { page: 'page-1' }]]);
  assert.deepEqual(probe.searches, []);
  const echoed = bodies[1].messages.find(message => message.tool_calls);
  assert.deepEqual(echoed.tool_calls, [first]);
  assert.equal(echoed.function_call, undefined);
});

const legacyCall = { name: 'legacy-read-secret', arguments: JSON.stringify({ privateID, privateArgs, key }) };
for (const [label, value] of [
  ['object', legacyCall], ['empty object', {}],
  ['string', `${privateBody}-${privateArgs}-${key}`], ['empty string', ''],
  ['true', true], ['false', false], ['zero', 0], ['number', 1], ['array', []],
]) {
  test(`nonnull legacy function_call ${label} cannot masquerade as final text`, async () => {
    const probe = toolProbe();
    const mocked = sequence([completion({ content: privateBody, tool_calls: null, function_call: value })]);
    await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), assertLegacyError);
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  });
}

for (const finish of ['stop', 'tool_calls', 'function_call']) {
  test(`a mixed legacy/modern batch at finish_reason:${finish} rejects before any modern dispatch`, async () => {
    const probe = toolProbe();
    const mocked = sequence([completion({ content: privateBody, tool_calls: [call('mixed-modern-action')], function_call: legacyCall }, finish)]);
    await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), assertLegacyError);
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  });
}

test('finish_reason:function_call alone rejects missing or null legacy fields even with valid modern calls', async () => {
  for (const legacyProperty of [{}, { function_call: null }]) for (const property of [...absenceCases.map(([, value]) => value), { tool_calls: [call('mixed-modern-action')] }]) {
    const probe = toolProbe();
    const mocked = sequence([completion({ content: privateBody, ...legacyProperty, ...property }, 'function_call')]);
    await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), assertLegacyError);
    assert.equal(mocked.count, 1);
    assertNoExecution(probe);
  }
});

test('a later legacy response does not repeat an earlier modern action or claim no prior actions occurred', async () => {
  const probe = toolProbe(), bodies = [];
  const mocked = sequence([
    toolCompletion(call('modern-first-action')),
    completion({ content: privateBody, tool_calls: [call('mixed-modern-action')], function_call: legacyCall }, 'function_call'),
  ], bodies);
  await assert.rejects(generateReply(options({ ...probe.settings, fetchImpl: mocked.fetchImpl })), assertLegacyError);
  assert.equal(mocked.count, 2);
  assert.deepEqual(probe.executions, [['read', { page: 'page-1' }]]);
  assert.deepEqual(probe.searches, []);
  assert.deepEqual(probe.activities.map(event => event.status), ['running', 'complete']);
  assert.equal(bodies[1].messages.at(-1).tool_call_id, 'modern-first-action');
});
