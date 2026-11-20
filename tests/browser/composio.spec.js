import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Intentionally use the existing preview; never launch a server or contact live services.
const BASE = 'http://127.0.0.1:3000';
const WORKER = 'https://worker.example.com';
const RESOURCE = 'https://connect.composio.dev/mcp';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI = 'https://api.openai.com/v1';
const PREFIX = 'prism.composio.worker.';
const TOOL = 'GMAIL_LIST_MESSAGES';
const TOOL_ARGS = { query: 'fixture-only' };
const MODEL = { name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] };
const geminiReply = text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const openAIReply = text => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const tool = { name: TOOL, description: 'List fixture messages', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };

// Defense in depth: even a missed mock cannot send a live registration, login,
// deployment, model request, or MCP operation. Same-origin static assets only.
test.beforeEach(async ({ context, page }) => {
  page.externalAttempts = [];
  page.appErrors = [];
  page.on('pageerror', error => page.appErrors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === BASE) return route.continue();
    if (url.origin === 'https://cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body: '' });
    page.externalAttempts.push({ url: url.href, method: route.request().method() });
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(page.externalAttempts, 'all external traffic must be explicitly mocked').toEqual([]);
  expect(page.appErrors).toEqual([]);
});

async function ready(page) { await expect(page.locator('#api-protocol-gemini')).toBeEnabled(); }
async function settings(page, tab = 'tools') {
  await ready(page);
  if (!await page.locator('#settings-dialog').isVisible()) await page.locator('#toggle-settings').click();
  await page.locator(`#settings-tab-${tab}`).click();
}
async function saved(page) {
  return page.evaluate(async () => (await import('/storage.js')).createStore().load());
}
function cachedSettings(protocol = 'gemini', extra = {}) {
  return { protocol, modelsProtocol: protocol, endpoint: protocol === 'openai' ? OPENAI : GEMINI,
    key: 'fixture-model-key', model: protocol === 'openai' ? 'chat-fixture' : MODEL.name,
    models: protocol === 'openai' ? [{ name: 'chat-fixture', displayName: 'Fixture model' }] : [MODEL],
    system: '', artefactMode: 'on', search: false, notion: false,
    composioWorkerURL: WORKER, composioEnabled: false, ...extra };
}
async function seed(page, { settings: preferences = cachedSettings(), tokens = false, expired = false, pending = null, notion = false, legacy = false } = {}) {
  await page.goto(`${BASE}/favicon.svg`);
  await page.evaluate(async ({ preferences, tokens, expired, pending, notion, legacy, worker, prefix }) => {
    await (await import('/storage.js')).createStore().save({ version: 1, settings: preferences, conversations: [] });
    if (tokens || pending) localStorage.setItem(prefix + 'client', JSON.stringify({ workerURL: worker, clientId: 'fixture-public-client', redirectUri: location.origin + '/' }));
    if (tokens) localStorage.setItem(prefix + 'tokens', JSON.stringify({ workerURL: worker, accessToken: 'fixture-composio-access', refreshToken: 'fixture-composio-refresh', expiresAt: Date.now() + (expired ? -1000 : 3600000) }));
    if (pending) sessionStorage.setItem(prefix + 'pending', JSON.stringify(pending));
    if (notion) {
      localStorage.setItem('prism.notion.client', JSON.stringify({ clientId: 'fixture-notion-client', redirectUri: location.origin + '/' }));
      localStorage.setItem('prism.notion.tokens', JSON.stringify({ accessToken: 'fixture-notion-access', refreshToken: 'fixture-notion-refresh', expiresAt: Date.now() + 3600000 }));
    }
    if (legacy) {
      for (const suffix of ['client', 'tokens']) localStorage.setItem('prism.composio.' + suffix, 'retired-secret');
      sessionStorage.setItem('prism.composio.pending', 'retired-pending');
    }
  }, { preferences, tokens, expired, pending, notion, legacy, worker: WORKER, prefix: PREFIX });
}
async function mockWorker(page, { sse = false, refreshed = false } = {}) {
  const records = { register: [], authorize: [], token: [], mcp: [], calls: [] };
  await page.route(`${WORKER}/oauth/register`, route => {
    const body = route.request().postDataJSON(); records.register.push(body);
    expect(body).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [BASE + '/'], grant_types: ['authorization_code', 'refresh_token'] });
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ json: { client_id: 'fixture-public-client', token_endpoint_auth_method: 'none' } });
  });
  await page.route('https://connect.composio.dev/oauth/authorize?*', route => {
    const url = new URL(route.request().url()); records.authorize.push(Object.fromEntries(url.searchParams));
    expect(route.request().method()).toBe('GET');
    expect(url.searchParams.get('resource')).toBe(RESOURCE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(url.searchParams.get('state')).toHaveLength(43);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'fixture-authorization-code');
    callback.searchParams.set('state', url.searchParams.get('state'));
    // No iss is valid for Composio's optional authorization-response issuer.
    return route.fulfill({ status: 302, headers: { location: callback.href }, body: '' });
  });
  await page.route(`${WORKER}/oauth/token`, route => {
    const body = Object.fromEntries(new URLSearchParams(route.request().postData())); records.token.push(body);
    expect(body.resource).toBe(RESOURCE);
    expect(body.client_secret).toBeUndefined();
    expect(route.request().headers().authorization).toBeUndefined();
    if (body.grant_type === 'authorization_code') {
      expect(body.code_verifier).toHaveLength(43);
      expect(body.redirect_uri).toBe(BASE + '/');
      expect(body.code).toBe('fixture-authorization-code');
    } else {
      expect(body.grant_type).toBe('refresh_token');
      expect(body.refresh_token).toBe('fixture-composio-refresh');
    }
    return route.fulfill({ json: { access_token: refreshed ? 'fixture-refreshed-access' : 'fixture-composio-access', refresh_token: 'fixture-composio-refresh', expires_in: 3600, token_type: 'Bearer' } });
  });
  await page.route(`${WORKER}/mcp`, route => {
    const request = route.request(), body = request.postDataJSON(); records.mcp.push(body);
    expect(request.headers().authorization).toBe(`Bearer ${refreshed ? 'fixture-refreshed-access' : 'fixture-composio-access'}`);
    expect(request.headers()['x-goog-api-key']).toBeUndefined();
    expect(request.postData()).not.toContain('fixture-model-key');
    if (body.method === 'initialize') return route.fulfill({ headers: { 'mcp-session-id': 'fixture-composio-session', 'access-control-expose-headers': 'mcp-session-id' }, json: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } } });
    expect(request.headers()['mcp-session-id']).toBe('fixture-composio-session');
    expect(request.headers()['mcp-protocol-version']).toBe('2025-03-26');
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    let result;
    if (body.method === 'tools/list') result = { tools: [tool] };
    else {
      expect(body.method).toBe('tools/call'); records.calls.push(body.params);
      result = { content: [{ type: 'text', text: 'Fixture action completed; echoed fixture-composio-access is redacted.' }] };
    }
    const rpc = { jsonrpc: '2.0', id: body.id, result };
    return sse ? route.fulfill({ contentType: 'text/event-stream', body: `: heartbeat\n\nevent: message\ndata: ${JSON.stringify(rpc)}\n\n` }) : route.fulfill({ json: rpc });
  });
  return records;
}
async function restored(page, options = {}) {
  const records = await mockWorker(page, options);
  await seed(page, { tokens: true, ...options });
  await page.goto(BASE);
  await settings(page);
  await expect(page.locator('#composio-status')).toContainText('Connected · 1 tools');
  return records;
}
async function send(page, text = 'Perform a fixture action') {
  if (await page.locator('#settings-dialog').isVisible()) await page.locator('#close-settings').click();
  await page.locator('#message-input').fill(text);
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model').last()).toBeVisible();
  await expect(page.locator('#stop-button')).toBeHidden();
}
function pending(workerURL = WORKER, state = 's'.repeat(43)) {
  return { workerURL, state, verifier: 'v'.repeat(43), redirectUri: BASE + '/', clientId: 'fixture-public-client', createdAt: Date.now(), issuer: 'https://connect.composio.dev', resource: RESOURCE };
}

