import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint, fetchModels, generateReply, redact, ARTEFACT_INSTRUCTION, normalizeArtefactMode, getArtefactInstruction } from '../api.js';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta';
const key = 'test-secret';
const model = { name: 'models/gemini-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('normalizes trailing slashes, supports custom version paths and localhost', () => {
  assert.equal(normalizeEndpoint(`  ${endpoint}/// `), endpoint);
  assert.equal(normalizeEndpoint('https://custom.example/gemini/v1'), 'https://custom.example/gemini/v1');
  assert.equal(normalizeEndpoint('http://localhost:9000/v1beta'), 'http://localhost:9000/v1beta');
});
test('rejects unsafe protocols, remote HTTP, URL credentials and query parameters', () => {
  for (const url of ['bad', 'file:///tmp', 'http://example.com/v1', 'https://user:pass@example.com', 'https://example.com?key=x', 'https://example.com/#fragment']) assert.throws(() => normalizeEndpoint(url));
});
test('fetches all pages and only returns deduplicated generateContent models', async () => {
  let calls = 0;
  const result = await fetchModels({ endpoint, key, fetchImpl: async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], key);
    assert.equal(new URL(url).searchParams.has('key'), false);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    calls++;
    if (calls === 1) return json({ models: [model, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next page' });
    assert.equal(new URL(url).searchParams.get('pageToken'), 'next page');
    return json({ models: [model, { ...model, name: 'models/pro', displayName: 'Pro' }] });
  } });
  assert.equal(calls, 2);
  assert.deepEqual(result.map(item => item.name), ['models/gemini-flash', 'models/pro']);
});
test('rejects looping pagination and malformed model arrays', async () => {
  await assert.rejects(fetchModels({ endpoint, key, fetchImpl: async () => json({ models: [], nextPageToken: 'loop' }) }), /pagination/);
  await assert.rejects(fetchModels({ endpoint, key, fetchImpl: async () => json({ models: {} }) }), /Unexpected model/);
});
test('empty model lists are handled', async () => {
  assert.deepEqual(await fetchModels({ endpoint, key, fetchImpl: async () => json({}) }), []);
});
test('sends multi-turn Gemini contents and optional system instruction', async () => {
  const contents = [{ role: 'user', parts: [{ text: 'Hello' }] }, { role: 'model', parts: [{ text: 'Hi' }] }, { role: 'user', parts: [{ text: 'Continue' }] }];
  const result = await generateReply({ endpoint, key, model: model.name, contents, systemInstruction: 'Be concise', fetchImpl: async (url, options) => {
    assert.equal(url, `${endpoint}/${model.name}:generateContent`);
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.contents, contents);
    assert.ok(body.systemInstruction.parts[0].text.startsWith(`Be concise\n\n${ARTEFACT_INSTRUCTION}\n\n`));
    assert.match(body.systemInstruction.parts[0].text, /prism_help is an available read-only local hint tool/);
    assert.deepEqual(body.tools[0].functionDeclarations.map(tool => tool.name), ['prism_help']);
    assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
    return json({ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'Hello ' }, { text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 20 } });
  } });
  assert.equal(result.text, 'Hello world');
  assert.equal(result.warning, '');
  assert.equal(result.usage.totalTokenCount, 20);
});
test('advertises self-contained artefacts without requiring a custom system instruction', async () => {
  await generateReply({ endpoint, key, model: model.name, contents: [], fetchImpl: async (_, options) => {
    const instruction = JSON.parse(options.body).systemInstruction.parts[0].text;
    assert.ok(instruction.startsWith(`${ARTEFACT_INSTRUCTION}\n\n`));
    assert.match(instruction, /prism_help is an available read-only local hint tool/);
    assert.match(instruction, /<artefact title=/);
    assert.match(instruction, /without a fixed height cap/);
    assert.match(instruction, /Do not wrap code examples/);
    assert.match(instruction, /Public HTTPS images, including CDN URLs/);
    assert.match(instruction, /real user clicks open a separate tab\/window with no opener or referrer/);
    assert.match(instruction, /External scripts, libraries, fonts, fetch requests and frame navigation remain blocked/);
    return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  } });
});
test('normalizes Interactive UI modes and migrates only an explicitly false legacy flag to off', () => {
  for (const mode of ['off', 'on', 'enforced']) {
    for (const legacy of [undefined, false, true]) assert.equal(normalizeArtefactMode(mode, legacy), mode);
  }
  for (const invalid of [undefined, null, '', 'OFF', 'invalid', false, true, 0, {}, ['on']]) {
    assert.equal(normalizeArtefactMode(invalid, false), 'off');
    for (const legacy of [undefined, true, null, 0, 'false']) assert.equal(normalizeArtefactMode(invalid, legacy), 'on');
  }
});
test('mode instructions preserve canonical On and describe safe Off and Enforced behavior', () => {
  assert.equal(getArtefactInstruction(), ARTEFACT_INSTRUCTION);
  assert.equal(getArtefactInstruction('on'), ARTEFACT_INSTRUCTION);
  assert.equal(getArtefactInstruction('invalid'), ARTEFACT_INSTRUCTION);
  const off = getArtefactInstruction('off');
  assert.match(off, /Interactive UI is unavailable/);
  assert.match(off, /plain source code and will not run/);
  assert.match(off, /fenced html code blocks/);
  assert.match(off, /do not claim.*interact with a preview/);
  assert.doesNotMatch(off, /Prism can render/);
  const enforced = getArtefactInstruction('enforced');
  assert.ok(enforced.startsWith(`${ARTEFACT_INSTRUCTION}\n\n`));
  assert.ok(enforced.includes('Use interactive UI by default at the end of each answer.'));
  assert.match(enforced, /Put the interactive portion after any Markdown explanation/);
  assert.match(enforced, /Honor explicit user requests/);
  assert.match(enforced, /response wrappers, not API function declarations/);
  assert.match(enforced, /do not fabricate tools or tool calls/);
});
test('all modes preserve custom instructions and never declare artefact tools', async () => {
  for (const artefactMode of ['off', 'on', 'enforced']) {
    await generateReply({ endpoint, key, model: model.name, contents: [], artefactMode, systemInstruction: '  Be practical.  ', fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      assert.ok(body.systemInstruction.parts[0].text.startsWith(`Be practical.\n\n${getArtefactInstruction(artefactMode)}\n\n`));
      assert.deepEqual(body.tools[0].functionDeclarations.map(tool => tool.name), ['prism_help']);
      assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
      return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    } });
  }
});
test('generateReply migrates legacy flags, handles invalid modes, and prioritizes valid new modes', async () => {
  const cases = [
    [{}, 'on'],
    [{ artefactsEnabled: false }, 'off'],
    [{ artefactsEnabled: true }, 'on'],
    [{ artefactMode: 'on', artefactsEnabled: false }, 'on'],
    [{ artefactMode: 'enforced', artefactsEnabled: false }, 'enforced'],
    [{ artefactMode: 'off', artefactsEnabled: true }, 'off'],
    [{ artefactMode: 'invalid', artefactsEnabled: false }, 'off'],
    [{ artefactMode: 'invalid' }, 'on'],
  ];
  for (const [settings, expectedMode] of cases) {
    await generateReply({ endpoint, key, model: model.name, contents: [], ...settings, systemInstruction: '  ', fetchImpl: async (_, options) => {
      assert.ok(JSON.parse(options.body).systemInstruction.parts[0].text.startsWith(`${getArtefactInstruction(expectedMode)}\n\n`));
      return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    } });
  }
});
test('disabling interactive UI guidance leaves web-search instructions intact', async () => {
  await generateReply({ endpoint, key, model: model.name, contents: [], artefactsEnabled: false, searchEnabled: true, searchesUsed: 20, fetchImpl: async (_, options) => {
    const instruction = JSON.parse(options.body).systemInstruction.parts[0].text;
    assert.match(instruction, /Parallel web search has a maximum of 20 search attempts/);
    assert.doesNotMatch(instruction, /Prism can render|<artefact/);
    return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  } });
});
test('every mode survives search and Notion continuations without changing tool behavior', async () => {
  for (const artefactMode of ['off', 'on', 'enforced']) {
    let calls = 0;
    const executed = [];
    const result = await generateReply({
      endpoint, key, model: model.name, contents: [{ role: 'user', parts: [{ text: 'Research and save a summary.' }] }],
      artefactMode, systemInstruction: 'Keep it brief.', searchEnabled: true,
      notionTools: [{ name: 'save_summary', description: 'Save a summary.', inputSchema: { type: 'object' } }],
      searchImpl: async args => { executed.push(['search', args]); return { text: 'Search result' }; },
      notionCall: async (name, args) => { executed.push([name, args]); return { text: 'Saved' }; },
      fetchImpl: async (_, options) => {
        const body = JSON.parse(options.body);
        const instruction = body.systemInstruction.parts[0].text;
        assert.ok(instruction.startsWith(`Keep it brief.\n\n${getArtefactInstruction(artefactMode)}\n\n`));
        assert.match(instruction, /Parallel web search has a maximum of 20 search attempts/);
        assert.match(instruction, /Notion tools are available without a per-turn or per-conversation call-count limit/);
        assert.deepEqual(body.tools[0].functionDeclarations.map(tool => tool.name), ['prism_help', 'parallel_search', 'notion_tool']);
        assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
        calls++;
        if (calls === 1) {
          assert.match(instruction, /20 searches remain/);
          return json({ candidates: [{ content: { role: 'model', parts: [
            { functionCall: { name: 'parallel_search', id: 'search-1', args: { objective: 'Find evidence', search_queries: ['recent evidence'] } }, thoughtSignature: 'signature' },
            { functionCall: { name: 'notion_tool', id: 'notion-1', args: { name: 'save_summary', arguments_json: '{"summary":"Evidence"}' } } },
          ] } }] });
        }
        assert.equal(calls, 2);
        assert.match(instruction, /19 searches remain/);
        assert.equal(body.contents[1].parts[0].thoughtSignature, 'signature');
        assert.deepEqual(body.contents.at(-1).parts, [
          { functionResponse: { name: 'parallel_search', id: 'search-1', response: { text: 'Search result' } } },
          { functionResponse: { name: 'notion_tool', id: 'notion-1', response: { text: 'Saved' } } },
        ]);
        return json({ candidates: [{ content: { parts: [{ text: 'Done' }] } }] });
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(executed, [
      ['search', { objective: 'Find evidence', search_queries: ['recent evidence'] }],
      ['save_summary', { summary: 'Evidence' }],
    ]);
    assert.equal(result.text, 'Done');
    assert.equal(result.searches[0].status, 'complete');
    assert.equal(result.tools[0].status, 'complete');
  }
});
test('warns on truncated model responses', async () => {
  const result = await generateReply({ endpoint, key, model: model.name, contents: [], fetchImpl: async () => json({ candidates: [{ content: { parts: [{ text: 'Partial' }] }, finishReason: 'MAX_TOKENS' }] }) });
  assert.match(result.warning, /incomplete/);
});
test('handles blocked prompts and missing text', async () => {
  for (const data of [{ promptFeedback: { blockReason: 'SAFETY' } }, { candidates: [{ finishReason: 'SAFETY' }] }]) {
    await assert.rejects(generateReply({ endpoint, key, model: model.name, contents: [], fetchImpl: async () => json(data) }), /SAFETY/);
  }
});
test('explains API failures and redacts echoed secrets', async () => {
  await assert.rejects(fetchModels({ endpoint, key, fetchImpl: async () => json({ error: { message: `bad ${key}` } }, 403) }), error => {
    assert.match(error.message, /403/);
    assert.match(error.message, /\[redacted\]/);
    assert.equal(error.message.includes(key), false);
    return true;
  });
  assert.equal(redact('secret secret', 'secret'), '[redacted] [redacted]');
  await assert.rejects(fetchModels({ endpoint, key, fetchImpl: async () => json({ error: {} }, 429) }), /quota/);
});
test('explains non-JSON and network/CORS errors', async () => {
  await assert.rejects(fetchModels({ endpoint, key, fetchImpl: async () => new Response('<html>404</html>', { status: 404 }) }), /non-JSON/);
  await assert.rejects(fetchModels({ endpoint, key, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /CORS/);
});
test('preserves cancellation and refuses missing keys or unsafe model names', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchModels({ endpoint, key, signal: controller.signal, fetchImpl: async () => { throw controller.signal.reason; } }), { name: 'AbortError' });
  await assert.rejects(fetchModels({ endpoint, key: '', fetchImpl: async () => assert.fail('Must not send') }), /API key/);
  await assert.rejects(generateReply({ endpoint, key, model: '../bad', contents: [], fetchImpl: async () => assert.fail('Must not send') }), /valid model/);
});
