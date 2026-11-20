import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KILO_ENDPOINT, kiloEndpoint, fetchKiloModels, normalizeKiloModel, isKiloModel, kiloModelId } from '../kilo.js';

const WORKER = 'https://synthetic-kilo.workers.dev';
const RELAY = `${WORKER}/kilo/v1`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const discover = rows => fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => json({ data: rows }) });
const canonical = (extra = {}) => ({ name: 'kilo:org/model:free', displayName: 'Kilo · Model', source: 'kilo', ...extra });
const ids = models => models.map(kiloModelId);

test('official upstream constant stays fixed but discovery uses the shared Worker without credentials', async () => {
  assert.equal(KILO_ENDPOINT, 'https://ai-gateway.kilo.ai/api/v1');
  const controller = new AbortController();
  const result = await fetchKiloModels({ workerURL: WORKER, endpoint: 'https://evil.invalid/', key: 'secret-key', protocol: 'gemini', headers: { Authorization: 'secret-key' }, signal: controller.signal, fetchImpl: async (url, init) => {
    assert.equal(url, `${RELAY}/models`);
    assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    assert.equal(init.body, undefined);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrer, '');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.signal, controller.signal);
    assert.ok(!JSON.stringify(init).includes('secret-key'));
    return json({ data: [] });
  } });
  assert.deepEqual(result, []);
});

test('Worker endpoint builder normalizes shared origins and rejects missing or unsafe URLs before fetch', async () => {
  assert.equal(kiloEndpoint(WORKER), RELAY);
  assert.equal(kiloEndpoint(WORKER + '/mcp'), RELAY);
  assert.equal(kiloEndpoint(WORKER + '/'), RELAY);
  assert.equal(kiloEndpoint('http://127.0.0.1:8123/mcp'), 'http://127.0.0.1:8123/kilo/v1');
  for (const workerURL of [undefined, null, '', ' ', 'http://public.example.com', 'https://user:secret@worker.example.com', WORKER + '/other', WORKER + '?key=secret', WORKER + '#fragment', 'https://evil.invalid']) {
    assert.throws(() => kiloEndpoint(workerURL), /Worker|HTTPS|URL/i);
    await assert.rejects(fetchKiloModels({ workerURL, fetchImpl: async () => assert.fail('No fetch for invalid Worker URL') }), /Worker|HTTPS|URL/i);
  }
});

test('includes explicit free flags, complete zero prices, exact ID free markers and stealth tokens', async () => {
  const result = await discover([
    { id: 'org/flag', isFree: true },
    { id: 'org/zero', pricing: { prompt: '0.000', completion: 0, request: '0', discount: 50 } },
    { id: 'org/model:free' }, { id: 'org/model-free' }, { id: 'kilo-auto/free' },
    { id: 'org/stealth-model' }, { id: 'org/mystery', name: 'Mystery (Stealth)' },
    { id: 'org/paid', pricing: { prompt: '0.1', completion: '0.1' } },
    { id: 'org/freemium', name: 'Freemium' }, { id: 'org/freeman', name: 'Freeman' },
    { id: 'org/stealthy' }, { id: 'org/ordinary', name: 'Free model' }, { id: 'free/ordinary' },
  ]);
  assert.deepEqual(new Set(ids(result)), new Set(['org/flag', 'org/zero', 'org/model:free', 'org/model-free', 'kilo-auto/free', 'org/stealth-model', 'org/mystery']));
  assert.equal(result.find(model => kiloModelId(model) === 'org/mystery').isStealth, true);
  assert.equal(result.find(model => kiloModelId(model) === 'org/mystery').isFree, false);
  assert.equal(result.find(model => kiloModelId(model) === 'org/zero').isFree, true);
  assert.ok(result.every(isKiloModel));
});