test('Tools settings expose a public deploy link; URL typing and config-only restoration are inert', async ({ page }) => {
  await page.goto(BASE); await settings(page);
  const link = page.locator('#deploy-composio-worker');
  const target = new URL(await link.getAttribute('href'));
  expect(target.origin).toBe('https://deploy.workers.cloudflare.com');
  const repository = new URL(target.searchParams.get('url'));
  expect(repository.origin).toBe('https://github.com');
  expect(repository.pathname).toBe('/radianceskills-dev/prism-composio-worker');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(page.locator('#parallel-search')).toBeVisible();
  await expect(page.locator('#connect-notion')).toBeVisible();
  await page.locator('#composio-worker-url').fill(WORKER + '/mcp');
  await expect.poll(async () => (await saved(page)).settings.composioWorkerURL).toBe(WORKER + '/mcp');
  await page.reload(); await settings(page);
  await expect(page.locator('#composio-worker-url')).toHaveValue(WORKER);
  await expect(page.locator('#composio-enabled')).toBeDisabled();
});

test('invalid Worker URLs fail locally without fetch or navigation', async ({ page }) => {
  await page.goto(BASE); await settings(page);
  for (const url of ['http://worker.example.com', 'https://worker.example.test', 'https://worker.local', 'https://127.0.0.2', 'https://worker.example.com/mcp?secret=x', 'https://user:password@worker.example.com']) {
    await page.locator('#composio-worker-url').fill(url);
    await page.locator('#connect-composio').click();
    await expect(page.locator('#composio-status')).toContainText('valid HTTPS Worker');
    expect(page.url()).toBe(BASE + '/');
  }
});

