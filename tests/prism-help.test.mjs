import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PRISM_HELP_TOOL, getPrismHelp, generateReply, conversationSearchCount } from '../api.js';

const endpoint = 'https://provider.example/v1';
const key = 'provider-private-key';
const initial = [{ role: 'user', parts: [{ text: 'How can I create a public file link?' }] }];
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const options = protocol => ({ endpoint, key, protocol, model: protocol === 'openai' ? 'compatible-model' : 'models/gemini-flash', contents: structuredClone(initial) });
const helpCall = (id, args = {}) => ({ id, name: 'prism_help', args });
const searchCall = id => ({ id, name: 'parallel_search', args: { objective: 'Find official documentation', search_queries: ['official docs'] } });
const notionCall = id => ({ id, name: 'notion_tool', args: { name: 'read_page', arguments_json: '{"page":"requested-page"}' } });
const notionTools = [{ name: 'read_page', description: 'Read a requested page', inputSchema: { type: 'object', properties: { page: { type: 'string' } } } }];

function reply(protocol, calls = [], text = 'Done.') {
  return protocol === 'openai'
    ? { choices: [{ message: { role: 'assistant', content: calls.length ? null : text, tool_calls: calls.length ? calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args) } })) : null }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }
    : { candidates: [{ content: { role: 'model', parts: calls.length ? calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.args }, thoughtSignature: `signature-${call.id}` })) : [{ text }] }, finishReason: 'STOP' }] };
}
function sequence(protocol, replies, bodies = []) {
  let requests = 0;
  return async (url, init) => {
    assert.equal(url, protocol === 'openai' ? `${endpoint}/chat/completions` : `${endpoint}/models/gemini-flash:generateContent`);
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.ok(requests < replies.length, 'Unexpected network request or automatic retry');
    bodies.push(JSON.parse(init.body));
    return json(replies[requests++]);
  };
}
const declarations = (protocol, body) => protocol === 'openai' ? body.tools.map(tool => tool.function) : body.tools[0].functionDeclarations;
const toolResults = (protocol, body) => protocol === 'openai'
  ? body.messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, response: JSON.parse(message.content) }))
  : body.contents.filter(turn => turn.role === 'user').flatMap(turn => turn.parts.filter(part => part.functionResponse).map(part => part.functionResponse));
function noExternalEffects() {
  return {
    searchImpl: async () => assert.fail('Read-only help dispatched a web search'),
    notionCall: async () => assert.fail('Read-only help dispatched a Notion action'),
    onSearch: () => assert.fail('Help consumed search activity/budget'),
    onTool: () => assert.fail('Help produced Notion activity'),
  };
}

test('prism_help declares only an optional, enum-bounded topic and describes read-only behavior', () => {
  assert.equal(PRISM_HELP_TOOL.name, 'prism_help');
  assert.match(PRISM_HELP_TOOL.description, /read-only/);
  assert.match(PRISM_HELP_TOOL.description, /never uploads files, changes settings, or accesses private data/);
  assert.equal(PRISM_HELP_TOOL.parameters.type, 'OBJECT');
  assert.deepEqual(Object.keys(PRISM_HELP_TOOL.parameters.properties), ['topic']);
  assert.deepEqual(PRISM_HELP_TOOL.parameters.properties.topic.enum, ['cdn_links']);
  assert.equal(PRISM_HELP_TOOL.parameters.required, undefined);
});

test('help is deterministic, fresh, static local data and does not mutate valid arguments', () => {
  const args = Object.freeze({ topic: 'cdn_links' });
  const expected = getPrismHelp({});
  assert.deepEqual(getPrismHelp(args), expected);
  assert.deepEqual(args, { topic: 'cdn_links' });
  assert.equal(expected.topic, 'cdn_links');
  assert.deepEqual(expected.references, ['https://catbox.moe/faq.php', 'https://catbox.moe/tools.php']);
  expected.references.push('https://attacker.invalid');
  expected.hint = 'mutated';
  assert.deepEqual(getPrismHelp({}), getPrismHelp(args));
  assert.equal(getPrismHelp({}).references.length, 2);
  assert.doesNotMatch(JSON.stringify(getPrismHelp({})), /provider-private-key|requested-page/);
});