test('explicit paid, negative, unknown or inconsistent prices never become free through flags or markers', async () => {
  const bad = [null, undefined, '', ' ', false, true, {}, [], '-1', -1, '-0', -0, 'unknown', 'free', 'NaN', NaN, Infinity, 'Infinity', '1e-999', '0.00000001', 0.1, ' 0 ', '+0'];
  // Use raw values rather than JSON so NaN/Infinity are not silently converted.
  for (const rate of bad) {
    const result = await fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [
      { id: 'org/model:free', isFree: true, pricing: { prompt: rate, completion: '0' } },
      { id: 'org/stealth', pricing: { prompt: '0', completion: rate } },
    ] }) }) });
    assert.deepEqual(result, [], `Rejected billing value ${String(rate)}`);
  }
  for (const extra of [
    { isFree: false }, { isFree: 'true' }, { isFree: 1 },
    { pricing: null }, { pricing: [] }, { pricing: 'free' },
    { pricing: { prompt: '0', completion: '0', request: '0.01' } },
    { pricing: { prompt: '0', completion: '0', input_cache_read: '-1' } },
    { pricing: { prompt: '0', completion: '0', image: 'unknown' } },
  ]) assert.deepEqual(await discover([{ id: 'org/stealth:free', isFree: true, ...extra }]), []);
});

test('missing and partial pricing is not inferred as free without independent evidence', async () => {
  const result = await discover([
    { id: 'org/missing' }, { id: 'org/empty', pricing: {} },
    { id: 'org/prompt-only', pricing: { prompt: '0' } },
    { id: 'org/completion-only', pricing: { completion: '0' } },
    { id: 'org/discount', pricing: { discount: 100 } },
    { id: 'org/flagged', isFree: true, pricing: {} },
    { id: 'org/marked:free', pricing: { prompt: '0' } },
    { id: 'org/exponent', pricing: { prompt: '0e-10', completion: '0.00E+20' } },
  ]);
  assert.deepEqual(new Set(ids(result)), new Set(['org/flagged', 'org/marked:free', 'org/exponent']));
});

test('rejects invalid, control, URL-like and oversized IDs; does not use names as IDs', async () => {
  const invalid = ['', ' ', ' bad', 'bad ', 'a b', 'bad\u0000id', 'bad\nname', 'bad\u007fid', 'bad\u0085id', 'bad\u202eid', 'x'.repeat(513), 'https://evil.invalid/model', '//evil/model', '/model', 'org//model', 'org/../model', 'org/./model', 'org/model?key=x', 'org/model#x', 'kilo:org/model:free', null, 5, {}, []];
  assert.deepEqual(await discover([...invalid.map(id => ({ id, isFree: true })), null, {}, { name: 'No ID', isFree: true }]), []);
  assert.equal((await discover([{ id: 'a'.repeat(512), isFree: true }])).length, 1);
});

test('explicit non-chat tasks and output modalities are excluded while unspecified capabilities remain usable', async () => {
  const result = await discover([
    { id: 'org/chat:free', type: 'chat' }, { id: 'org/text:free', task: 'text-generation' },
    { id: 'org/multimodal:free', architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] } },
    { id: 'org/untyped:free' },
    { id: 'org/embedding:free', type: 'embedding' }, { id: 'org/embed:free', task: 'feature-extraction' },
    { id: 'org/rerank:free', pipeline_tag: 'reranking' }, { id: 'org/image:free', type: 'image' },
    { id: 'org/audio:free', architecture: { output_modalities: ['audio'] } },
    { id: 'org/image-only:free', architecture: { modality: 'text->image' } },
    { id: 'org/vector:free', output_modalities: ['embedding'] },
  ]);
  assert.deepEqual(new Set(ids(result)), new Set(['org/chat:free', 'org/text:free', 'org/multimodal:free', 'org/untyped:free']));
});