test('Connect registers a public PKCE client, navigates only official auth, and exchanges code through Worker', async ({ page }) => {
  const records = await mockWorker(page);
  await page.goto(BASE); await settings(page);
  await page.locator('#composio-worker-url').fill(WORKER + '/mcp');
  await page.locator('#connect-composio').click();
  await expect(page.locator('#composio-status')).toContainText('Connected · 1 tools');
  expect(page.url()).toBe(BASE + '/');
  expect(records.register).toHaveLength(1); expect(records.authorize).toHaveLength(1); expect(records.token).toHaveLength(1);
  await expect(page.locator('#composio-enabled')).not.toBeChecked();
  const stored = await page.evaluate(prefix => ({ client: JSON.parse(localStorage.getItem(prefix + 'client')), tokens: JSON.parse(localStorage.getItem(prefix + 'tokens')), pending: sessionStorage.getItem(prefix + 'pending') }), PREFIX);
  expect(stored.client.workerURL).toBe(WORKER); expect(stored.tokens.workerURL).toBe(WORKER); expect(stored.pending).toBeNull();
});

test('expired saved credentials refresh with canonical resource before MCP initialization', async ({ page }) => {
  const records = await restored(page, { expired: true, refreshed: true });
  expect(records.register).toEqual([]); expect(records.authorize).toEqual([]);
  expect(records.token).toHaveLength(1);
  expect(records.token[0].grant_type).toBe('refresh_token');
  expect(records.mcp.map(body => body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
});

test('SSE tools use the negotiated session; checked opt-in survives refresh, reload and legacy cleanup', async ({ page }) => {
  const records = await restored(page, { sse: true, legacy: true });
  await page.locator('#composio-enabled').check();
  await expect.poll(async () => (await saved(page)).settings.composioEnabled).toBe(true);
  await page.locator('#refresh-composio').click();
  await expect(page.locator('#composio-status')).toContainText('Connected · 1 tools');
  await page.reload(); await settings(page);
  await expect(page.locator('#composio-enabled')).toBeChecked();
  await expect(page.locator('#composio-worker-url')).toHaveValue(WORKER);
  expect(records.register).toEqual([]); expect(records.token).toEqual([]); expect(records.calls).toEqual([]);
  expect(await page.evaluate(() => [localStorage.getItem('prism.composio.client'), localStorage.getItem('prism.composio.tokens'), sessionStorage.getItem('prism.composio.pending')])).toEqual([null, null, null]);
});

for (const protocol of ['gemini', 'openai']) {
  test(`${protocol} executes composio_tool automatically, redacts OAuth, and audits provider identity`, async ({ page }) => {
    const bodies = [];
    const records = await restored(page, { settings: cachedSettings(protocol) });
    await page.locator('#composio-enabled').check();
    const endpoint = protocol === 'gemini' ? `${GEMINI}/models/*:generateContent` : `${OPENAI}/chat/completions`;
    await page.route(endpoint, route => {
      const raw = route.request().postData(); expect(raw).not.toContain('fixture-composio'); expect(raw).not.toContain(WORKER);
      const body = route.request().postDataJSON(); bodies.push(body);
      if (bodies.length === 1) {
        const declarations = protocol === 'gemini' ? body.tools.flatMap(group => group.functionDeclarations) : body.tools.map(item => item.function);
        expect(declarations.map(item => item.name)).toContain('composio_tool');
        const args = { name: TOOL, arguments_json: JSON.stringify(TOOL_ARGS) };
        return route.fulfill({ json: protocol === 'gemini' ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'composio_tool', args }, thoughtSignature: 'fixture-signature' }] } }] } : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'composio_tool', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] } });
      }
      expect(raw).toContain('[REDACTED]');
      return route.fulfill({ json: protocol === 'gemini' ? geminiReply('Fixture action complete.') : openAIReply('Fixture action complete.') });
    });
    await send(page);
    await expect(page.locator('.message.model')).toContainText('Fixture action complete');
    expect(records.calls).toEqual([{ name: TOOL, arguments: TOOL_ARGS }]);
    expect(bodies).toHaveLength(2);
    await expect(page.locator('#tool-approval')).toHaveCount(0);
    await page.locator('#tool-audit summary').click();
    await expect(page.locator('#tool-audit')).toContainText('Composio');
    await expect.poll(async () => (await saved(page)).conversations[0].audit[0].provider).toBe('composio');
  });
}

