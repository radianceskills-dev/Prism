import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

let server, base;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI = 'https://api.openai.com/v1';
const CUSTOM = 'https://gateway.example.test/v1';
const OTHER = 'https://second.example.test/v1';
const KEY = 'mock-openai-protocol-key';
const RAW_MODEL = 'org/model:free';
const GEMINI_MODEL = { name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] };
const OA_MODELS = [{ id: 'chat-small' }, { id: RAW_MODEL }, { id: RAW_MODEL }];
const HTML = '<!doctype html><html><body style="margin:0;padding:16px;min-height:120px"><button id="increment">Increment</button><output id="count">0</output><script>let n=0;document.querySelector("#increment").onclick=()=>document.querySelector("#count").textContent=String(++n);</script></body></html>';
const ARTEFACT = `<artefact title="Protocol counter">${HTML}</artefact>`;
const oaReply = text => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const geminiReply = text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const record = request => ({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() ? request.postDataJSON() : null });
const mode = (page, value) => page.locator(`#artefact-mode-switch button[data-mode="${value}"]`);
const childOf = card => card.frameLocator('.artefact-frame').frameLocator('iframe');

function modelsPattern(endpoint) {
  return new RegExp(`^${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/models(?:\\?.*)?$`);
}

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
});

async function openSettings(page, tab = 'connection') {
  if (!await page.locator('#settings-dialog').isVisible()) await page.locator('#toggle-settings').click();
  await page.locator(`#settings-tab-${tab}`).click();
}
async function closeSettings(page) {
  if (await page.locator('#settings-dialog').isVisible()) await page.locator('#close-settings').click();
}
async function ready(page) { await expect(page.locator('#api-protocol-gemini')).toBeEnabled(); }
async function saved(page) {
  return page.evaluate(async () => (await import('./storage.js')).createStore().load());
}
async function seed(page, settings, conversations = [], activeId) {
  await page.goto(base);
  await ready(page);
  await page.evaluate(async workspace => (await import('./storage.js')).createStore().save(workspace), { version: 1, settings, conversations, activeId });
  await page.reload();
  await ready(page);
}
async function twoFrames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function connect(page, { endpoint = OPENAI, protocol = 'openai', requests = [], key = KEY, navigate = true } = {}) {
  await page.route(modelsPattern(endpoint), async route => {
    requests.push(record(route.request()));
    await route.fulfill({ json: protocol === 'openai' ? { data: OA_MODELS } : { models: [GEMINI_MODEL] } });
  });
  if (navigate) await page.goto(base);
  await openSettings(page);
  await ready(page);
  await page.locator(`#api-protocol-${protocol}`).check();
  await page.locator('#endpoint').fill(endpoint);
  await page.locator('#api-key').fill(key);
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText(protocol === 'openai' ? '2 models available' : '1 model available');
  await expect(page.locator('#connection-status')).toBeHidden();
  if (protocol === 'openai') await page.locator('#model-select').selectOption(RAW_MODEL);
  await closeSettings(page);
  return requests;
}
async function send(page, text, count) {
  await page.locator('#message-input').fill(text);
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(count);
  await expect(page.locator('.thinking')).toHaveCount(0);
  await expect(page.locator('#stop-button')).toBeHidden();
}
function cachedSettings(protocol = 'openai', extra = {}) {
  return {
    protocol, endpoint: protocol === 'openai' ? OPENAI : GEMINI, key: KEY,
    model: protocol === 'openai' ? RAW_MODEL : GEMINI_MODEL.name,
    models: protocol === 'openai' ? [{ name: RAW_MODEL, displayName: RAW_MODEL }] : [GEMINI_MODEL],
    system: '', artefactMode: 'on', search: false, notion: false, ...extra,
  };
}

// Protocol is a connection-format choice, not an automatic network action.
test('fresh and legacy workspaces default to Gemini without automatically contacting a provider', async ({ page }) => {
  const network = [];
  page.on('request', request => { if (request.url().startsWith(GEMINI) || request.url().startsWith(OPENAI)) network.push(record(request)); });
  await page.goto(base);
  await openSettings(page);
  await ready(page);
  await expect(page.getByRole('group', { name: 'API format', exact: true })).toBeVisible();
  await expect(page.locator('#api-protocol input[type="radio"]')).toHaveCount(2);
  await expect(page.getByRole('radio', { name: 'Gemini', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'OpenAI-compatible', exact: true })).not.toBeChecked();
  await expect(page.locator('#endpoint')).toHaveValue(GEMINI);
  await expect(page.locator('#connection-card a')).toHaveCount(0);
  await closeSettings(page);
  const legacy = cachedSettings('gemini');
  delete legacy.protocol;
  await seed(page, legacy);
  await openSettings(page);
  await expect(page.locator('#api-protocol-gemini')).toBeChecked();
  await expect(page.locator('#model-select')).toHaveValue(GEMINI_MODEL.name);
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await expect.poll(async () => (await saved(page)).settings.protocol).toBe('gemini');
  await twoFrames(page);
  expect(network).toEqual([]);
});