test('deduplicates by namespaced ID, sorts by display name, and allowlists useful metadata', async () => {
  const models = await discover([
    { id: 'org/z:free', name: 'Zulu', context_length: 100000, top_provider: { max_completion_tokens: 8192 }, description: 'Useful model', supported_parameters: ['tools'], mayTrainOnYourPrompts: true, endpoint: 'https://evil.invalid', key: 'secret', protocol: 'gemini' },
    { id: 'org/a:free', name: 'Alpha', context_window: 4096 },
    { id: 'org/z:free', name: 'AAA duplicate', context_length: 1 },
    { id: 'org/b:free', name: 'Alpha', context_length: -1, top_provider: { context_length: 2048 } },
    { id: 'org/fallback:free', name: 'bad\nname', context_length: '1000' },
  ]);
  assert.deepEqual(ids(models), ['org/a:free', 'org/b:free', 'org/z:free', 'org/fallback:free'].sort((a, b) => {
    const names = { 'org/a:free': 'Alpha', 'org/b:free': 'Alpha', 'org/z:free': 'Zulu', 'org/fallback:free': 'org/fallback:free' };
    return names[a].localeCompare(names[b]) || a.localeCompare(b);
  }));
  const zulu = models.find(model => kiloModelId(model) === 'org/z:free');
  assert.deepEqual(zulu, { name: 'kilo:org/z:free', displayName: 'Kilo · Zulu', source: 'kilo', contextWindow: 100000, outputTokenLimit: 8192, description: 'Useful model', isFree: true, isStealth: false, mayTrainOnYourPrompts: true, supportsTools: true });
  assert.equal(models.find(model => kiloModelId(model) === 'org/b:free').contextWindow, 2048);
  assert.ok(!Object.hasOwn(models.find(model => kiloModelId(model) === 'org/fallback:free'), 'contextWindow'));
});

test('OpenAI-style pagination stays on fixed GET URL with encoded after cursor and deduplicates across pages', async () => {
  let calls = 0;
  const models = await fetchKiloModels({ workerURL: WORKER, fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, `${RELAY}/models`);
    assert.equal(init.method, 'GET');
    if (calls++ === 0) {
      assert.equal(parsed.search, '');
      return json({ data: [{ id: 'org/z:free' }], has_more: true, last_id: 'org/z:free' });
    }
    assert.equal(parsed.searchParams.get('after'), 'org/z:free');
    assert.match(parsed.search, /org%2Fz%3Afree/);
    return json({ data: [{ id: 'org/a:free' }, { id: 'org/z:free' }], has_more: false });
  } });
  assert.equal(calls, 2);
  assert.deepEqual(ids(models), ['org/a:free', 'org/z:free']);
});

test('rejects malformed, URL, repeated, empty and excessive pagination without arbitrary follow-up requests', async () => {
  for (const extra of [
    { has_more: 'true' }, { has_more: true, last_id: 'https://evil.invalid' },
    { next: 'https://evil.invalid' }, { next_url: 'https://evil.invalid' },
    { next_cursor: 'cursor' }, { links: { next: 'https://evil.invalid' } },
    { pagination: { next: 'https://evil.invalid' } }, { nextPageToken: 'token' },
  ]) {
    let calls = 0;
    await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => { calls++; return json({ data: [{ id: 'org/x:free' }], ...extra }); } }), /pagination/);
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => json({ data: [], has_more: true, last_id: 'cursor' }) }), /pagination/);
  let repeats = 0;
  await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => { repeats++; return json({ data: [{ id: 'repeat:free' }], has_more: true }); } }), /pagination/);
  assert.equal(repeats, 2);
  let pages = 0;
  await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => json({ data: [{ id: `page-${++pages}:free` }], has_more: true }) }), /pagination/);
  assert.equal(pages, 20);
});

test('HTTP errors are clear, bounded, and do not echo server messages or secrets', async () => {
  for (const status of [301, 400, 401, 403, 404, 429, 500, 503]) {
    await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => json({ error: { message: 'secret'.repeat(10000) } }, status) }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(error.message.length < 300);
      assert.ok(!error.message.includes('secret'));
      if (status === 429) assert.match(error.message, /shared per-IP limits/);
      if (status === 404) assert.match(error.message, /Update your existing Cloudflare Worker deployment/);
      return true;
    });
  }
  await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => ({ ok: false, status: 'secret' }) }), /HTTP unknown/);
});