test('editing Worker disables old tools immediately and never sends saved credentials to the new origin', async ({ page }) => {
  const records = await restored(page);
  await page.locator('#composio-enabled').check();
  await page.locator('#composio-worker-url').fill('https://different.example.com');
  await expect(page.locator('#composio-enabled')).not.toBeChecked();
  await expect(page.locator('#composio-enabled')).toBeDisabled();
  await expect(page.locator('#refresh-composio')).toBeHidden();
  await page.route(`${GEMINI}/models/*:generateContent`, route => {
    const body = route.request().postDataJSON();
    expect(body.tools.flatMap(group => group.functionDeclarations).map(item => item.name)).toEqual(['prism_help']);
    return route.fulfill({ json: geminiReply('No connected app tools offered.') });
  });
  await send(page, 'Do not send old credentials');
  await expect.poll(async () => (await saved(page)).settings.composioWorkerURL).toBe('https://different.example.com');
  await page.reload(); await settings(page);
  await expect(page.locator('#composio-status')).toContainText('binding does not match');
  expect(records.mcp).toHaveLength(3); expect(records.calls).toEqual([]);
});

test('Composio opt-in and Disconnect leave Notion credentials, Notion opt-in and Parallel independent', async ({ page }) => {
  await page.route('https://mcp.notion.com/mcp', route => {
    const body = route.request().postDataJSON();
    expect(route.request().headers().authorization).toBe('Bearer fixture-notion-access');
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools: [{ ...tool, name: 'notion-fixture' }] } } });
  });
  await restored(page, { notion: true, settings: cachedSettings('gemini', { search: true, notion: true }) });
  await page.locator('#composio-enabled').check();
  await page.evaluate(prefix => sessionStorage.setItem(prefix + 'pending', JSON.stringify({ workerURL: 'https://worker.example.com', state: 'unused' })), PREFIX);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#disconnect-composio').click();
  await expect(page.locator('#composio-status')).toContainText('Disconnected locally');
  await expect(page.locator('#notion-enabled')).toBeChecked();
  await expect(page.locator('#parallel-search')).toBeChecked();
  expect(await page.evaluate(prefix => ({ keys: [localStorage.getItem(prefix + 'client'), localStorage.getItem(prefix + 'tokens'), sessionStorage.getItem(prefix + 'pending')], notion: JSON.parse(localStorage.getItem('prism.notion.tokens')).accessToken }), PREFIX)).toEqual({ keys: [null, null, null], notion: 'fixture-notion-access' });
});