test('OpenAI discovers raw model IDs with Bearer auth, sends multi-turn chat, and preserves safe Markdown and UI modes', async ({ page }) => {
  const discovery = [], chats = [];
  await page.route(`${OPENAI}/chat/completions`, async route => {
    chats.push(record(route.request()));
    await route.fulfill({ json: oaReply(chats.length === 1 ? '## Safe answer\n\n**Bold text**\n\n<img src=x onerror=window.protocolPwned=true>\n\n[Unsafe](javascript:alert(1))' : ARTEFACT) });
  });
  await connect(page, { requests: discovery });
  expect(discovery).toHaveLength(1);
  expect(discovery[0].method).toBe('GET');
  expect(discovery[0].url).toBe(`${OPENAI}/models`);
  expect(discovery[0].headers.authorization).toBe(`Bearer ${KEY}`);
  expect(discovery[0].headers['x-goog-api-key']).toBeUndefined();
  await openSettings(page);
  expect(await page.locator('#model-select option').evaluateAll(options => options.map(option => option.value))).toEqual(['chat-small', RAW_MODEL]);
  await page.locator('#settings-tab-instructions').click();
  await page.locator('#system-prompt').fill('Be concise and accessible.');
  await closeSettings(page);
  await send(page, 'First question', 1);
  expect(chats[0].method).toBe('POST');
  expect(chats[0].headers.authorization).toBe(`Bearer ${KEY}`);
  expect(chats[0].headers['x-goog-api-key']).toBeUndefined();
  expect(chats[0].body.model).toBe(RAW_MODEL);
  expect(chats[0].body.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('Be concise and accessible.') });
  expect(chats[0].body.messages[0].content).toContain('Prism can render interactive HTML artefacts');
  expect(chats[0].body.messages.at(-1)).toEqual({ role: 'user', content: 'First question' });
  await expect(page.locator('.message.model h2')).toHaveText('Safe answer');
  await expect(page.locator('.message.model .message-heading > strong')).toHaveText('Assistant');
  await expect(page.locator('.message.model .message-content strong')).toHaveText('Bold text');
  await expect(page.locator('.message.model img,.message.model script,.message.model a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.protocolPwned)).toBeUndefined();
  await send(page, 'Make a counter', 2);
  expect(chats[1].body.messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user', 'assistant', 'user']);
  expect(chats[1].body.messages[2].content).toContain('Safe answer');
  const card = page.locator('.message.model .artefact-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.artefact-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(childOf(card).locator('#count')).toHaveText('0');
  await mode(page, 'off').click();
  await expect(page.locator('.message.model iframe')).toHaveCount(0);
  expect(await page.locator('.message.model pre code.language-html').textContent()).toBe(HTML);
  await send(page, 'Show source only', 3);
  expect(chats[2].body.messages[0].content).toContain('Interactive UI is unavailable');
  await expect(page.locator('.message.model pre code.language-html')).toHaveCount(2);
  await expect(page.locator('.message.model iframe')).toHaveCount(0);
  const workspace = await saved(page);
  expect(workspace.settings.protocol).toBe('openai');
  expect(workspace.conversations[0].protocol).toBe('openai');
  expect(workspace.conversations[0].history[1].role).toBe('model');
  expect(workspace.conversations[0].history[1].parts[0].text).toContain('Safe answer');
});

test('OpenAI selection, key, raw cached model, draft and UI preference restore without model discovery or chat traffic', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  const network = [];
  page.on('request', request => { if (request.url().startsWith(OPENAI)) network.push(record(request)); });
  const chat = { id: 'cached-oa-chat', title: 'Existing OpenAI conversation', protocol: 'openai', endpoint: OPENAI, history: [], transcript: [], audit: [], draft: 'Keep this unsent draft' };
  await seed(page, cachedSettings('openai', { artefactMode: 'enforced' }), [chat], chat.id);
  await openSettings(page);
  await expect(page.locator('#api-protocol-openai')).toBeChecked();
  await expect(page.locator('#endpoint')).toHaveValue(OPENAI);
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await expect(page.locator('#model-select')).toHaveValue(RAW_MODEL);
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await expect(page.locator('#connection-status')).toBeHidden();
  await page.screenshot({ path: 'artifacts/prism-openai-settings.png', fullPage: true, animations: 'disabled' });
  await closeSettings(page);
  await expect(page.locator('#message-input')).toHaveValue(chat.draft);
  await expect(page.locator('#send-button')).toBeEnabled();
  await expect(mode(page, 'enforced')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await ready(page);
  await expect(page.locator('#message-input')).toHaveValue(chat.draft);
  await twoFrames(page);
  expect(network).toEqual([]);
});

test('changing API format clears credentials and model cache, preserves custom endpoints, and sends no automatic requests', async ({ page }) => {
  const discovery = [], network = [];
  page.on('request', request => { if (request.url().startsWith(CUSTOM)) network.push(record(request)); });
  await connect(page, { endpoint: CUSTOM, protocol: 'gemini', requests: discovery });
  expect(discovery[0].headers['x-goog-api-key']).toBe(KEY);
  expect(discovery[0].headers.authorization).toBeUndefined();
  expect(new URL(discovery[0].url).searchParams.get('pageSize')).toBe('100');
  await page.locator('#message-input').fill('Do not send this draft');
  await mode(page, 'enforced').click();
  await openSettings(page);
  await page.locator('#api-protocol-openai').check();
  await expect(page.locator('#endpoint')).toHaveValue(CUSTOM);
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('#model-select')).toBeDisabled();
  expect(await page.locator('#model-select option').evaluateAll(options => options.map(option => option.value))).toEqual(['']);
  await expect.poll(async () => (await saved(page)).settings.protocol).toBe('openai');
  expect((await saved(page)).settings.models).toEqual([]);
  expect((await saved(page)).settings.key).toBe('');
  await closeSettings(page);
  await expect(page.locator('#message-input')).toHaveValue('Do not send this draft');
  await expect(page.locator('#send-button')).toBeDisabled();
  await expect(mode(page, 'enforced')).toHaveAttribute('aria-checked', 'true');
  await openSettings(page);
  await page.locator('#api-protocol-gemini').check();
  await expect(page.locator('#endpoint')).toHaveValue(CUSTOM);
  await expect(page.locator('#api-key')).toHaveValue('');
  await twoFrames(page);
  expect(network).toHaveLength(1);
});

test('official or blank endpoints follow the API-format radios and Data key links follow the provider', async ({ page }) => {
  await page.goto(base);
  await openSettings(page);
  const gemini = page.getByRole('radio', { name: 'Gemini', exact: true });
  const openai = page.getByRole('radio', { name: 'OpenAI-compatible', exact: true });
  await expect(gemini).toBeChecked();
  await page.locator('#api-key').fill('old-google-key');
  await openai.check();
  await expect(page.locator('#endpoint')).toHaveValue(OPENAI);
  await expect(page.locator('#api-key')).toHaveValue('');
  await page.locator('#settings-tab-data').click();
  await expect(page.locator('#data-key-link')).toHaveAttribute('href', /platform\.openai\.com/);
  await expect(page.locator('#data-key-label')).toContainText('OpenAI');
  await page.locator('#settings-tab-connection').click();
  await gemini.check();
  await expect(page.locator('#endpoint')).toHaveValue(GEMINI);
  await page.locator('#settings-tab-data').click();
  await expect(page.locator('#data-key-link')).toHaveAttribute('href', /aistudio\.google\.com/);
  await expect(page.locator('#data-key-label')).toContainText('Gemini');
  await page.locator('#settings-tab-connection').click();
  await page.locator('#endpoint').fill('');
  await openai.check();
  await expect(page.locator('#endpoint')).toHaveValue(OPENAI);
  // A mistakenly pasted opposite official default should not survive switching.
  await page.locator('#endpoint').fill(GEMINI);
  await gemini.check();
  await expect(page.locator('#endpoint')).toHaveValue(GEMINI);
});

test('changing only API format at the same endpoint requires consent; cancellation keeps draft, acceptance converts canonical history', async ({ page }) => {
  const oaChats = [], geminiChats = [];
  await page.route(`${CUSTOM}/models/*:generateContent`, async route => {
    geminiChats.push(record(route.request()));
    await route.fulfill({ json: geminiReply('Earlier Gemini answer') });
  });
  await page.route(`${CUSTOM}/chat/completions`, async route => {
    oaChats.push(record(route.request()));
    await route.fulfill({ json: oaReply('Now using OpenAI format') });
  });
  await connect(page, { endpoint: CUSTOM, protocol: 'gemini' });
  await send(page, 'Earlier Gemini question', 1);
  // Old conversation records have no protocol field, even when connection
  // settings are subsequently migrated; those histories must remain Gemini.
  const legacyWorkspace = await saved(page);
  delete legacyWorkspace.conversations[0].protocol;
  await page.evaluate(async workspace => (await import('./storage.js')).createStore().save(workspace), legacyWorkspace);
  await page.reload();
  await ready(page);
  await connect(page, { endpoint: CUSTOM, protocol: 'openai', navigate: false });
  let rejectedMessage;
  page.once('dialog', async dialog => { rejectedMessage = dialog.message(); await dialog.dismiss(); });
  await page.locator('#message-input').fill('Continue across formats');
  await page.locator('#send-button').click();
  await expect.poll(() => rejectedMessage).toBeTruthy();
  expect(rejectedMessage).toMatch(/format|protocol/i);
  await expect(page.locator('#message-input')).toHaveValue('Continue across formats');
  await expect(page.locator('.message.model')).toHaveCount(1);
  expect(oaChats).toHaveLength(0);
  let acceptedMessage;
  page.once('dialog', async dialog => { acceptedMessage = dialog.message(); await dialog.accept(); });
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(2);
  await expect(page.locator('.thinking')).toHaveCount(0);
  expect(acceptedMessage).toBe(rejectedMessage);
  expect(geminiChats).toHaveLength(1);
  expect(oaChats).toHaveLength(1);
  expect(oaChats[0].body.messages.filter(message => message.role !== 'system')).toEqual([
    { role: 'user', content: 'Earlier Gemini question' },
    { role: 'assistant', content: 'Earlier Gemini answer' },
    { role: 'user', content: 'Continue across formats' },
  ]);
  await expect.poll(async () => (await saved(page)).conversations[0].protocol).toBe('openai');
  const history = (await saved(page)).conversations[0].history;
  expect(history.map(message => message.role)).toEqual(['user', 'model', 'user', 'model']);
  expect(history[1].parts[0].text).toBe('Earlier Gemini answer');
});

test('changing OpenAI endpoints also requests consent and declining does not leak chat history or credentials', async ({ page }) => {
  const chats = [], requests = [];
  await page.route(`${OPENAI}/chat/completions`, route => route.fulfill({ json: oaReply('Original provider answer') }));
  await page.route(`${OTHER}/chat/completions`, async route => { chats.push(record(route.request())); await route.fulfill({ json: oaReply('Should not be sent') }); });
  await connect(page);
  await send(page, 'Original private question', 1);
  await connect(page, { endpoint: OTHER, requests, navigate: false, key: 'other-provider-key' });
  let warning;
  page.once('dialog', async dialog => { warning = dialog.message(); await dialog.dismiss(); });
  await page.locator('#message-input').fill('Keep private until I consent');
  await page.locator('#send-button').click();
  await expect.poll(() => warning).toContain(OTHER);
  await expect(page.locator('#message-input')).toHaveValue('Keep private until I consent');
  await expect(page.locator('.message.model')).toHaveCount(1);
  expect(chats).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toBeNull();
  expect(requests[0].headers.authorization).toBe('Bearer other-provider-key');
});

test('legacy cache defaults to Gemini and rejects raw OpenAI IDs; explicitly selected OpenAI restores those IDs', async ({ page }) => {
  const settings = cachedSettings('openai');
  delete settings.protocol;
  settings.endpoint = CUSTOM;
  await seed(page, settings);
  await openSettings(page);
  await expect(page.locator('#api-protocol-gemini')).toBeChecked();
  await expect(page.locator('#model-select')).toBeDisabled();
  await closeSettings(page);
  await seed(page, cachedSettings('openai'));
  await openSettings(page);
  await expect(page.locator('#api-protocol-openai')).toBeChecked();
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#model-select')).toHaveValue(RAW_MODEL);
  await closeSettings(page);
  await seed(page, cachedSettings('openai', { modelsProtocol: 'gemini' }));
  await openSettings(page);
  await expect(page.locator('#api-protocol-openai')).toBeChecked();
  await expect(page.locator('#model-select')).toBeDisabled();
});

test('a local OpenAI-compatible provider can discover and chat without sending an empty Authorization header', async ({ page }) => {
  const endpoint = 'http://localhost:12345/v1';
  const discovery = [], chats = [];
  await page.route(`${endpoint}/chat/completions`, async route => {
    chats.push(record(route.request()));
    await route.fulfill({ json: oaReply('Local unauthenticated reply') });
  });
  await connect(page, { endpoint, key: '', requests: discovery });
  expect(discovery).toHaveLength(1);
  expect(discovery[0].headers.authorization).toBeUndefined();
  expect(discovery[0].headers['x-goog-api-key']).toBeUndefined();
  await send(page, 'Hello local model', 1);
  expect(chats).toHaveLength(1);
  expect(chats[0].headers.authorization).toBeUndefined();
  expect(chats[0].headers['x-goog-api-key']).toBeUndefined();
  expect(chats[0].body.model).toBe(RAW_MODEL);
  await expect(page.locator('.message.model')).toContainText('Local unauthenticated reply');
});

test('API format is disabled during initialization and pending replies; Stop and provider failures roll back before retry', async ({ page }) => {
  let releaseModule, moduleRequested;
  const moduleGate = new Promise(resolve => { releaseModule = resolve; });
  const requested = new Promise(resolve => { moduleRequested = resolve; });
  await page.route('**/storage.js', async route => { moduleRequested(); await moduleGate; await route.continue(); });
  await page.goto(base, { waitUntil: 'commit' });
  await requested;
  try { await expect(page.locator('#api-protocol-gemini')).toBeDisabled(); }
  finally { releaseModule(); }
  await ready(page);
  let calls = 0, startPending, releasePending;
  const started = new Promise(resolve => { startPending = resolve; });
  const pending = new Promise(resolve => { releasePending = resolve; });
  const requests = [];
  await page.route(`${OPENAI}/chat/completions`, async route => {
    requests.push(record(route.request()));
    calls++;
    if (calls === 1) return route.fulfill({ status: 401, json: { error: { message: `Rejected credential ${KEY}` } } });
    if (calls === 2) { startPending(); await pending; try { await route.fulfill({ json: oaReply('Cancelled response') }); } catch { /* Stop already closed this request. */ } return; }
    await route.fulfill({ json: oaReply('Successful clean retry') });
  });
  await connect(page, { navigate: false });
  await page.locator('#message-input').fill('Retry this question');
  await page.locator('#send-button').click();
  await expect(page.locator('#chat-notice')).toBeVisible();
  await expect(page.locator('#chat-notice')).not.toContainText(KEY);
  await expect(page.locator('#message-input')).toHaveValue('Retry this question');
  await expect(page.locator('.message')).toHaveCount(0);
  await page.locator('#send-button').click();
  await started;
  await openSettings(page);
  await expect(page.locator('#api-protocol-gemini')).toBeDisabled();
  await expect(page.locator('#endpoint')).toBeDisabled();
  await expect(page.locator('#api-key')).toBeDisabled();
  await closeSettings(page);
  await expect(mode(page, 'on')).toBeDisabled();
  await page.locator('#stop-button').click();
  releasePending();
  await expect(page.locator('#message-input')).toHaveValue('Retry this question');
  await expect(page.locator('#stop-button')).toBeHidden();
  await expect(page.locator('.message')).toHaveCount(0);
  await send(page, 'Retry this question', 1);
  expect(requests).toHaveLength(3);
  for (const request of requests) expect(request.body.messages.filter(message => message.role !== 'system')).toEqual([{ role: 'user', content: 'Retry this question' }]);
  await openSettings(page);
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
});

for (const width of [320, 390]) {
  test(`${width}px mobile API-format control is labelled, keyboard-operable and fits the settings panel`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base);
    await openSettings(page);
    const protocol = page.getByRole('group', { name: 'API format', exact: true });
    const gemini = page.getByRole('radio', { name: 'Gemini', exact: true });
    const openai = page.getByRole('radio', { name: 'OpenAI-compatible', exact: true });
    await expect(protocol).toBeVisible();
    await expect(protocol).toHaveAttribute('id', 'api-protocol');
    await openai.check();
    await expect(page.locator('#endpoint')).toHaveValue(OPENAI);
    await openai.focus();
    await page.keyboard.press('ArrowUp');
    await expect(gemini).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(openai).toBeChecked();
    const geometry = await protocol.evaluate(group => {
      const box = group.getBoundingClientRect(), dialog = document.querySelector('#settings-dialog').getBoundingClientRect();
      return { left: box.left, right: box.right, width: group.scrollWidth, client: group.clientWidth, dialogLeft: dialog.left, dialogRight: dialog.right, page: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.dialogLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.dialogRight);
    expect(geometry.width).toBeLessThanOrEqual(geometry.client);
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.dialogLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.dialogRight).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `artifacts/prism-openai-settings-mobile-${width}.png`, fullPage: true, animations: 'disabled' });
  });
}