test('nonJSON, schema, network and catalog-size failures are bounded and distinct', async () => {
  await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => new Response('<html>secret</html>') }), /non-JSON/);
  for (const data of [null, [], {}, { data: null }, { data: {} }, { models: [] }, { data: [], error: { message: 'secret' } }]) {
    await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => json(data) }), /schema/);
  }
  await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => { throw new TypeError('secret'.repeat(10000)); } }), error => {
    assert.match(error.message, /Kilo.*shared Worker.*allowed origins.*Redirects/);
    assert.ok(error.message.length < 200);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  await assert.rejects(discover(Array.from({ length: 20001 }, () => ({ id: 'org/x:free' }))), /size limit/);
});

test('cancellation before fetch, during fetch, during parsing and between pages uses bounded AbortError', async () => {
  const before = new AbortController(); before.abort('secret');
  await assert.rejects(fetchKiloModels({ workerURL: WORKER, signal: before.signal, fetchImpl: async () => assert.fail('No fetch after cancellation') }), { name: 'AbortError', message: 'Kilo model discovery was cancelled.' });
  for (const name of ['AbortError', 'TimeoutError']) await assert.rejects(fetchKiloModels({ workerURL: WORKER, fetchImpl: async () => { const error = new Error('secret'); error.name = name; throw error; } }), { name: 'AbortError' });
  for (const stage of ['fetch', 'parse', 'parse-error']) {
    const controller = new AbortController();
    await assert.rejects(fetchKiloModels({ workerURL: WORKER, signal: controller.signal, fetchImpl: async () => {
      if (stage === 'fetch') controller.abort('secret');
      return { ok: true, async json() { controller.abort('secret'); if (stage === 'parse-error') throw new Error('secret'); return { data: [], has_more: true }; } };
    } }), { name: 'AbortError', message: 'Kilo model discovery was cancelled.' });
  }
});

test('canonical cache normalization strips endpoints, keys, protocol and arbitrary records', () => {
  const unsafe = canonical({ contextWindow: 128000, outputTokenLimit: 8192, description: 'Cached model', isFree: true, isStealth: false, supportsTools: true, mayTrainOnYourPrompts: true, endpoint: 'https://evil.invalid', key: 'secret', apiKey: 'secret', protocol: 'gemini', id: 'other', nested: { key: 'secret' } });
  const safe = normalizeKiloModel(unsafe);
  assert.deepEqual(safe, canonical({ contextWindow: 128000, outputTokenLimit: 8192, description: 'Cached model', isFree: true, isStealth: false, mayTrainOnYourPrompts: true, supportsTools: true }));
  assert.notEqual(safe, unsafe);
  assert.ok(!isKiloModel(unsafe));
  assert.ok(isKiloModel(safe));
  assert.equal(kiloModelId(safe), 'org/model:free');
  assert.equal(unsafe.key, 'secret');
  const scrubbed = normalizeKiloModel(canonical({ contextWindow: '1000', outputTokenLimit: -1, description: 'bad\ntext', supportsTools: 'true', isFree: 1 }));
  assert.deepEqual(scrubbed, canonical());
  assert.ok(!isKiloModel(canonical({ contextWindow: -1 })));
});

test('canonical recognition and ID helpers reject provider collisions, malformed cache rows and bare strings', () => {
  const invalid = [undefined, null, [], {}, 'kilo:org/model:free', 'org/model:free',
    canonical({ source: 'provider' }), canonical({ source: undefined }), canonical({ name: 'org/model:free' }),
    canonical({ name: 'kilo:' }), canonical({ name: 'kilo:kilo:org/model:free' }), canonical({ name: 'kilo:org/model\n' }),
    canonical({ displayName: 'Model' }), canonical({ displayName: 'Kilo · ' }), canonical({ displayName: 'Kilo · Bad\u0000' }),
    canonical({ name: `kilo:${'a'.repeat(513)}` }), canonical({ displayName: `Kilo · ${'x'.repeat(1024)}` }),
  ];
  for (const value of invalid) {
    assert.equal(normalizeKiloModel(value), null);
    assert.equal(isKiloModel(value), false);
    assert.throws(() => kiloModelId(value), /valid canonical Kilo model/);
  }
  assert.equal(isKiloModel(canonical()), true);
  assert.equal(kiloModelId(canonical()), 'org/model:free');
  assert.equal(isKiloModel({ name: 'org/model:free', displayName: 'org/model:free' }), false);
});