test('exports omit OAuth and Worker configuration; Clear all removes every new Composio key', async ({ page }) => {
  await restored(page);
  await page.locator('#composio-enabled').check();
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Safe exported fixture draft');
  await settings(page, 'data');
  const waiting = page.waitForEvent('download');
  await page.locator('#export-all').click();
  const downloaded = await waiting;
  const text = await readFile(await downloaded.path(), 'utf8');
  expect(text).toContain('Safe exported fixture draft');
  for (const secret of ['fixture-composio', 'fixture-model-key', WORKER, 'composioWorkerURL', 'composioEnabled', 'fixture-public-client']) expect(text).not.toContain(secret);
  await page.evaluate(prefix => sessionStorage.setItem(prefix + 'pending', JSON.stringify({ workerURL: 'https://worker.example.com', state: 'unused' })), PREFIX);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-data').click(); await ready(page);
  await expect(page.locator('#composio-worker-url')).toHaveValue('');
  expect(await page.evaluate(prefix => [localStorage.getItem(prefix + 'client'), localStorage.getItem(prefix + 'tokens'), sessionStorage.getItem(prefix + 'pending')], PREFIX)).toEqual([null, null, null]);
});

test('exact callback state selects Composio even when Notion also has a pending login', async ({ page }) => {
  const records = await mockWorker(page);
  await seed(page, { pending: pending() });
  await page.evaluate(() => sessionStorage.setItem('prism.notion.pending', JSON.stringify({ state: 'n'.repeat(43), verifier: 'w'.repeat(43), createdAt: Date.now() })));
  await page.goto(`${BASE}/?code=fixture-authorization-code&state=${'s'.repeat(43)}`);
  await expect(page.locator('#composio-status')).toContainText('Connected · 1 tools');
  expect(records.token).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('prism.notion.pending')).state)).toBe('n'.repeat(43));
  expect(page.url()).toBe(BASE + '/');
});

test('exact callback state selects Notion without consuming a simultaneous Composio login', async ({ page }) => {
  const records = await mockWorker(page);
  await seed(page, { pending: pending() });
  await page.evaluate(() => {
    localStorage.setItem('prism.notion.client', JSON.stringify({ clientId: 'fixture-notion-client', redirectUri: location.origin + '/' }));
    sessionStorage.setItem('prism.notion.pending', JSON.stringify({ state: 'n'.repeat(43), verifier: 'w'.repeat(43), redirectUri: location.origin + '/', clientId: 'fixture-notion-client', createdAt: Date.now() }));
  });
  await page.route('https://mcp.notion.com/token', route => route.fulfill({ json: { access_token: 'fixture-notion-access', expires_in: 3600, token_type: 'Bearer' } }));
  await page.route('https://mcp.notion.com/mcp', route => {
    const body = route.request().postDataJSON();
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools: [] } } });
  });
  await page.goto(`${BASE}/?code=notion-code&state=${'n'.repeat(43)}&iss=https%3A%2F%2Fmcp.notion.com`);
  await expect(page.locator('#notion-status')).toContainText('Connected · 0 tools');
  expect(records.token).toEqual([]);
  expect(await page.evaluate(prefix => JSON.parse(sessionStorage.getItem(prefix + 'pending')).state, PREFIX)).toBe('s'.repeat(43));
  expect(page.url()).toBe(BASE + '/');
});

