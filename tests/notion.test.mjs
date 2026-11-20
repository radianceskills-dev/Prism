import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { createNotionClient } from '../notion.js';

const MCP = 'https://mcp.notion.com/mcp';
const TOKEN = 'https://mcp.notion.com/token';
const REGISTER = 'https://mcp.notion.com/register';
const keys = { client: 'prism.notion.client', tokens: 'prism.notion.tokens', pending: 'prism.notion.pending' };
const tool = { name: 'notion-search', description: 'Find tools', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
const access = 'private-access-token-opaque';
const refresh = 'private-refresh-token-opaque';
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } });
const rpc = (id, result, headers) => json({ jsonrpc: '2.0', id, result }, headers);
const tokenReply = extra => json({ token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600, ...extra });
function store() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
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
  const client = createNotionClient(options);
  const pending = () => JSON.parse(sessionStorage.getItem(keys.pending));
  const callback = (extra = {}) => {
    const state = pending()?.state ?? 'invalid';
    location.href = `https://prism.test/nested/index.html?${new URLSearchParams({ code: 'one-time-code-secret', state, iss: 'https://mcp.notion.com', ...extra })}`;
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
  assert.equal(url.origin + url.pathname, 'https://mcp.notion.com/authorize');
  assert.equal(url.searchParams.get('scope'), 'default');
  assert.equal(url.searchParams.get('resource'), MCP);
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
  const h = setup(); await h.client.connect(); const pending = h.pending(); h.callback({ iss: 'https://mcp.notion.com' });
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
  assert.deepEqual(createNotionClient(h.options).status(), { connected: true });
  assert.deepEqual(Object.keys(JSON.parse(h.localStorage.getItem(keys.tokens))).sort(), ['accessToken', 'expiresAt', 'refreshToken']);
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
    h => { h.callback(); const url = new URL(h.location.href); url.searchParams.delete('iss'); h.location.href = url.href; },
    h => h.callback({ iss: '' }),
    h => h.callback({ iss: 'https://mcp.notion.com/' }),
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
  const client = createNotionClient(options);
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
  for (const name of ['NotionError', 'AbortError']) {
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

test('Notion storage keys and OAuth token forms remain issuer-scoped', async () => {
  const h = setup();
  h.localStorage.setItem('prism.composio.tokens', 'unrelated');
  h.sessionStorage.setItem('prism.composio.pending', 'unrelated');
  await h.client.connect();
  assert.deepEqual([...h.sessionStorage.data.keys()].sort(), ['prism.composio.pending', 'prism.notion.pending']);
  h.callback(); await h.client.finishLogin();
  const exchange = h.calls.find(call => call.url === TOKEN);
  assert.equal(exchange.body.resource, MCP);
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
  assert.deepEqual([...h.localStorage.data.keys()], ['prism.composio.tokens']);
  assert.deepEqual([...h.sessionStorage.data.keys()], ['prism.composio.pending']);
});

test('Notion accepts 2025-03-26 lifecycle without an exposed session header', async () => {
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
  for (const mode of [401, 403, 429, 500, 302, 'rpc', 'network']) {
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
    await h.client.listTools(); await assert.rejects(h.client.callTool(tool.name, {}), /Notion/);
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
