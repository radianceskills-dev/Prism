import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from '../../server.mjs';
let server, base;
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MCP = 'https://mcp.notion.com/mcp';
const toolName = 'notion-update-page';
const args = { page_id: '00000000-0000-4000-8000-000000000001', properties: { title: 'Mock page update' } };
const reply = text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const toolReply = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'notion_tool', args: { name: toolName, arguments_json: JSON.stringify(args) } }, thoughtSignature: 'preserve-this' }] } }] };
test.beforeAll(async () => {
  server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function setup(page, { toolCount = 1 } = {}) {
  const calls = [], errors = [], modelBodies = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${API}/models?*`, route => route.fulfill({ json: { models: [{ name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] }] } }));
  await page.route('https://mcp.notion.com/register', route => {
    const body = route.request().postDataJSON();
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.redirect_uris).toEqual([base + '/']);
    return route.fulfill({ json: { client_id: 'public-browser-client', token_endpoint_auth_method: 'none' } });
  });
  await page.route('https://mcp.notion.com/authorize?*', route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(MCP);
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'single-use-code');
    callback.searchParams.set('iss', 'https://mcp.notion.com');
    callback.searchParams.set('state', url.searchParams.get('state'));
    return route.fulfill({ status: 302, headers: { location: callback.href }, body: '' });
  });
  await page.route('https://mcp.notion.com/token', route => {
    const body = new URLSearchParams(route.request().postData());
    expect(body.get('code_verifier')).toHaveLength(43);
    expect(body.get('client_secret')).toBeNull();
    expect(body.get('resource')).toBe(MCP);
    return route.fulfill({ json: { access_token: 'private-notion-access', refresh_token: 'private-notion-refresh', expires_in: 3600, token_type: 'Bearer' } });
  });
  await page.route(MCP, route => {
    const request = route.request(), body = request.postDataJSON();
    expect(request.headers().authorization).toBe('Bearer private-notion-access');
    expect(request.headers()['x-goog-api-key']).toBeUndefined();
    expect(request.postData()).not.toContain('personal-gemini-key');
    if (body.method === 'initialize') return route.fulfill({ headers: { 'mcp-session-id': 'notion-session', 'access-control-expose-headers': 'mcp-session-id' }, json: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } } });
    expect(request.headers()['mcp-session-id']).toBe('notion-session');
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    if (body.method === 'tools/list') return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { tools: Array.from({ length: toolCount }, (_, index) => ({ name: index ? `${toolName}_${index}` : toolName, description: 'Update a Notion page', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, properties: { type: 'object' } }, required: ['page_id', 'properties'] } })) } } });
    expect(body.method).toBe('tools/call'); calls.push(body.params);
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Mock action completed. <img src=x onerror=alert(1)>' }] } } });
  });
  let generation = 0;
  await page.route(`${API}/models/*:generateContent`, route => {
    const raw = route.request().postData();
    expect(raw).not.toContain('private-notion');
    const body = route.request().postDataJSON(); modelBodies.push(body);
    if (++generation % 2 === 1) return route.fulfill({ json: toolReply });
    const result = body.contents.at(-1).parts[0].functionResponse.response;
    expect(body.contents.at(-2).parts[0].thoughtSignature).toBe('preserve-this');
    return route.fulfill({ json: reply(result.error ? 'The action was not run.' : 'The mock action completed.') });
  });
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  await page.locator('#api-key').fill('personal-gemini-key');
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#settings-tab-tools').click();
  await page.locator('#connect-notion').click();
  await expect(page.locator('#notion-status')).toContainText(`Connected · ${toolCount} tools`);
  expect(page.url()).toBe(base + '/');
  await expect(page.locator('#api-key')).toHaveValue('personal-gemini-key');
  await expect(page.locator('#notion-enabled')).not.toBeChecked();
  await page.locator('#notion-enabled').check();
  await page.locator('#close-settings').click();
  return { calls, errors, modelBodies };
}

test('OAuth login, automatic tools, chat persistence, export without credentials and local clearing', async ({ page }) => {
  const { calls, errors } = await setup(page);
  await page.locator('#message-input').fill('Perform the mock app action');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toContainText('mock action completed');
  await expect(page.locator('#tool-approval')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/prism-notion.png', fullPage: true, animations: 'disabled' });
  await expect(page.locator('#send-button')).toBeDisabled();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-data').click();
  await expect(page.locator('#storage-status')).toContainText('Saved');
  expect(calls).toEqual([{ name: toolName, arguments: args }]);
  await page.reload();
  await expect(page.locator('#notion-status')).toContainText('Connected · 1 tools');
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#notion-enabled')).toBeChecked();
  await page.locator('#close-settings').click();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.message.model')).toContainText('mock action completed');
  expect(calls).toHaveLength(1); // Restoring a chat never replays a tool.
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#new-chat').click();
  await expect(page.locator('.message')).toHaveCount(0);
  await page.locator('#saved-chats .conversation-item').first().click();
  await expect(page.locator('.message')).toHaveCount(2);
  const downloadWait = page.waitForEvent('download');
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-data').click();
  await page.locator('#export-all').click();
  const download = await downloadWait;
  const exported = await readFile(await download.path(), 'utf8');
  expect(exported).toContain('Perform the mock app action');
  expect(exported).not.toContain('personal-gemini-key');
  expect(exported).not.toContain('private-notion');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-data').click();
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('.message')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('prism.notion.tokens'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('prism.notion.pending'))).toBeNull();
  expect(errors).toEqual([]);
});

test('Notion catalogs over 64 tools support more than six automatic calls', async ({ page }) => {
  const { calls, errors } = await setup(page, { toolCount: 100 });
  await page.unroute(`${API}/models/*:generateContent`);
  let generations = 0;
  await page.route(`${API}/models/*:generateContent`, route => {
    const body = route.request().postDataJSON();
    expect(body.toolConfig.functionCallingConfig.mode).toBe('AUTO');
    const wrapper = body.tools[0].functionDeclarations.find(tool => tool.name === 'notion_tool');
    expect(wrapper.parameters.properties.name.enum).toHaveLength(100);
    expect(wrapper.parameters.properties.name.enum).toContain(`${toolName}_99`);
    if (++generations > 8) return route.fulfill({ json: reply('All eight mock actions completed.') });
    const next = structuredClone(toolReply);
    next.candidates[0].content.parts[0].functionCall.args.name = `${toolName}_99`;
    next.candidates[0].content.parts[0].functionCall.args.arguments_json = JSON.stringify({ ...args, properties: { title: `Mock page update ${generations}` } });
    return route.fulfill({ json: next });
  });
  await page.locator('#message-input').fill('Perform eight mock actions');
  await page.locator('#send-button').click();
  // No further user interaction: every valid requested action completes automatically.
  await expect(page.locator('.message.model')).toContainText('All eight mock actions completed.');
  expect(calls).toHaveLength(8);
  await expect(page.locator('#tool-approval')).toHaveCount(0);
  expect(generations).toBe(9);
  expect(calls.every(call => call.name === `${toolName}_99`)).toBe(true);
  expect(errors).toEqual([]);
});

test('disabling Notion removes declarations and prevents automatic actions', async ({ page }) => {
  const { calls, modelBodies } = await setup(page);
  await page.locator('#message-input').fill('Try a mock action');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toContainText('mock action completed');
  expect(calls).toHaveLength(1);
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await page.locator('#notion-enabled').uncheck();
  await page.locator('#close-settings').click();
  await page.unroute(`${API}/models/*:generateContent`);
  await page.route(`${API}/models/*:generateContent`, route => {
    expect(route.request().postDataJSON().tools.flatMap(group => group.functionDeclarations).map(tool => tool.name)).toEqual(['prism_help']);
    return route.fulfill({ json: reply('Tools are disabled.') });
  });
  await page.locator('#message-input').fill('No tools now');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model').last()).toContainText('disabled');
  expect(modelBodies[0].tools[0].functionDeclarations.some(tool => tool.name === 'notion_tool')).toBe(true);
  expect(calls).toHaveLength(1);
});

test('forged OAuth callback is scrubbed and fails closed without token exchange', async ({ page }) => {
  let tokenCalls = 0;
  await page.route('https://mcp.notion.com/**', route => { tokenCalls++; return route.abort(); });
  await page.goto(`${base}/?code=forged-code&state=wrong&iss=https%3A%2F%2Fmcp.notion.com`);
  await expect(page.locator('#notion-status')).toContainText('Invalid or already handled');
  expect(page.url()).toBe(base + '/');
  expect(tokenCalls).toBe(0);
  await expect(page.locator('#notion-enabled')).toBeDisabled();
});

for (const issuer of [null, 'https://wrong-issuer.example']) {
  test(`OAuth callback with ${issuer ? 'wrong' : 'missing'} issuer fails closed despite valid pending state`, async ({ page }) => {
    let tokenCalls = 0;
    await page.route('https://mcp.notion.com/token', route => { tokenCalls++; return route.abort(); });
    await page.goto(base + '/favicon.svg');
    await page.evaluate(() => {
      const state = 's'.repeat(43);
      localStorage.setItem('prism.notion.client', JSON.stringify({ clientId: 'public-browser-client', redirectUri: location.origin + '/' }));
      sessionStorage.setItem('prism.notion.pending', JSON.stringify({ state, verifier: 'v'.repeat(43), redirectUri: location.origin + '/', clientId: 'public-browser-client', createdAt: Date.now() }));
    });
    const callback = new URL(base);
    callback.searchParams.set('code', 'forged-code');
    callback.searchParams.set('state', 's'.repeat(43));
    if (issuer) callback.searchParams.set('iss', issuer);
    await page.goto(callback.href);
    await expect(page.locator('#notion-status')).toContainText('invalid');
    expect(page.url()).toBe(base + '/');
    expect(tokenCalls).toBe(0);
    expect(await page.evaluate(() => sessionStorage.getItem('prism.notion.pending'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('prism.notion.tokens'))).toBeNull();
    await expect(page.locator('#notion-enabled')).toBeDisabled();
  });
}

test('Stop during automatic execution warns about unknown outcome without replay', async ({ page }) => {
  const { modelBodies } = await setup(page);
  let pending;
  await page.route(MCP, route => {
    if (route.request().postDataJSON().method !== 'tools/call') return route.fallback();
    pending = route;
  });
  await page.locator('#message-input').fill('Automatic mock action');
  await page.locator('#send-button').click();
  await expect.poll(() => !!pending).toBe(true);
  await expect(page.locator('#tool-approval')).toHaveCount(0);
  await page.locator('#stop-button').click();
  await expect(page.locator('#chat-notice')).toContainText('outcome is unknown');
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.locator('#message-input')).toHaveValue('Automatic mock action');
  expect(modelBodies).toHaveLength(1);
  await pending.abort().catch(() => {});
  await page.reload();
  await page.locator('#tool-audit summary').click();
  await expect(page.locator('#tool-audit')).toContainText('Check');
  expect(modelBodies).toHaveLength(1);
});

test('disconnect removes Notion tokens and disables tools without deleting conversations', async ({ page }) => {
  const { calls } = await setup(page);
  await page.locator('#message-input').fill('Preserve this Notion draft');
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#disconnect-notion').click();
  await expect(page.locator('#notion-status')).toContainText('Disconnected locally');
  await expect(page.locator('#notion-enabled')).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('prism.notion.tokens'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('prism.notion.pending'))).toBeNull();
  expect(calls).toHaveLength(0);
  await page.locator('#close-settings').click();
  await expect(page.locator('#message-input')).toHaveValue('Preserve this Notion draft');
});

test('Tools settings preserve Parallel and Notion alongside Worker-based Composio, without retired Brave controls', async ({ page }) => {
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#parallel-search')).toBeVisible();
  await expect(page.locator('#connect-notion')).toBeVisible();
  await expect(page.locator('#connect-composio')).toBeVisible();
  await expect(page.locator('#composio-worker-url')).toBeVisible();
  await expect(page.locator('#deploy-composio-worker')).toHaveAttribute('href', /github.com%2Fradianceskills-dev%2Fprism-composio-worker/);
  await expect(page.locator('#search-provider, #brave-key, #brave-freshness, #brave-settings')).toHaveCount(0);
  await expect(page.locator('#settings-panel-tools')).not.toContainText(/Brave/i);
});

test('migration removes legacy credentials and preferences while preserving saved conversations', async ({ page }) => {
  // An inert same-origin asset lets us seed storage before the application runs.
  await page.goto(base + '/favicon.svg');
  await page.evaluate(async () => {
    const { createStore } = await import('/storage.js');
    await createStore().save({ version: 1, settings: {
      endpoint: 'https://generativelanguage.googleapis.com/v1beta', key: 'preserved-model-key',
      model: '', models: [], system: 'Preserved instructions', search: true,
      searchProvider: 'brave', braveKey: 'retired-brave-secret', braveFreshness: 'pd', composio: true,
    }, activeId: 'preserved-chat', conversations: [{
      id: 'preserved-chat', title: 'Keep this conversation', history: [{ role: 'user', parts: [{ text: 'Saved question' }] }],
      transcript: [{ role: 'You', text: 'Saved question' }], audit: [], draft: 'Saved draft',
    }] });
    localStorage.setItem('prism.composio.client', JSON.stringify({ clientId: 'retired-client', redirectUri: location.origin + '/' }));
    localStorage.setItem('prism.composio.tokens', JSON.stringify({ accessToken: 'retired-access', refreshToken: 'retired-refresh', expiresAt: Date.now() + 3600000 }));
    sessionStorage.setItem('prism.composio.pending', JSON.stringify({ state: 'retired-state', verifier: 'retired-verifier' }));
  });
  await page.goto(base);
  await expect(page.locator('.message.user')).toContainText('Saved question');
  await expect(page.locator('#message-input')).toHaveValue('Saved draft');
  await expect(page.locator('#saved-chats')).toContainText('Keep this conversation');
  await expect.poll(() => page.evaluate(async () => {
    const { createStore } = await import('/storage.js');
    const workspace = await createStore().load();
    return ['braveKey', 'braveFreshness', 'searchProvider', 'composio'].filter(key => Object.hasOwn(workspace.settings, key));
  })).toEqual([]);
  expect(await page.evaluate(() => ({ client: localStorage.getItem('prism.composio.client'), tokens: localStorage.getItem('prism.composio.tokens'), pending: sessionStorage.getItem('prism.composio.pending') }))).toEqual({ client: null, tokens: null, pending: null });
  await page.locator('#toggle-settings').click();
  await expect(page.locator('#api-key')).toHaveValue('preserved-model-key');
  await page.locator('#settings-tab-instructions').click();
  await expect(page.locator('#system-prompt')).toHaveValue('Preserved instructions');
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#parallel-search')).toBeChecked();
  await expect(page.locator('#notion-enabled')).not.toBeChecked();
});

test('blocked browser storage reports limitations without crashing Gemini setup', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['indexedDB', 'localStorage', 'sessionStorage']) Object.defineProperty(window, name, { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-data').click();
  await expect(page.locator('#storage-status')).toContainText('storage is unavailable');
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#notion-status')).toContainText('storage');
  await page.locator('#settings-tab-connection').click();
  await expect(page.locator('#api-key')).toBeEnabled();
  await page.locator('#api-key').fill('unsaved-key');
  await expect(page.locator('#fetch-models')).toBeEnabled();
  expect(errors).toEqual([]);
});