for (const mode of ['off', 'on', 'enforced']) {
  test(`help in ${mode} mode discloses publication risks, permissions, and manual sharing`, () => {
    const help = getPrismHelp({}, mode);
    assert.equal(help.interactive_ui, mode);
    assert.match(help.hint, /If Interactive UI is Off, ask the user to turn it On or Enforced/);
    assert.match(help.hint, /never claim to change this setting yourself/);
    assert.match(help.hint, /button that calls window\.prism\.uploadToCatbox\(\) directly from its click handler/);
    assert.match(help.hint, /trusted file\/consent dialog/);
    assert.match(help.hint, /accepts no file, blob, URL or credential arguments/);
    assert.match(help.hint, /choose the file and explicitly approve publication/);
    assert.match(help.hint, /only a validated public link.*not file contents/);
    assert.match(help.hint, /paste it into chat.*not automatically sent to the model/);
    assert.match(help.hint, /Do not invent an uploaded URL/);
    assert.match(help.hint, /official Catbox website and a paste-link fallback/);
    assert.match(help.hint, /do not use a CORS proxy or retry a possibly completed upload/);
    assert.match(help.warning, /PUBLIC/);
    assert.match(help.warning, /no user-selected expiry.*indefinitely/);
    assert.match(help.warning, /Anonymous Catbox uploads.*two years without access/);
    assert.match(help.warning, /account uploads are permanent/);
    assert.match(help.warning, /Never upload secrets or private files/);
    assert.match(help.warning, /metadata, including EXIF, is not stripped/);
    assert.match(help.warning, /not a commercial CDN without its prior approval/);
    assert.match(help.warning, /Show this warning before offering upload/);
  });
}

test('invalid help arguments return a bounded generic error without echoing private values', () => {
  const privateValue = `secret-file-contents:${key}`;
  const invalid = [undefined, null, [], ['cdn_links'], 'cdn_links', true, 0, { topic: '' }, { topic: 'upload' }, { topic: null }, { topic: false }, { topic: 1 }, { topic: [] }, { topic: {} }, { topic: privateValue }, { file: privateValue }, { topic: 'cdn_links', credentials: privateValue }, JSON.parse(`{"__proto__":{"secret":"${privateValue}"}}`)];
  const expected = getPrismHelp(null);
  assert.deepEqual(Object.keys(expected), ['error']);
  assert.match(expected.error, /optional topic "cdn_links"/);
  assert.match(expected.error, /Do not send files, credentials or private content/);
  for (const args of invalid) {
    const snapshot = structuredClone(args);
    assert.deepEqual(getPrismHelp(args, 'off'), expected);
    assert.deepEqual(args, snapshot);
    assert.ok(!JSON.stringify(getPrismHelp(args)).includes(privateValue));
    assert.ok(JSON.stringify(getPrismHelp(args)).length < 250);
  }
  assert.equal({}.secret, undefined);
});

test('example HTML waits for a user click, passes no helper arguments, and displays rather than auto-sends the URL', async () => {
  const { example_html } = getPrismHelp({});
  assert.match(example_html, /^<artefact title=/);
  assert.match(example_html, /uploads are public.*no chosen expiry.*indefinitely/i);
  assert.match(example_html, /two years of inactivity/);
  const script = example_html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners = new Map(), output = { textContent: '' };
  let uploads = 0;
  const url = 'https://files.catbox.moe/abc123.png';
  const context = {
    document: { getElementById: id => id === 'result' ? output : { addEventListener: (event, listener) => listeners.set(event, listener) } },
    window: { prism: { uploadToCatbox: async (...args) => { assert.deepEqual(args, []); uploads++; return url; } } },
    fetch: () => assert.fail('Example performed a direct upload/network request'),
  };
  runInNewContext(script, context);
  assert.equal(uploads, 0);
  assert.deepEqual([...listeners.keys()], ['click']);
  await listeners.get('click')();
  assert.equal(uploads, 1);
  assert.equal(output.textContent, `${url} — Paste this link into chat if you want to share it with the model.`);
  context.window.prism.uploadToCatbox = async () => { throw new Error('User cancelled'); };
  await listeners.get('click')();
  assert.equal(output.textContent, 'User cancelled');
});