test('malformed or changed Worker callbacks are scrubbed without exchanging any authorization code', async ({ page }) => {
  const records = await mockWorker(page);
  for (const [workerURL, state, fragment] of [[WORKER, 'wrong-state', ''], ['https://different.example.com', 's'.repeat(43), ''], ['not a URL', 's'.repeat(43), ''], [WORKER, 's'.repeat(43), '#code=fragment-code']]) {
    await seed(page, { settings: cachedSettings('gemini', { composioWorkerURL: workerURL }), pending: pending() });
    await page.goto(`${BASE}/?code=never-exchange&state=${state}${fragment}`); await ready(page);
    await expect(page).toHaveURL(BASE + '/');
    await expect(page.locator('#composio-enabled')).not.toBeChecked();
    expect(records.token).toEqual([]); expect(records.mcp).toEqual([]);
  }
});

test('untrusted model artefact cannot read OAuth storage or send Worker/provider requests', async ({ page }) => {
  const records = await restored(page);
  const html = `<!doctype html><html><body><output id="result">pending</output><script>
    let blocked = false; try { localStorage.getItem('prism.composio.worker.tokens'); } catch { blocked = true; }
    let parentBlocked = false; try { parent.parent.localStorage.getItem('prism.composio.worker.tokens'); } catch { parentBlocked = true; }
    Promise.all(['${WORKER}/oauth/token', '${WORKER}/mcp', '${GEMINI}/models', '${OPENAI}/chat/completions'].map(url => fetch(url, { method: 'POST', body: 'untrusted' }).then(() => 'allowed', () => 'blocked'))).then(results => { document.querySelector('#result').textContent = JSON.stringify({ blocked, parentBlocked, results }); });
  </script></body></html>`;
  let modelRequests = 0;
  await page.route(`${GEMINI}/models/*:generateContent`, route => { modelRequests++; return route.fulfill({ json: geminiReply(`<artefact title="Isolated fixture">${html}</artefact>`) }); });
  await send(page, 'Show an isolated fixture');
  const card = page.locator('.artefact-card');
  await expect(card.locator('.artefact-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  const runtime = card.frameLocator('.artefact-frame').frameLocator('iframe');
  await expect(runtime.locator('#result')).toHaveText(JSON.stringify({ blocked: true, parentBlocked: true, results: ['blocked', 'blocked', 'blocked', 'blocked'] }));
  expect(modelRequests).toBe(1); expect(records.mcp).toHaveLength(3); expect(records.token).toEqual([]);
});

test('clean Tools UI fits desktop and mobile with safe synthetic configuration', async ({ page }) => {
  await restored(page);
  await page.locator('#composio-enabled').check();
  for (const [width, height, name] of [[1440, 1100, 'desktop'], [390, 844, 'mobile']]) {
    await page.setViewportSize({ width, height });
    await page.locator('#composio-worker-url').scrollIntoViewIfNeeded();
    await expect(page.locator('#composio-worker-url')).toBeVisible();
    const geometry = await page.locator('#composio-worker-url').evaluate(input => {
      const box = input.getBoundingClientRect(), dialog = document.querySelector('#settings-dialog').getBoundingClientRect();
      return { left: box.left, right: box.right, dialogLeft: dialog.left, dialogRight: dialog.right, pageWidth: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.dialogLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.dialogRight);
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
    await page.screenshot({ path: `artifacts/prism-composio-${name}.png`, fullPage: true, animations: 'disabled' });
  }
});
