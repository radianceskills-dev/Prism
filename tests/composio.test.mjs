import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { createComposioClient, normalizeWorkerURL } from '../composio.js';
import { createNotionClient } from '../notion.js';
const WORKER = 'https://prism-worker.example.com';
const RESOURCE = 'https://connect.composio.dev/mcp';
const ISSUER = 'https://connect.composio.dev';

const MCP = `${WORKER}/mcp`;
const TOKEN = `${WORKER}/oauth/token`;
const REGISTER = `${WORKER}/oauth/register`;
const keys = { client: 'prism.composio.worker.client', tokens: 'prism.composio.worker.tokens', pending: 'prism.composio.worker.pending' };
const tool = { name: 'notion-search', description: 'Find tools', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
const access = 'private-access-token-opaque';
const refresh = 'private-refresh-token-opaque';
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } });
const rpc = (id, result, headers) => json({ jsonrpc: '2.0', id, result }, headers);
const tokenReply = extra => json({ token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600, ...extra });
function store() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => {
    if (key.startsWith('prism.composio.worker.')) {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = JSON.stringify({ workerURL: WORKER, ...parsed }); } catch {}
    }
    data.set(key, String(value));
  }, removeItem: key => data.delete(key) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup({ handler, timeoutMs, href = 'https://prism.test/nested/index.html?old=1#view', loggedIn = false } = {}) {
  const localStorage = store(), sessionStorage = store(), calls = [], actions = [];
  const location = { href, assigned: null, assign(url) { this.assigned = url; actions.push('redirect'); } };
  const history = { replaceState(_state, _unused, url) { location.href = new URL(url, location.href).href; actions.push('strip'); } };
  if (loggedIn) {
    localStorage.setItem(keys.client, JSON.stringify({ clientId: 'public-client', redirectUri: 'https://prism.test/nested/index.html' }));
    localStorage.setItem(keys.tokens, JSON.stringify({ accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3600000 }));
  }
  const fetchImpl = async (url, options) => {
    actions.push('fetch');
    const body = options.headers['Content-Type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(options.body)) : JSON.parse(options.body);
    calls.push({ url, ...options, body });
    if (handler) { const result = await handler(url, options, body, calls); if (result !== undefined) return result; }
    if (url === REGISTER) return json({ client_id: 'public-client', token_endpoint_auth_method: 'none', redirect_uris: [body.redirect_uris[0]] });
    if (url === TOKEN) return tokenReply();
    if (body.method === 'initialize') return rpc(body.id, { protocolVersion: '2025-06-18', capabilities: {} }, { 'Mcp-Session-Id': 'session-123' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return rpc(body.id, { tools: [tool] });
    if (body.method === 'tools/call') return rpc(body.id, { content: [{ type: 'text', text: 'result' }] });
    throw new Error('Unexpected test request');
  };
  const options = { fetchImpl, localStorage, sessionStorage, location, history, crypto: webcrypto, ...(timeoutMs ? { timeoutMs } : {}) };
  const client = createComposioClient(WORKER, options);
  const pending = () => JSON.parse(sessionStorage.getItem(keys.pending));
  const callback = (extra = {}) => {
    const state = pending()?.state ?? 'invalid';
    location.href = `https://prism.test/nested/index.html?${new URLSearchParams({ code: 'one-time-code-secret', state, iss: 'https://connect.composio.dev', ...extra })}`;
  };
  return { client, options, localStorage, sessionStorage, calls, actions, location, pending, callback };
}

// OAuth and local credentials

test('connect registers a fixed public client, creates strong PKCE and redirects with stripped callback', async () => {
  const h = setup();
  assert.deepEqual(h.client.status(), { connected: false });
  await h.client.connect();
  const pending = h.pending();
  assert.match(pending.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pending.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pending.state, pending.verifier);
  assert.equal(pending.redirectUri, 'https://prism.test/nested/index.html');
  assert.ok(Math.abs(Date.now() - pending.createdAt) < 1000);
  const url = new URL(h.location.assigned);
  assert.equal(url.origin + url.pathname, 'https://connect.composio.dev/oauth/authorize');
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('resource'), RESOURCE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(pending.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('state'), pending.state);
  assert.equal(url.searchParams.get('redirect_uri'), pending.redirectUri);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(h.calls[0].url, REGISTER);
  assert.deepEqual(h.calls[0].body, { client_name: 'Prism', redirect_uris: [pending.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  assert.equal(h.localStorage.getItem(keys.tokens), null);
});

test('finishLogin strips before requests, consumes code once, persists only essential credentials', async () => {
  const h = setup(); await h.client.connect(); const pending = h.pending(); h.callback({ iss: 'https://connect.composio.dev' });
  h.actions.length = 0;
  assert.equal(await h.client.finishLogin(), true);
  assert.deepEqual(h.actions, ['strip', 'fetch']);
  assert.equal(h.location.href, pending.redirectUri);
  assert.equal(h.sessionStorage.getItem(keys.pending), null);
  const exchange = h.calls.at(-1);
  assert.equal(exchange.url, TOKEN);
  assert.equal(exchange.body.code_verifier, pending.verifier);
  assert.equal(exchange.body.code, 'one-time-code-secret');
  assert.equal(exchange.body.redirect_uri, pending.redirectUri);
  assert.deepEqual(h.client.status(), { connected: true });
  assert.deepEqual(createComposioClient(WORKER, h.options).status(), { connected: true });
  assert.deepEqual(Object.keys(JSON.parse(h.localStorage.getItem(keys.tokens))).sort(), ['accessToken', 'expiresAt', 'refreshToken', 'workerURL']);
  assert.equal(await h.client.finishLogin(), false);
  h.location.href = `${pending.redirectUri}?code=one-time-code-secret&state=${pending.state}`;
  await assert.rejects(h.client.finishLogin(), /already handled/);
  assert.equal(h.calls.length, 2);
});

test('cached public registration is reused only for the exact redirect path', async () => {
  const h = setup(); await h.client.connect(); const first = h.pending().state;
  await h.client.connect(); assert.equal(h.calls.length, 1); assert.notEqual(h.pending().state, first);
  h.location.href = 'https://prism.test/other/'; await h.client.connect();
  assert.equal(h.calls.length, 2); assert.equal(h.pending().redirectUri, h.location.href);
});

test('rejects mismatched, expired, future, duplicate, missing and fragment callback values before any token request', async () => {
  const mutations = [
    h => h.callback({ state: 'different' }),
    h => { const p = h.pending(); p.createdAt -= 600001; h.sessionStorage.setItem(keys.pending, JSON.stringify(p)); h.callback(); },
    h => { const p = h.pending(); p.createdAt += 60000; h.sessionStorage.setItem(keys.pending, JSON.stringify(p)); h.callback(); },
    h => { h.callback(); h.location.href += '&state=duplicate'; },
    h => { h.callback(); h.location.href += '&code=duplicate'; },
    h => { h.callback(); h.location.href = h.location.href.replace('/nested/index.html', '/other'); },
    h => { h.callback(); h.location.href = h.location.href.replace('prism.test', 'evil.test'); },
    h => h.callback({ iss: 'https://evil.test' }),
    h => h.callback({ iss: '' }),
    h => h.callback({ iss: 'https://connect.composio.dev/' }),
    h => { h.callback(); h.location.href += '&iss=https%3A%2F%2Fmcp.notion.com'; },
    h => h.callback({ code: '' }),
    h => { h.callback(); h.location.href = h.location.href.replace('?', '#'); },
    h => { h.callback(); h.sessionStorage.removeItem(keys.pending); },
    h => { const p = h.pending(); p.verifier = 'bad'; h.sessionStorage.setItem(keys.pending, JSON.stringify(p)); h.callback(); },
  ];
  for (const mutate of mutations) {
    const h = setup(); await h.client.connect(); mutate(h); h.actions.length = 0;
    await assert.rejects(h.client.finishLogin(), /callback|state|redirect|expiry|authorization code/i);
    assert.deepEqual(h.actions, ['strip']);
    assert.equal(new URL(h.location.href).search, ''); assert.equal(new URL(h.location.href).hash, '');
    assert.equal(h.sessionStorage.getItem(keys.pending), null);
    assert.equal(h.calls.length, 1);
  }
});

test('OAuth decline and exchange failure cannot echo diagnostics or replay code', async () => {
  const h = setup(); await h.client.connect(); h.callback({ error: 'denied', error_description: access });
  await assert.rejects(h.client.finishLogin(), e => /declined/.test(e.message) && !e.message.includes(access));
  const failed = setup({ handler: url => url === TOKEN ? new Response(access, { status: 400 }) : undefined });
  await failed.client.connect(); const pending = failed.pending(); failed.callback();
  await assert.rejects(failed.client.finishLogin(), e => e.status === 400 && !e.message.includes(access));
  failed.location.href = `${pending.redirectUri}?code=one-time-code-secret&state=${pending.state}`;
  await assert.rejects(failed.client.finishLogin(), /already handled/);
  assert.equal(failed.calls.filter(r => r.url === TOKEN).length, 1);
});

test('rejects insecure callbacks and confidential or hostile registration responses', async () => {
  for (const href of ['http://example.com/', 'file:///site/index.html', 'https://user:pass@prism.test/']) {
    const h = setup({ href }); await assert.rejects(h.client.connect(), /HTTPS/); assert.equal(h.calls.length, 0);
  }
  for (const registration of [{ client_id: 'client', client_secret: 'secret' }, { client_id: 'client', token_endpoint_auth_method: 'client_secret_post' }, { client_id: 'client', redirect_uris: ['https://evil.test'] }, { client_id: 'bad\nheader' }]) {
    const h = setup({ handler: url => url === REGISTER ? json(registration) : undefined });
    await assert.rejects(h.client.connect(), /public-client registration/); assert.equal(h.location.assigned, null);
  }
  const local = setup({ href: 'http://127.0.0.1:3000/' }); await local.client.connect();
  assert.equal(local.pending().redirectUri, 'http://127.0.0.1:3000/');
});

test('storage failure is explicit; history failure sends no code; invalid stored tokens fail closed', async () => {
  const h = setup();
  h.localStorage.getItem = () => { throw new Error(access); };
  assert.equal(h.client.status().connected, false);
  assert.match(h.client.status().error, /localStorage/);
  await assert.rejects(h.client.connect(), /localStorage/); assert.equal(h.calls.length, 0);
  const noWrite = setup(); noWrite.localStorage.setItem = () => { throw new Error(access); };
  await assert.rejects(noWrite.client.connect(), /localStorage/); assert.equal(noWrite.location.assigned, null);
  const badHistory = setup(); await badHistory.client.connect(); badHistory.callback();
  badHistory.options.history.replaceState = () => { throw new Error(access); };
  await assert.rejects(badHistory.client.finishLogin(), /clear the OAuth callback/); assert.equal(badHistory.calls.length, 1);
  for (const value of ['invalid', '{}', JSON.stringify({ accessToken: 'bad\nheader', expiresAt: 2 })]) {
    const broken = setup(); broken.localStorage.setItem(keys.tokens, value);
    assert.equal(broken.client.status().connected, false);
    assert.match(broken.client.status().error, /invalid/);
  }
});

test('rejects malformed token replies without saving them', async () => {
  for (const extra of [{ token_type: 'Basic' }, { expires_in: -1 }, { expires_in: '3600' }, { access_token: 'x\nheader' }, { refresh_token: {} }]) {
    const h = setup({ handler: url => url === TOKEN ? tokenReply(extra) : undefined });
    await h.client.connect(); h.callback(); await assert.rejects(h.client.finishLogin(), /invalid authorization/);
    assert.equal(h.localStorage.getItem(keys.tokens), null);
  }
});

test('expiry refresh is single-flight, rotates tokens, isolates headers and preserves refresh token when omitted', async () => {
  const started = deferred(), release = deferred();
  const h = setup({ loggedIn: true, handler: async url => {
    if (url === TOKEN) { started.resolve(); await release.promise; return tokenReply({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }); }
  } });
  const saved = JSON.parse(h.localStorage.getItem(keys.tokens)); saved.expiresAt = Date.now() - 1; h.localStorage.setItem(keys.tokens, JSON.stringify(saved));
  const one = h.client.listTools(), two = h.client.listTools();
  await started.promise; release.resolve(); await Promise.all([one, two]);
  assert.equal(h.calls.filter(r => r.url === TOKEN).length, 1);
  const request = h.calls.find(r => r.url === TOKEN);
  assert.equal(request.body.grant_type, 'refresh_token'); assert.equal(request.body.refresh_token, refresh);
  assert.equal(request.headers.Authorization, undefined);
  const persisted = JSON.parse(h.localStorage.getItem(keys.tokens));
  assert.equal(persisted.accessToken, 'rotated-access'); assert.equal(persisted.refreshToken, 'rotated-refresh');
  for (const call of h.calls.filter(r => r.url === MCP)) assert.equal(call.headers.Authorization, 'Bearer rotated-access');
  const noRotation = setup({ loggedIn: true, handler: url => url === TOKEN ? json({ token_type: 'Bearer', access_token: 'new-access', expires_in: 3600 }) : undefined });
  saved.expiresAt = 1; noRotation.localStorage.setItem(keys.tokens, JSON.stringify(saved));
  await noRotation.client.listTools(); assert.equal(JSON.parse(noRotation.localStorage.getItem(keys.tokens)).refreshToken, refresh);
});

test('refresh rejection forgets credentials without replay; disconnect aborts refresh and cannot resurrect login', async () => {
  const denied = setup({ loggedIn: true, handler: url => url === TOKEN ? new Response(refresh, { status: 400 }) : undefined });
  const saved = JSON.parse(denied.localStorage.getItem(keys.tokens)); saved.expiresAt = 1; denied.localStorage.setItem(keys.tokens, JSON.stringify(saved));
  await assert.rejects(denied.client.listTools(), e => e.status === 400 && !e.message.includes(refresh));
  assert.deepEqual(denied.client.status(), { connected: false }); assert.equal(denied.calls.length, 1);
  const started = deferred(), released = deferred();
  const h = setup({ loggedIn: true, handler: async url => { if (url === TOKEN) { started.resolve(); await released.promise; return tokenReply(); } } });
  h.localStorage.setItem(keys.tokens, JSON.stringify(saved)); h.sessionStorage.setItem(keys.pending, '{}');
  const result = h.client.listTools(); await started.promise; h.client.disconnect();
  await assert.rejects(result, { name: 'AbortError' }); released.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.localStorage.getItem(keys.tokens), null); assert.equal(h.localStorage.getItem(keys.client), null); assert.equal(h.sessionStorage.getItem(keys.pending), null);
  assert.deepEqual(h.client.status(), { connected: false });
});

test('blocked storage property getters do not crash constructor or status, and no unrelated data is removed', async () => {
  const options = { get localStorage() { throw new Error(access); } };
  const client = createComposioClient(WORKER, options);
  assert.equal(client.status().connected, false); assert.match(client.status().error, /localStorage/);
  assert.equal(client.status().error.includes(access), false);
  const h = setup({ loggedIn: true });
  h.localStorage.setItem('prism.settings', 'preserve'); h.sessionStorage.setItem('other.app', 'preserve');
  h.client.disconnect();
  assert.equal(h.localStorage.getItem('prism.settings'), 'preserve'); assert.equal(h.sessionStorage.getItem('other.app'), 'preserve');
});

test('expired nonrefreshable tokens disconnect without sending requests; forged error names cannot leak secrets', async () => {
  const h = setup({ loggedIn: true });
  h.localStorage.setItem(keys.tokens, JSON.stringify({ accessToken: access, refreshToken: null, expiresAt: 1 }));
  assert.deepEqual(h.client.status(), { connected: false });
  await assert.rejects(h.client.listTools(), /expired/); assert.equal(h.calls.length, 0);
  for (const name of ['ComposioError', 'AbortError']) {
    const bad = setup({ loggedIn: true, handler: () => { const failure = new Error(access); failure.name = name; throw failure; } });
    await assert.rejects(bad.client.listTools(), failure => !failure.message.includes(access));
  }
});

test('concurrent connect is bounded to one registration, and response metadata cannot redirect credentials', async () => {
  const started = deferred(), release = deferred();
  const h = setup({ handler: async (url, _options, body) => {
    if (url === REGISTER) { started.resolve(); await release.promise; return json({ client_id: 'public-client', token_endpoint: 'https://evil.test', registration_access_token: 'unused-admin-secret', redirect_uris: body.redirect_uris }); }
    if (url === TOKEN) return tokenReply({ id_token: 'unused-identity-token', token_endpoint: 'https://evil.test' });
  } });
  const first = h.client.connect(); await started.promise;
  await assert.rejects(h.client.connect(), /already starting/); release.resolve(); await first;
  h.callback(); await h.client.finishLogin();
  assert.deepEqual(h.calls.map(call => call.url), [REGISTER, TOKEN]);
  const persisted = [...h.localStorage.data.values()].join('');
  assert.equal(persisted.includes('unused-admin-secret'), false); assert.equal(persisted.includes('unused-identity-token'), false); assert.equal(persisted.includes('evil.test'), false);
});

test('Composio storage keys and OAuth token forms remain issuer-scoped', async () => {
  const h = setup();
  h.localStorage.setItem('prism.notion.tokens', 'unrelated');
  h.sessionStorage.setItem('prism.notion.pending', 'unrelated');
  await h.client.connect();
  assert.deepEqual([...h.sessionStorage.data.keys()].sort(), ['prism.composio.worker.pending', 'prism.notion.pending']);
  h.callback(); await h.client.finishLogin();
  const exchange = h.calls.find(call => call.url === TOKEN);
  assert.equal(exchange.body.resource, RESOURCE);
  assert.equal(exchange.body.client_id, 'public-client');
  assert.equal(exchange.body.grant_type, 'authorization_code');
  assert.equal(exchange.headers.Authorization, undefined);
  assert.equal(exchange.headers['Content-Type'], 'application/x-www-form-urlencoded');
  for (const call of h.calls) {
    assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error');
    assert.equal(call.referrerPolicy, 'no-referrer'); assert.equal(call.cache, 'no-store');
    assert.equal(call.headers['x-goog-api-key'], undefined);
  }
  h.client.disconnect();
  assert.deepEqual([...h.localStorage.data.keys()], ['prism.notion.tokens']);
  assert.deepEqual([...h.sessionStorage.data.keys()], ['prism.notion.pending']);
});

test('Composio accepts 2025-03-26 lifecycle without an exposed session header', async () => {
  const h = setup({ loggedIn: true, handler: (_url, _options, body) => body.method === 'initialize' ? rpc(body.id, { protocolVersion: '2025-03-26', capabilities: {} }) : undefined });
  await h.client.listTools(); await h.client.callTool(tool.name, {});
  assert.equal(h.calls[0].body.params.protocolVersion, '2025-03-26');
  assert.deepEqual(h.calls.map(call => call.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  for (const call of h.calls) assert.equal(call.headers['Mcp-Session-Id'], undefined);
  for (const call of h.calls.slice(1)) assert.equal(call.headers['MCP-Protocol-Version'], '2025-03-26');
});

test('normal pages return false and issuer-only callbacks are rejected without network', async () => {
  const h = setup();
  assert.equal(await h.client.finishLogin(), false);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.actions, []);
  h.location.href = 'https://prism.test/nested/index.html?iss=https%3A%2F%2Fmcp.notion.com';
  await assert.rejects(h.client.finishLogin(), /callback/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.actions, ['strip']);
});

// MCP transport and bounds

test('MCP lifecycle negotiates session and protocol; tools are discovered before calls and remain JSON data', async () => {
  const h = setup({ loggedIn: true });
  await assert.rejects(h.client.callTool(tool.name, {}), /Discover/);
  assert.deepEqual(await h.client.listTools(), [tool]);
  assert.deepEqual(await h.client.callTool(tool.name, { query: '<script>not executed</script>' }), { content: [{ type: 'text', text: 'result' }] });
  assert.deepEqual(h.calls.map(r => r.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  for (const call of h.calls) {
    assert.equal(call.url, MCP); assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit'); assert.equal(call.referrerPolicy, 'no-referrer');
    assert.equal(call.headers.Authorization, `Bearer ${access}`); assert.equal(call.headers['x-api-key'], undefined); assert.equal(call.headers['x-goog-api-key'], undefined);
  }
  for (const call of h.calls.slice(1)) { assert.equal(call.headers['Mcp-Session-Id'], 'session-123'); assert.equal(call.headers['MCP-Protocol-Version'], '2025-06-18'); }
  assert.equal(h.calls[1].body.id, undefined);
  assert.deepEqual(h.calls.at(-1).body.params, { name: tool.name, arguments: { query: '<script>not executed</script>' } });
  h.client.disconnect(); await assert.rejects(h.client.callTool(tool.name, {}), /Discover/);
});

function sse(id, result, { terminated = true, cancel = () => {} } = {}) {
  const bytes = new TextEncoder().encode(`: keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":${id},\r\ndata: "result":${JSON.stringify(result)}}${terminated ? '\r\n\r\n' : ''}`);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } else if (!terminated) controller.close(); }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SSE incremental UTF-8, multiline CRLF, notifications and unfinished final event are supported', async () => {
  for (const terminated of [true, false]) {
    let cancelled = false;
    const h = setup({ loggedIn: true, handler: (_url, _options, body) => body.method === 'tools/call' ? sse(body.id, { content: [{ type: 'text', text: 'café 文' }] }, { terminated, cancel: () => { cancelled = true; } }) : undefined });
    await h.client.listTools(); assert.equal((await h.client.callTool(tool.name, {})).content[0].text, 'café 文');
    if (terminated) assert.equal(cancelled, true);
  }
});

test('tool pages accumulate beyond 64 tools while cursor validation and pagination bounds remain', async () => {
  const h = setup({ loggedIn: true, handler: (_url, _options, body) => body.method === 'tools/list' ? rpc(body.id, body.params.cursor ? { tools: [{ ...tool, name: 'SECOND_TOOL' }] } : { tools: [tool], nextCursor: 'next' }) : undefined });
  assert.equal((await h.client.listTools()).length, 2); assert.deepEqual(h.calls.at(-1).body.params, { cursor: 'next' });
  const largeCatalog = setup({ loggedIn: true, handler: (_u, _o, body) => body.method === 'tools/list' ? rpc(body.id, { tools: Array.from({ length: 100 }, (_, i) => ({ ...tool, name: `tool_${i}` })) }) : undefined });
  assert.equal((await largeCatalog.client.listTools()).length, 100);
  await largeCatalog.client.callTool('tool_99', {});
  assert.equal(largeCatalog.calls.at(-1).body.params.name, 'tool_99');
  for (const variant of ['repeat', 'pages', 'duplicate', 'name', 'schema']) {
    let pages = 0;
    const bad = setup({ loggedIn: true, handler: (_u, _o, body) => {
      if (body.method !== 'tools/list') return;
      pages++;
      if (variant === 'repeat' || variant === 'pages') return rpc(body.id, { tools: [], nextCursor: variant === 'repeat' ? 'same' : String(pages) });
      if (variant === 'duplicate') return rpc(body.id, { tools: [tool, tool] });
      return rpc(body.id, { tools: [{ ...tool, ...(variant === 'name' ? { name: 'unsafe/name' } : { inputSchema: { type: 'string' } }) }] });
    } });
    await assert.rejects(bad.client.listTools(), /cursor|limit|invalid|duplicate/);
    assert.ok(pages <= 10); await assert.rejects(bad.client.callTool(tool.name, {}), /Discover/);
  }
});

test('arguments must be bounded JSON objects and names cannot invoke arbitrary MCP methods', async () => {
  const h = setup({ loggedIn: true }); await h.client.listTools(); const count = h.calls.length;
  const cycle = {}; cycle.self = cycle;
  for (const args of [null, [], { x: undefined }, { x: () => {} }, { x: BigInt(1) }, { x: Infinity }, cycle, { x: '文'.repeat(30000) }, { get x() { throw new Error('should not invoke getter'); } }]) await assert.rejects(h.client.callTool(tool.name, args), /JSON|complexity|size/);
  for (const name of ['initialize', 'tools/call', 'UNKNOWN', 'https://evil.test']) await assert.rejects(h.client.callTool(name, {}), /Discover/);
  assert.equal(h.calls.length, count);
});

test('HTTP/auth/network and RPC errors never expose raw diagnostics or replay side effects', async () => {
  for (const mode of [401, 404, 403, 429, 500, 302, 'rpc', 'network']) {
    let toolCalls = 0;
    const h = setup({ loggedIn: true, handler: (_u, _o, body) => {
      if (body.method !== 'tools/call') return;
      toolCalls++;
      if (mode === 'network') throw new Error(access + refresh);
      if (mode === 'rpc') return json({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: access + refresh } });
      return new Response(access + refresh, { status: mode, headers: { Location: 'https://evil.test' } });
    } });
    await h.client.listTools();
    await assert.rejects(h.client.callTool(tool.name, {}), e => !e.message.includes(access) && !e.message.includes(refresh));
    assert.equal(toolCalls, 1); assert.equal(h.calls.filter(r => r.url === TOKEN).length, 0);
    if (mode === 401) assert.deepEqual(h.client.status(), { connected: false });
  }
});

test('tool output and metadata redact credentials and omit unrecognized top-level fields', async () => {
  const h = setup({ loggedIn: true, handler: (_u, _o, body) => {
    if (body.method === 'tools/list') return rpc(body.id, { tools: [{ ...tool, description: access }] });
    if (body.method === 'tools/call') return rpc(body.id, { content: [{ type: 'text', text: `${access} ${refresh}` }], isError: true, structuredContent: { [access]: refresh }, _meta: { token: access }, secret: refresh });
  } });
  assert.equal((await h.client.listTools())[0].description, '[REDACTED]');
  const result = await h.client.callTool(tool.name, {});
  assert.deepEqual(result, { content: [{ type: 'text', text: '[REDACTED] [REDACTED]' }], isError: true, structuredContent: { '[REDACTED]': '[REDACTED]' } });
});

test('malformed responses, protocol and session headers are rejected', async () => {
  const variants = [
    body => new Response('oops', { headers: { 'Content-Type': 'application/json' } }),
    body => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    body => rpc(body.id + 1, { content: [] }),
    body => rpc(body.id, {}),
    body => rpc(body.id, { content: [{ type: 'text', text: 1 }] }),
    body => rpc(body.id, { content: [], isError: 'yes' }),
    body => new Response('data: {"jsonrpc":"2.0","id":999,"result":{}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
  ];
  for (const make of variants) {
    const h = setup({ loggedIn: true, handler: (_u, _o, body) => body.method === 'tools/call' ? make(body) : undefined });
    await h.client.listTools(); await assert.rejects(h.client.callTool(tool.name, {}), /Composio/);
  }
  for (const headers of [{}, { 'Mcp-Session-Id': 'x'.repeat(513) }]) {
    const h = setup({ loggedIn: true, handler: (_u, _o, body) => body.method === 'initialize' ? rpc(body.id, { protocolVersion: 'unsupported' }, headers) : undefined });
    await assert.rejects(h.client.listTools(), /protocol|session header/);
  }
});

test('response, content, and schema limits count UTF-8 bytes', async () => {
  for (const handler of [
    body => rpc(body.id, { content: [] }, { 'Content-Length': '1048577' }),
    body => new Response(' '.repeat(1048577), { headers: { 'Content-Type': 'application/json' } }),
    body => rpc(body.id, { content: [{ type: 'text', text: '文'.repeat(180000) }] }),
    body => new Response(':'.repeat(1048577), { headers: { 'Content-Type': 'text/event-stream' } }),
  ]) {
    const h = setup({ loggedIn: true, handler: (_u, _o, body) => body.method === 'tools/call' ? handler(body) : undefined });
    await h.client.listTools(); await assert.rejects(h.client.callTool(tool.name, {}), /size limit/);
  }
  const h = setup({ loggedIn: true, handler: (_u, _o, body) => body.method === 'tools/list' ? rpc(body.id, { tools: [{ ...tool, inputSchema: { type: 'object', description: '文'.repeat(12000) } }] }) : undefined });
  await assert.rejects(h.client.listTools(), /size limit/);
});

test('caller cancellation aborts fetch and stalled SSE without leaking abort reasons', async () => {
  for (const stream of [false, true]) {
    const started = deferred(); let upstreamSignal, cancelled = false;
    const h = setup({ loggedIn: true, handler: (_u, options, body) => {
      if (body.method !== 'tools/call') return;
      upstreamSignal = options.signal;
      if (!stream) { started.resolve(); return new Promise(() => {}); }
      return new Response(new ReadableStream({ pull() { started.resolve(); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    await h.client.listTools(); const controller = new AbortController();
    const result = h.client.callTool(tool.name, {}, { signal: controller.signal });
    await started.promise; await Promise.resolve(); controller.abort(new Error(access));
    await assert.rejects(result, e => e.name === 'AbortError' && !e.message.includes(access));
    assert.equal(upstreamSignal.aborted, true);
    if (stream) await new Promise(resolve => setImmediate(resolve));
    if (stream) assert.equal(cancelled, true);
    const count = h.calls.length;
    await assert.rejects(h.client.callTool(tool.name, {}, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(h.calls.length, count);
  }
});

test('deadline bounds uncooperative network calls and SSE readers without unhandled rejection', async () => {
  for (const stream of [false, true]) {
    let cancelled = false;
    const h = setup({ loggedIn: true, timeoutMs: 30, handler: (_u, _o, body) => {
      if (body.method !== 'tools/call') return;
      return stream ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }) : new Promise(() => {});
    } });
    await h.client.listTools();
    await assert.rejects(h.client.callTool(tool.name, {}), e => e.status === 504);
    if (stream) assert.equal(cancelled, true);
  }
});


// Worker-specific security contract. Fixtures above mirror the Notion mock transport;
// store() supplies normal Worker binding, while data.set() injects hostile raw records.
test('normalizes only Worker origins and /mcp, including explicit HTTPS ports and loopback previews', () => {
  for (const value of [WORKER, `${WORKER}/`, `${WORKER}/mcp`, `  ${WORKER}/mcp  `]) assert.equal(normalizeWorkerURL(value), WORKER);
  assert.equal(normalizeWorkerURL('https://Prism-Worker.Example.Com:8443/mcp'), `${WORKER}:8443`);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(normalizeWorkerURL(`http://${host}:3000/mcp`), `http://${host}:3000`);
    assert.equal(normalizeWorkerURL(`https://${host}/`), `https://${host}`);
  }
});

test('rejects ordinary API paths, credentials, fragments, query, escapes, private hosts and nonloopback IPs', () => {
  for (const value of [null, {}, '', 'worker.example.com', 'ftp://worker.example.com', 'http://worker.example.com',
    `${WORKER}/api`, `${WORKER}/oauth/token`, `${WORKER}/mcp/`, `${WORKER}/./mcp`, `${WORKER}/mcp/../`,
    `${WORKER}//mcp`, `${WORKER}/%6dcp`, `${WORKER}%2fmcp`, `${WORKER}?`, `${WORKER}#`, `${WORKER}?key=secret`,
    'https://user:pass@worker.example.com', 'https://@worker.example.com', 'http://2130706433', 'https://0x7f000001', 'https://user@worker.example.com', 'https://worker.example.com\\mcp',
    'https://192.168.0.1', 'https://10.0.0.1', 'https://169.254.169.254', 'https://8.8.8.8', 'https://[fc00::1]',
    'https://[2001:4860:4860::8888]', 'https://127.0.0.2', 'https://router', 'https://router.local',
    'https://router.internal', 'https://router.localhost', 'https://localhost.', 'https://worker.example.com.']) {
    assert.throws(() => normalizeWorkerURL(value), /Worker origin/);
  }
});

test('construction never fetches; canonical resource and issuer are never derived from the Worker', async () => {
  const h = setup(); assert.equal(h.calls.length, 0);
  await h.client.connect(); const pending = h.pending();
  assert.equal(pending.workerURL, WORKER); assert.equal(pending.resource, RESOURCE); assert.equal(pending.issuer, ISSUER);
  const authorization = new URL(h.location.assigned);
  assert.equal(authorization.origin, ISSUER); assert.equal(authorization.pathname, '/oauth/authorize');
  assert.equal(authorization.searchParams.get('resource'), RESOURCE);
  h.callback(); await h.client.finishLogin();
  for (const [kind, key] of [['localStorage', 'client'], ['localStorage', 'tokens']]) assert.equal(JSON.parse(h[kind].getItem(keys[key])).workerURL, WORKER);
  assert.equal(h.calls.at(-1).body.resource, RESOURCE);
  const token = JSON.parse(h.localStorage.getItem(keys.tokens)); token.expiresAt = 1; h.localStorage.setItem(keys.tokens, JSON.stringify(token));
  await h.client.listTools();
  const refreshCall = h.calls.find(call => call.body.grant_type === 'refresh_token');
  assert.equal(refreshCall.body.resource, RESOURCE); assert.equal(refreshCall.url, TOKEN);
});

test('Composio accepts absent response iss but validates any present issuer exactly and uniquely', async () => {
  const h = setup(); await h.client.connect(); h.callback();
  const url = new URL(h.location.href); url.searchParams.delete('iss'); h.location.href = url.href;
  assert.equal(await h.client.finishLogin(), true);
  for (const suffix of ['&iss=', '&iss=https%3A%2F%2Fevil.example.com', '&iss=https%3A%2F%2Fconnect.composio.dev%2F', '&iss=https%3A%2F%2Fconnect.composio.dev&iss=https%3A%2F%2Fconnect.composio.dev']) {
    const bad = setup(); await bad.client.connect(); bad.callback();
    const callback = new URL(bad.location.href); callback.searchParams.delete('iss'); bad.location.href = callback.href + suffix;
    await assert.rejects(bad.client.finishLogin(), /state|callback/); assert.equal(bad.calls.length, 1);
  }
});

test('pending issuer and resource binding are mandatory even when response iss is absent', async () => {
  for (const field of ['issuer', 'resource']) for (const replacement of [undefined, WORKER]) {
    const h = setup(); await h.client.connect();
    const pending = h.pending(); if (replacement === undefined) delete pending[field]; else pending[field] = replacement;
    h.sessionStorage.setItem(keys.pending, JSON.stringify(pending)); h.callback();
    const url = new URL(h.location.href); url.searchParams.delete('iss'); h.location.href = url.href;
    await assert.rejects(h.client.finishLogin(), /state|redirect|expiry/);
    assert.equal(h.calls.length, 1); assert.equal(h.sessionStorage.getItem(keys.pending), null);
  }
});

test('single-current Worker credentials cannot migrate to an edited Worker URL', async () => {
  const h = setup({ loggedIn: true });
  const edited = createComposioClient('https://different-worker.example.com/mcp', h.options);
  assert.equal(edited.status().connected, false); assert.match(edited.status().error, /binding/);
  await assert.rejects(edited.listTools(), /binding/);
  await assert.rejects(edited.connect(), /binding/);
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(h.localStorage.getItem(keys.tokens)).workerURL, WORKER);
  edited.clearSavedCredentials(); assert.equal(h.localStorage.getItem(keys.tokens), null); assert.equal(h.localStorage.getItem(keys.client), null);
});

test('every client/token/pending binding mismatch or missing binding fails before network', async () => {
  for (const key of ['client', 'tokens', 'pending']) for (const binding of [undefined, 'https://different-worker.example.com', `${WORKER}/`]) {
    const h = setup({ loggedIn: true });
    const kind = key === 'pending' ? 'sessionStorage' : 'localStorage';
    const value = key === 'pending' ? { state: 'x' } : JSON.parse(h[kind].getItem(keys[key]));
    if (binding === undefined) delete value.workerURL; else value.workerURL = binding;
    h[kind].data.set(keys[key], JSON.stringify(value));
    await assert.rejects(h.client.listTools(), /binding/); assert.equal(h.calls.length, 0);
    await assert.rejects(h.client.connect(), /binding/); assert.equal(h.calls.length, 0);
  }
});

test('changed Worker callback is stripped and consumed once without sending code anywhere', async () => {
  const h = setup(); await h.client.connect(); h.callback(); const previous = h.location.href;
  const edited = createComposioClient('https://different-worker.example.com', h.options);
  assert.equal(edited.hasPendingLogin(), false); assert.equal(edited.ownsLoginCallback(), false);
  h.actions.length = 0;
  await assert.rejects(edited.finishLogin(), /binding/);
  assert.deepEqual(h.actions, ['strip']); assert.equal(h.sessionStorage.getItem(keys.pending), null);
  assert.equal(h.calls.length, 1); assert.equal(new URL(h.location.href).search, '');
  h.location.href = previous; await assert.rejects(edited.finishLogin(), /callback/); assert.equal(h.calls.length, 1);
});

test('refresh validates the client binding and current redirect before sending a refresh token', async () => {
  for (const change of ['worker', 'redirect']) {
    const h = setup({ loggedIn: true });
    const tokens = JSON.parse(h.localStorage.getItem(keys.tokens)); tokens.expiresAt = 1; h.localStorage.setItem(keys.tokens, JSON.stringify(tokens));
    if (change === 'worker') { const client = JSON.parse(h.localStorage.getItem(keys.client)); client.workerURL = 'https://different-worker.example.com'; h.localStorage.setItem(keys.client, JSON.stringify(client)); }
    else h.location.href = 'https://prism.test/changed-path';
    await assert.rejects(h.client.listTools(), /binding|redirect/); assert.equal(h.calls.length, 0);
  }
});

test('migration deletes retired credentials locally without reading or forwarding them and preserves Notion', () => {
  const h = setup();
  for (const kind of ['localStorage', 'sessionStorage']) {
    for (const key of ['client', 'tokens', 'pending']) h[kind].setItem(`prism.composio.${key}`, 'retired-secret');
    h[kind].setItem('prism.notion.tokens', 'preserve-notion');
  }
  assert.deepEqual(h.client.status(), { connected: false }); h.client.hasPendingLogin();
  for (const kind of ['localStorage', 'sessionStorage']) {
    for (const key of ['client', 'tokens', 'pending']) assert.equal(h[kind].getItem(`prism.composio.${key}`), null);
    assert.equal(h[kind].getItem('prism.notion.tokens'), 'preserve-notion');
  }
  assert.equal(h.calls.length, 0);
});

test('callback ownership permits overlapping provider logins without consuming another pending state', async () => {
  const h = setup(); await h.client.connect();
  const notion = createNotionClient(h.options);
  const notionPending = { state: 'n'.repeat(43) };
  h.sessionStorage.setItem('prism.notion.pending', JSON.stringify(notionPending));
  h.callback(); assert.equal(h.client.hasPendingLogin(), true); assert.equal(h.client.ownsLoginCallback(), true);
  assert.equal(h.client.isLoginCallback(), true); assert.equal(notion.ownsLoginCallback(), false); assert.equal(notion.hasPendingLogin(), true);
  await h.client.finishLogin(); assert.equal(notion.hasPendingLogin(), true);
  h.location.href = `https://prism.test/nested/index.html?code=notion-code&state=${notionPending.state}`;
  const original = h.location.href;
  assert.equal(await h.client.finishLogin(), false); assert.equal(h.location.href, original);
  assert.equal(notion.ownsLoginCallback(), true);
  h.sessionStorage.removeItem('prism.notion.pending');
  await h.client.connect(); h.callback();
  assert.equal(await notion.finishLogin(), false); assert.equal(h.client.ownsLoginCallback(), true);
});

test('malformed own callback can be claimed using hasPendingLogin but exact ownership rejects duplicate state', async () => {
  const h = setup(); await h.client.connect(); h.callback(); h.location.href += '&state=duplicate';
  assert.equal(h.client.hasPendingLogin(), true); assert.equal(h.client.ownsLoginCallback(), false);
  await assert.rejects(h.client.finishLogin(), /callback/); assert.equal(h.client.hasPendingLogin(), false);
  assert.equal(h.calls.length, 1);
});

test('DCR rejects even empty or null client_secret fields for public clients', async () => {
  for (const client_secret of ['', null, false, 0]) {
    const h = setup({ handler: url => url === REGISTER ? json({ client_id: 'client', client_secret }) : undefined });
    await assert.rejects(h.client.connect(), /public-client/); assert.equal(h.location.assigned, null);
  }
});

test('secret OAuth values and registration IDs are scrubbed from all tool output channels', async () => {
  let echoes;
  const h = setup({ handler: (_url, _options, body) => {
    if (body.method === 'tools/call') return rpc(body.id, { content: [{ type: 'text', text: echoes }], structuredContent: { [echoes]: echoes } });
  } });
  await h.client.connect(); const pending = h.pending(); h.callback(); await h.client.finishLogin();
  echoes = [access, refresh, pending.verifier, 'one-time-code-secret', pending.clientId].join(' ');
  await h.client.listTools(); const result = await h.client.callTool(tool.name, {});
  assert.equal(result.content[0].text, '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  assert.equal(JSON.stringify(result).includes(pending.verifier), false);
});

test('clearSavedCredentials aborts a stale tool action without replay and ignores its late result', async () => {
  const started = deferred(), release = deferred(); let actions = 0;
  const h = setup({ loggedIn: true, handler: async (_url, _options, body) => {
    if (body.method === 'tools/call') { actions++; started.resolve(); await release.promise; return rpc(body.id, { content: [{ type: 'text', text: access }] }); }
  } });
  await h.client.listTools(); const result = h.client.callTool(tool.name, {}); await started.promise;
  h.client.clearSavedCredentials(); await assert.rejects(result, { name: 'AbortError' }); release.resolve();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(actions, 1); assert.deepEqual(h.client.status(), { connected: false });
  for (const key of ['tokens', 'client']) assert.equal(h.localStorage.getItem(keys[key]), null);
  assert.equal(h.sessionStorage.getItem(keys.pending), null);
});


test('callback checks every persisted binding before sending a one-time code', async () => {
  for (const key of ['client', 'tokens', 'pending']) {
    const h = setup(); await h.client.connect(); h.callback();
    const kind = key === 'pending' ? 'sessionStorage' : 'localStorage';
    const value = key === 'tokens' ? { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3600000 } : JSON.parse(h[kind].getItem(keys[key]));
    value.workerURL = 'https://different-worker.example.com'; h[kind].data.set(keys[key], JSON.stringify(value));
    h.actions.length = 0;
    await assert.rejects(h.client.finishLogin(), /binding/); assert.deepEqual(h.actions, ['strip']);
    assert.equal(h.sessionStorage.getItem(keys.pending), null); assert.equal(h.calls.length, 1);
  }
});

test('equivalent origin and /mcp inputs reuse only the exact bound redirect registration', async () => {
  const h = setup(); await h.client.connect();
  const sameWorker = createComposioClient(`${WORKER}/mcp`, h.options);
  await sameWorker.connect(); assert.equal(h.calls.length, 1);
  h.location.href = 'https://prism.test/different/'; await sameWorker.connect(); assert.equal(h.calls.length, 2);
  assert.equal(h.pending().redirectUri, h.location.href); assert.equal(h.pending().workerURL, WORKER);
});

test('disconnect prevents delayed registration or code exchange from resurrecting credentials', async () => {
  for (const endpoint of [REGISTER, TOKEN]) {
    const started = deferred(), release = deferred();
    const h = setup({ handler: async (url, _options, body) => {
      if (url !== endpoint) return;
      started.resolve(); await release.promise;
      return endpoint === REGISTER ? json({ client_id: 'public-client', redirect_uris: body.redirect_uris }) : tokenReply();
    } });
    let operation;
    if (endpoint === TOKEN) { await h.client.connect(); h.callback(); operation = h.client.finishLogin(); }
    else operation = h.client.connect();
    await started.promise; h.client.disconnect(); await assert.rejects(operation, { name: 'AbortError' });
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.localStorage.getItem(keys.tokens), null); assert.equal(h.localStorage.getItem(keys.client), null);
    assert.equal(h.sessionStorage.getItem(keys.pending), null); assert.deepEqual(h.client.status(), { connected: false });
    assert.equal(h.location.assigned === null || endpoint === TOKEN, true);
  }
});