for (const protocol of ['gemini', 'openai']) {
  for (const artefactMode of ['off', 'on', 'enforced']) for (const [label, searchEnabled, searchesUsed] of [['search disabled', false, 0], ['search available', true, 19], ['search exhausted', true, 20]]) {
    test(`${protocol} ${artefactMode}: help is declared and callable with ${label}, without external effects`, async () => {
      const bodies = [], contents = structuredClone(initial), snapshot = structuredClone(contents);
      const result = await generateReply({ ...options(protocol), contents, artefactMode, searchEnabled, searchesUsed, ...noExternalEffects(),
        fetchImpl: sequence(protocol, [reply(protocol, [helpCall('help-1', { topic: 'cdn_links' })]), reply(protocol)], bodies),
      });
      assert.equal(bodies.length, 2);
      for (const body of bodies) {
        assert.deepEqual(declarations(protocol, body).map(tool => tool.name), searchEnabled && searchesUsed < 20 ? ['prism_help', 'parallel_search'] : ['prism_help']);
        assert.equal(protocol === 'openai' ? body.tool_choice : body.toolConfig.functionCallingConfig.mode, protocol === 'openai' ? 'auto' : 'AUTO');
        const declaration = declarations(protocol, body).find(tool => tool.name === 'prism_help');
        assert.equal(declaration.parameters.type, protocol === 'openai' ? 'object' : 'OBJECT');
        assert.equal(declaration.parameters.properties.topic.type, protocol === 'openai' ? 'string' : 'STRING');
        assert.deepEqual(declaration.parameters.properties.topic.enum, ['cdn_links']);
        const instruction = protocol === 'openai' ? body.messages[0].content : body.systemInstruction.parts[0].text;
        assert.match(instruction, /prism_help is an available read-only local hint tool/);
        assert.match(instruction, /does not upload files, grant permission, enable Interactive UI, consume Parallel searches, or access Notion/);
        if (searchEnabled) assert.ok(instruction.includes(`${20 - searchesUsed} searches remain`));
      }
      assert.deepEqual(toolResults(protocol, bodies[1]).map(({ id, response }) => ({ id, response })), [{ id: 'help-1', response: getPrismHelp({ topic: 'cdn_links' }, artefactMode) }]);
      assert.deepEqual(result.contents[2].parts, [{ functionResponse: { name: 'prism_help', id: 'help-1', response: getPrismHelp({}, artefactMode) } }]);
      assert.deepEqual(result.contents.map(turn => turn.role), ['user', 'model', 'user', 'model']);
      assert.deepEqual(contents, snapshot);
      assert.equal(result.text, 'Done.');
      assert.deepEqual(result.searches, []);
      assert.deepEqual(result.tools, []);
      assert.equal(conversationSearchCount({ history: result.contents }), 0);
      if (protocol === 'openai') {
        assert.deepEqual(result.contents[1].prismOpenAI.toolCalls, [{ id: 'help-1', arguments: '{"topic":"cdn_links"}' }]);
        assert.equal(bodies[1].messages.at(-2).tool_calls[0].id, 'help-1');
      } else {
        assert.equal(bodies[1].contents[1].parts[0].thoughtSignature, 'signature-help-1');
      }
    });
  }

  test(`${protocol} invalid help requests get redacted canonical results without search/Notion activity`, async () => {
    const bodies = [], privateValue = `private-file:${key}`;
    const calls = [null, [], { topic: privateValue }, { file: privateValue }, { topic: 'cdn_links', url: `https://attacker.invalid/${privateValue}` }].map((args, index) => helpCall(`invalid-${index}`, args));
    if (protocol === 'openai') calls.push({ ...helpCall('invalid-json'), raw: `{bad-json-${privateValue}` });
    const result = await generateReply({ ...options(protocol), searchesUsed: 20, searchEnabled: true, notionTools, ...noExternalEffects(),
      fetchImpl: sequence(protocol, [reply(protocol, calls), reply(protocol)], bodies),
    });
    const responses = toolResults(protocol, bodies[1]);
    assert.equal(responses.length, calls.length);
    assert.deepEqual(responses.map(item => item.id), calls.map(call => call.id));
    for (const response of responses) {
      assert.deepEqual(response.response, getPrismHelp(null));
      assert.ok(!JSON.stringify(response.response).includes(privateValue));
      assert.ok(!JSON.stringify(response.response).includes(key));
    }
    assert.deepEqual(result.searches, []);
    assert.deepEqual(result.tools, []);
    assert.equal(conversationSearchCount({ history: result.contents }), 0);
  });

  test(`${protocol} mixed help/search/Notion dispatch preserves ordering, IDs and independent accounting`, async () => {
    const bodies = [], searches = [], actions = [], searchEvents = [], toolEvents = [];
    const calls = [helpCall('hint-before'), searchCall('search-last'), notionCall('notion-read'), helpCall('hint-after', { topic: 'cdn_links' })];
    const result = await generateReply({ ...options(protocol), searchEnabled: true, searchesUsed: 19, notionTools,
      searchImpl: async args => { searches.push(args); return { text: 'Public search result' }; },
      notionCall: async (name, args) => { actions.push([name, args]); return { text: 'Requested Notion page' }; },
      onSearch: event => searchEvents.push(event), onTool: event => toolEvents.push(event),
      fetchImpl: sequence(protocol, [reply(protocol, calls), reply(protocol)], bodies),
    });
    assert.deepEqual(declarations(protocol, bodies[0]).map(tool => tool.name), ['prism_help', 'parallel_search', 'notion_tool']);
    assert.deepEqual(declarations(protocol, bodies[1]).map(tool => tool.name), ['prism_help', 'notion_tool']);
    assert.deepEqual(searches, [searchCall('unused').args]);
    assert.deepEqual(actions, [['read_page', { page: 'requested-page' }]]);
    assert.deepEqual(searchEvents.map(event => event.status), ['searching', 'complete']);
    assert.deepEqual(toolEvents.map(event => event.status), ['running', 'complete']);
    assert.equal(result.searches.length, 1);
    assert.equal(result.tools.length, 1);
    assert.deepEqual(result.contents[2].parts.map(part => part.functionResponse.name), calls.map(call => call.name));
    assert.deepEqual(toolResults(protocol, bodies[1]).map(item => item.id), calls.map(call => call.id));
    assert.deepEqual(result.contents[2].parts[0].functionResponse.response, getPrismHelp({}));
    assert.deepEqual(result.contents[2].parts[3].functionResponse.response, getPrismHelp({}));
    assert.equal(conversationSearchCount({ history: result.contents }), 1);
  });

  test(`${protocol} help and enabled Notion both remain callable after twenty searches`, async () => {
    const bodies = [], events = [];
    let actions = 0;
    const result = await generateReply({ ...options(protocol), searchEnabled: true, searchesUsed: 20, artefactMode: 'off', notionTools,
      ...noExternalEffects(), notionCall: async (name, args) => {
        assert.equal(name, 'read_page');
        assert.deepEqual(args, { page: 'requested-page' });
        actions++;
        return { text: 'Read result' };
      }, onTool: event => events.push(event),
      fetchImpl: sequence(protocol, [reply(protocol, [helpCall('hint-before'), notionCall('read'), helpCall('hint-after')]), reply(protocol)], bodies),
    });
    assert.equal(actions, 1);
    assert.deepEqual(events.map(event => event.status), ['running', 'complete']);
    assert.deepEqual(result.searches, []);
    assert.equal(result.tools.length, 1);
    const responses = toolResults(protocol, bodies[1]);
    assert.deepEqual(responses.map(item => item.id), ['hint-before', 'read', 'hint-after']);
    assert.deepEqual(responses.map(item => item.response), [getPrismHelp({}, 'off'), { text: 'Read result' }, getPrismHelp({}, 'off')]);
    for (const body of bodies) assert.deepEqual(declarations(protocol, body).map(tool => tool.name), ['prism_help', 'notion_tool']);
  });

  test(`${protocol} saved help history survives a new turn without replay or ID changes`, async () => {
    const result = await generateReply({ ...options(protocol), ...noExternalEffects(),
      fetchImpl: sequence(protocol, [reply(protocol, [helpCall('persisted-hint')]), reply(protocol)]),
    });
    const contents = JSON.parse(JSON.stringify([...result.contents, { role: 'user', parts: [{ text: 'Continue using that guidance.' }] }]));
    const snapshot = structuredClone(contents), bodies = [];
    const continued = await generateReply({ ...options(protocol), contents, ...noExternalEffects(),
      fetchImpl: sequence(protocol, [reply(protocol, [], 'Continued.')], bodies),
    });
    assert.equal(bodies.length, 1);
    assert.deepEqual(toolResults(protocol, bodies[0]).map(({ id, response }) => ({ id, response })), [{ id: 'persisted-hint', response: getPrismHelp({}) }]);
    if (protocol === 'openai') {
      const assistant = bodies[0].messages.find(message => message.tool_calls);
      assert.equal(assistant.tool_calls[0].id, 'persisted-hint');
      assert.equal(assistant.tool_calls[0].function.arguments, '{}');
    }
    assert.deepEqual(contents, snapshot);
    assert.deepEqual(continued.contents.slice(0, -1), snapshot);
    assert.equal(continued.text, 'Continued.');
    assert.deepEqual(continued.searches, []);
    assert.deepEqual(continued.tools, []);
  });

  test(`${protocol} exhausted searches cannot execute in a mixed help/Notion batch`, async () => {
    const bodies = [], events = [];
    const replies = [reply(protocol, [helpCall('hint'), searchCall('exhausted'), notionCall('read')]), reply(protocol)];
    if (protocol === 'gemini') {
      // Gemini rejects the whole unsupported batch before dispatch; OpenAI
      // reports per-call disabled-tool errors. Neither may execute a search.
      await assert.rejects(generateReply({ ...options(protocol), searchEnabled: true, searchesUsed: 20, notionTools,
        ...noExternalEffects(), fetchImpl: sequence(protocol, replies, bodies),
      }), /unsupported tools/);
      assert.equal(bodies.length, 1);
      return;
    }
    let actions = 0;
    const result = await generateReply({ ...options(protocol), searchEnabled: true, searchesUsed: 20, notionTools,
      ...noExternalEffects(), notionCall: async () => { actions++; return { text: 'Read result' }; }, onTool: event => events.push(event),
      fetchImpl: sequence(protocol, replies, bodies),
    });
    assert.equal(actions, 1);
    assert.deepEqual(events.map(event => event.status), ['running', 'complete']);
    assert.deepEqual(result.searches, []);
    assert.equal(result.tools.length, 1);
    const responses = toolResults(protocol, bodies[1]);
    assert.deepEqual(responses[0].response, getPrismHelp({}));
    assert.match(responses[1].response.error, /Unknown or disabled tool.*not executed/);
    assert.deepEqual(responses[2].response, { text: 'Read result' });
  });

  test(`${protocol} help has no twenty-call limit in either a batch or successive rounds`, async () => {
    const bodies = [];
    const calls = Array.from({ length: 32 }, (_, index) => helpCall(`batch-${index}`));
    const rounds = Array.from({ length: 25 }, (_, index) => reply(protocol, [helpCall(`round-${index}`)]));
    const result = await generateReply({ ...options(protocol), searchEnabled: true, searchesUsed: 20, ...noExternalEffects(),
      fetchImpl: sequence(protocol, [reply(protocol, calls), ...rounds, reply(protocol)], bodies),
    });
    assert.equal(bodies.length, 27);
    assert.equal(result.contents.flatMap(turn => turn.parts.filter(part => part.functionResponse?.name === 'prism_help')).length, 57);
    assert.equal(conversationSearchCount({ history: result.contents, searchCount: 20 }), 20);
    assert.deepEqual(result.searches, []);
    assert.deepEqual(result.tools, []);
    for (const body of bodies) assert.deepEqual(declarations(protocol, body).map(tool => tool.name), ['prism_help']);
    assert.equal(toolResults(protocol, bodies.at(-1)).length, 57);
  });

  test(`${protocol} an unbounded local-help loop is still cancellable without an extra completion`, async () => {
    const controller = new AbortController();
    let requests = 0;
    await assert.rejects(generateReply({ ...options(protocol), ...noExternalEffects(), signal: controller.signal, fetchImpl: async () => {
      requests++;
      if (requests === 26) controller.abort();
      return json(reply(protocol, [helpCall(`help-${requests}`)]));
    } }), { name: 'AbortError' });
    assert.equal(requests, 26);
  });
}
