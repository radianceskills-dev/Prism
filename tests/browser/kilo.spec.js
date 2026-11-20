import { test, expect } from '@playwright/test';

// Reuse the parent's running preview; every remote response below is synthetic.
// In particular, these tests never contact Kilo, Google, or a paid provider.
const BASE = 'http://127.0.0.1:3000';
const UPSTREAM = 'https://ai-gateway.kilo.ai/api/v1';
const WORKER = 'https://synthetic-kilo.workers.dev';
const OTHER_WORKER = 'https://second-synthetic-kilo.workers.dev';
const KILO = `${WORKER}/kilo/v1`;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const CUSTOM = 'https://kilo-primary.test/v1';
const OTHER = 'https://kilo-other.test/v1';
const KEY = 'synthetic-primary-secret-not-for-kilo';
const FREE = 'synthetic/free-chat:free';
const STEALTH = 'synthetic/stealth';
const PAID = 'synthetic/paid-chat';
const PRIMARY = { gemini: 'models/gemini-synthetic', openai: 'synthetic/primary:variant' };
const CATALOGUE = { data: [
  { id: FREE, name: 'Synthetic Free', pricing: { prompt: '0', completion: '0' } },
  { id: STEALTH, name: 'Synthetic Stealth', pricing: { prompt: '0', completion: '0' } },
  { id: PAID, name: 'Synthetic Paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const answer = text => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const geminiAnswer = text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const values = page => page.locator('#model-select option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
const mode = (page, value) => page.locator(`#artefact-mode-switch button[data-mode="${value}"]`);
async function saved(page) { return page.evaluate(async () => (await import('./storage.js')).createStore().load()); }
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function settings(page) {
  if (!await page.locator('#settings-dialog').isVisible()) await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-connection').click();
}
async function close(page) { await page.locator('#close-settings').click(); }
async function reloadModels(page, count) {
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText(`${count} model${count === 1 ? '' : 's'} available`);
  await expect(page.locator('#fetch-models')).toBeEnabled();
}
async function setup(page, { protocol = 'gemini', key = KEY, workerURL = WORKER, primaryFailure = false, kiloFailure = false } = {}) {
  const state = { protocol, primaryModels: [], kiloModels: [], primaryChats: [], kiloChats: [], direct: [], unexpected: [], errors: [], primaryFailure, kiloFailure };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith(UPSTREAM)) state.direct.push(request.url()); });
  await page.route('**/*', route => {
    if (route.request().url().startsWith(`${BASE}/`)) return route.continue();
    state.unexpected.push(route.request().url());
    return route.abort();
  });
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  // Capture fetch options as well as wire headers: same-site cookies must be
  // deliberately omitted, not merely absent in an empty browser profile.
  await page.addInitScript(kilo => {
    const fetch = window.fetch.bind(window);
    window.__kiloFetches = [];
    window.fetch = (url, init = {}) => {
      if (String(url).startsWith(kilo)) window.__kiloFetches.push({ url: String(url), method: init.method || 'GET', credentials: init.credentials });
      return fetch(url, init);
    };
  }, KILO);
  await page.context().addCookies([{ name: 'synthetic-kilo-cookie', value: 'never-send', domain: 'synthetic-kilo.workers.dev', path: '/', secure: true, sameSite: 'None' }]);
  const endpoint = protocol === 'gemini' ? GEMINI : CUSTOM;
  await page.route(`${endpoint}/models*`, route => {
    state.primaryModels.push(route.request());
    return state.primaryFailure
      ? route.fulfill({ status: 503, json: { error: { message: 'Synthetic primary unavailable' } } })
      : route.fulfill({ json: protocol === 'gemini'
        ? { models: [{ name: PRIMARY.gemini, displayName: 'Synthetic Gemini', supportedGenerationMethods: ['generateContent'] }] }
        : { data: [{ id: PRIMARY.openai }] } });
  });
  await page.route(`${KILO}/models`, async route => {
    state.kiloModels.push(route.request());
    await anonymous(route.request());
    return state.kiloFailure
      ? route.fulfill({ status: 503, json: { error: { message: 'Synthetic Kilo unavailable' } } })
      : route.fulfill({ json: CATALOGUE });
  });
  await page.goto(BASE);
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
  await settings(page);
  await page.locator(`#api-protocol-${protocol}`).check();
  await page.locator('#endpoint').fill(endpoint);
  await page.locator('#api-key').fill(key);
  await page.locator('#kilo-worker-url').fill(workerURL);
  return state;
}
async function anonymous(request) {
  const headers = await request.allHeaders();
  expect(headers.authorization).toBeUndefined();
  expect(headers['x-goog-api-key']).toBeUndefined();
  expect(headers.cookie).toBeUndefined();
  expect(request.url()).not.toContain(KEY);
  expect(request.postData() || '').not.toContain(KEY);
  expect(JSON.stringify(headers)).not.toContain('synthetic-oauth-secret');
  expect(request.postData() || '').not.toContain('synthetic-oauth-secret');
}
async function kiloChat(page, state, respond = () => ({ json: answer('Synthetic Kilo answer') })) {
  await page.route(`${KILO}/chat/completions`, async route => {
    const request = route.request();
    await anonymous(request);
    expect(request.method()).toBe('POST');
    const body = request.postDataJSON();
    expect(body.model).toBe(FREE);
    expect(body.stream).toBe(false);
    expect(body.tools.map(tool => tool.function.name)).toContain('prism_help');
    state.kiloChats.push(body);
    await route.fulfill(respond(body, state.kiloChats.length));
  });
}
async function primaryChat(page, state) {
  const url = state.protocol === 'gemini' ? `${GEMINI}/models/*:generateContent` : `${CUSTOM}/chat/completions`;
  await page.route(url, route => {
    state.primaryChats.push(route.request().postDataJSON());
    expect(route.request().headers()[state.protocol === 'gemini' ? 'x-goog-api-key' : 'authorization']).toBe(state.protocol === 'gemini' ? KEY : `Bearer ${KEY}`);
    return route.fulfill({ json: state.protocol === 'gemini' ? geminiAnswer('Synthetic primary answer') : answer('Synthetic primary answer') });
  });
}
async function chooseKilo(page, state, count = 3) {
  await page.locator('#kilo-enabled').check();
  await reloadModels(page, count);
  await page.locator('#model-select').selectOption(`kilo:${FREE}`);
  await page.locator('#settings-tab-tools').click();
  await page.locator('#parallel-search').uncheck();
  await close(page);
}
async function send(page, text, reply, count = 1) {
  await page.locator('#message-input').fill(text);
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(count);
  await expect(page.locator('.message.model').last()).toContainText(reply);
  await expect(page.locator('#stop-button')).toBeHidden();
}
async function clean(page, state) {
  expect(state.unexpected, 'No live provider, upload or unmocked tool request').toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.direct, 'Never fetch the non-CORS upstream from the browser').toEqual([]);
  const fetches = await page.evaluate(() => window.__kiloFetches);
  expect(fetches.every(call => call.credentials === 'omit')).toBe(true);
}

test('Kilo card is optional, labelled, correctly ordered, and enabling only saves a preference', async ({ page }) => {
  const state = await setup(page);
  const toggle = page.locator('#kilo-enabled');
  await expect(page.locator('#connection-card + #kilo-card')).toHaveCount(1);
  await expect(page.locator('#kilo-card + #model-card')).toHaveCount(1);
  await expect(page.locator('#kilo-card')).toContainText('Kilo Free Models');
  await expect(toggle).toHaveAttribute('type', 'checkbox');
  await expect(toggle).not.toBeChecked();
  expect(await toggle.evaluate(node => [...node.labels].some(label => label.textContent.trim().length > 0))).toBe(true);
  await expect(page.locator('#kilo-status')).toBeVisible();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await saved(page)).settings.kiloEnabled).toBe(true);
  await frames(page);
  expect(state.primaryModels).toHaveLength(0);
  expect(state.kiloModels).toHaveLength(0);
  await page.reload();
  await settings(page);
  await expect(toggle).toBeChecked();
  expect(state.kiloModels).toHaveLength(0);
  await clean(page, state);
});

for (const workerURL of ['', 'https://bad-worker.invalid/private?key=never']) {
  test(`Kilo ${workerURL ? 'malformed' : 'blank'} Worker reports setup error while configured provider still succeeds`, async ({ page }) => {
    const state = await setup(page, { workerURL });
    await page.locator('#kilo-enabled').check();
    await reloadModels(page, 1);
    await expect(page.locator('#kilo-status')).toContainText(/Worker|HTTPS|URL/i);
    await expect(page.locator('#model-select')).toHaveValue(PRIMARY.gemini);
    expect(state.kiloModels).toHaveLength(0);
    await clean(page, state);
  });
}

test('shared Worker URL syncs both tabs, invalidates only Kilo cache, and uses the existing deployment template', async ({ page }) => {
  const state = await setup(page);
  await chooseKilo(page, state);
  await settings(page);
  const deploy = await page.locator('#kilo-deploy-worker').getAttribute('href');
  expect(new URL(deploy).searchParams.get('url')).toBe('https://github.com/radianceskills-dev/prism-composio-worker');
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#composio-worker-url')).toHaveValue(WORKER);
  await expect(page.locator('#kilo-deploy-worker')).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.locator('#deploy-composio-worker').getAttribute('href')).toBe(deploy);
  await page.locator('#composio-worker-url').fill(OTHER_WORKER);
  await expect(page.locator('#composio-enabled')).not.toBeChecked();
  await page.locator('#settings-tab-connection').click();
  await expect(page.locator('#kilo-worker-url')).toHaveValue(OTHER_WORKER);
  expect(await values(page)).toEqual([PRIMARY.gemini]);
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await page.locator('#kilo-worker-url').fill(WORKER);
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#composio-worker-url')).toHaveValue(WORKER);
  await expect.poll(async () => (await saved(page)).settings.composioWorkerURL).toBe(WORKER);
  expect(state.primaryModels).toHaveLength(1);
  expect(state.kiloModels).toHaveLength(1);
  await clean(page, state);
});

test('shared Worker inputs are locked in both tabs while Kilo discovery is pending', async ({ page }) => {
  const state = await setup(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`${KILO}/models`, async route => {
    state.kiloModels.push(route.request());
    await gate;
    await route.fulfill({ json: CATALOGUE });
  });
  await page.locator('#kilo-enabled').check();
  await page.locator('#fetch-models').click();
  try {
    await expect(page.locator('#kilo-worker-url')).toBeDisabled();
    await expect(page.locator('#kilo-enabled')).toBeDisabled();
    await page.locator('#settings-tab-tools').click();
    await expect(page.locator('#composio-worker-url')).toBeDisabled();
  } finally { release(); }
  await page.locator('#settings-tab-connection').click();
  await expect(page.locator('#model-count')).toHaveText('3 models available');
  await expect(page.locator('#kilo-worker-url')).toBeEnabled();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#composio-worker-url')).toBeEnabled();
  await clean(page, state);
});

test('restoring Kilo cache without a valid shared Worker drops only its models without network', async ({ page }) => {
  const state = await setup(page);
  await chooseKilo(page, state);
  const workspace = await saved(page);
  workspace.settings.composioWorkerURL = '';
  await page.evaluate(async workspace => (await import('./storage.js')).createStore().save(workspace), workspace);
  await page.reload();
  await settings(page);
  await expect(page.locator('#kilo-enabled')).toBeChecked();
  expect(await values(page)).toEqual([PRIMARY.gemini]);
  expect(state.primaryModels).toHaveLength(1);
  expect(state.kiloModels).toHaveLength(1);
  await clean(page, state);
});

test('combined reload keeps configured raw values and includes only free and stealth Kilo models', async ({ page }) => {
  const state = await setup(page);
  await page.locator('#kilo-enabled').check();
  await reloadModels(page, 3);
  expect(await values(page)).toEqual(expect.arrayContaining([PRIMARY.gemini, `kilo:${FREE}`, `kilo:${STEALTH}`]));
  expect(await values(page)).not.toContain(`kilo:${PAID}`);
  for (const id of [FREE, STEALTH]) await expect(page.locator('#model-select option').filter({ hasText: id === FREE ? 'Synthetic Free' : 'Synthetic Stealth' })).toHaveText(/^Kilo · /);
  expect(state.primaryModels).toHaveLength(1);
  expect(state.kiloModels).toHaveLength(1);
  expect(state.kiloModels[0].url()).toBe(`${KILO}/models`);
  expect(state.kiloModels[0].method()).toBe('GET');
  const workspace = await saved(page);
  expect(JSON.stringify(workspace.settings)).toContain('"source":"kilo"');
  await clean(page, state);
});

test('blank Gemini key supports Kilo-only discovery and chat', async ({ page }) => {
  const state = await setup(page, { key: '' });
  await kiloChat(page, state);
  await chooseKilo(page, state, 2);
  await send(page, 'Hello free model', 'Synthetic Kilo answer');
  expect(state.primaryModels).toHaveLength(0);
  expect(state.kiloChats).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('prism.composio.worker.tokens'))).toBeNull();
  await clean(page, state);
});

test('failed configured discovery shows a partial error but Kilo remains usable', async ({ page }) => {
  const state = await setup(page, { primaryFailure: true });
  await kiloChat(page, state);
  await page.locator('#kilo-enabled').check();
  await reloadModels(page, 2);
  await expect(page.locator('#connection-status')).toBeVisible();
  await expect(page.locator('#connection-status')).toContainText(/error|unavailable|could not/i);
  await page.locator('#model-select').selectOption(`kilo:${FREE}`);
  await close(page);
  await send(page, 'Use surviving free source', 'Synthetic Kilo answer');
  expect(state.kiloChats).toHaveLength(1);
  await clean(page, state);
});

test('failed Kilo discovery leaves configured provider available with a partial Kilo error', async ({ page }) => {
  const state = await setup(page, { kiloFailure: true });
  await primaryChat(page, state);
  await page.locator('#kilo-enabled').check();
  await reloadModels(page, 1);
  await expect(page.locator('#kilo-status')).toContainText(/error|unavailable|could not/i);
  await expect(page.locator('#model-select')).toHaveValue(PRIMARY.gemini);
  await close(page);
  await send(page, 'Keep primary provider', 'Synthetic primary answer');
  expect(state.primaryChats).toHaveLength(1);
  expect(state.kiloChats).toHaveLength(0);
  await clean(page, state);
});

test('disabling Kilo immediately removes its selection while preserving primary cache and key', async ({ page }) => {
  const state = await setup(page);
  await chooseKilo(page, state);
  await settings(page);
  await page.locator('#kilo-enabled').uncheck();
  expect(await values(page)).toEqual([PRIMARY.gemini]);
  await expect(page.locator('#model-select')).toHaveValue(PRIMARY.gemini);
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  expect(state.primaryModels).toHaveLength(1);
  expect(state.kiloModels).toHaveLength(1);
  await clean(page, state);
});

test('enabled preference, Kilo selection, and independent cache restore on reload without any API call', async ({ page }) => {
  const state = await setup(page);
  await chooseKilo(page, state);
  await expect.poll(async () => (await saved(page)).settings.model).toBe(`kilo:${FREE}`);
  await page.reload();
  await settings(page);
  await expect(page.locator('#kilo-enabled')).toBeChecked();
  await expect(page.locator('#model-select')).toHaveValue(`kilo:${FREE}`);
  expect(await values(page)).toEqual(expect.arrayContaining([PRIMARY.gemini, `kilo:${FREE}`, `kilo:${STEALTH}`]));
  await frames(page);
  expect(state.primaryModels).toHaveLength(1);
  expect(state.kiloModels).toHaveLength(1);
  await clean(page, state);
});

test('custom endpoint and protocol edits invalidate only primary cache and never transfer its credentials', async ({ page }) => {
  const state = await setup(page);
  await kiloChat(page, state);
  await chooseKilo(page, state);
  await settings(page);
  await page.locator('#endpoint').fill(OTHER);
  await page.locator('#api-key').focus();
  expect(await values(page)).toEqual([`kilo:${FREE}`, `kilo:${STEALTH}`]);
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await page.locator('#api-protocol-openai').check();
  expect(await values(page)).toEqual([`kilo:${FREE}`, `kilo:${STEALTH}`]);
  await expect(page.locator('#endpoint')).toHaveValue(OTHER);
  await expect(page.locator('#api-key')).toHaveValue('');
  await close(page);
  await send(page, 'Still use independent free cache', 'Synthetic Kilo answer');
  expect(state.primaryModels).toHaveLength(1);
  expect(state.kiloModels).toHaveLength(1);
  await clean(page, state);
});

for (const protocol of ['gemini', 'openai']) {
  test(`Kilo always uses anonymous OpenAI chat while configured ${protocol} identity remains unchanged`, async ({ page }) => {
    const state = await setup(page, { protocol });
    await page.evaluate(workerURL => localStorage.setItem('prism.composio.worker.tokens', JSON.stringify({ workerURL, accessToken: 'synthetic-oauth-secret', refreshToken: 'synthetic-oauth-secret-refresh', expiresAt: Date.now() + 3600000 })), WORKER);
    await kiloChat(page, state);
    await chooseKilo(page, state);
    await send(page, 'First free turn', 'Synthetic Kilo answer');
    await send(page, 'Second free turn', 'Synthetic Kilo answer', 2);
    expect(state.kiloChats[1].messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    await settings(page);
    await expect(page.locator(`#api-protocol-${protocol}`)).toBeChecked();
    await expect(page.locator('#endpoint')).toHaveValue(protocol === 'gemini' ? GEMINI : CUSTOM);
    await expect(page.locator('#api-key')).toHaveValue(KEY);
    expect(state.primaryChats).toEqual([]);
    await clean(page, state);
  });
}

test('Kilo prism_help tool continuation retains local image attachment and Interactive UI modes', async ({ page }) => {
  const state = await setup(page);
  const html = '<!doctype html><html><body><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button></body></html>';
  await kiloChat(page, state, (body, count) => count === 1
    ? { json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'kilo_help_1', type: 'function', function: { name: 'prism_help', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] } }
    : { json: answer(`Synthetic Kilo counter\n\n<artefact title="Synthetic Kilo counter">${html}</artefact>`) });
  await chooseKilo(page, state);
  await page.locator('#attachment-input').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(1);
  await send(page, 'Use help and make a local counter', 'Synthetic Kilo counter');
  expect(state.kiloChats).toHaveLength(2);
  const user = state.kiloChats[0].messages.find(message => message.role === 'user');
  expect(user.content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } });
  expect(state.kiloChats[1].messages.find(message => message.role === 'user')).toEqual(user);
  expect(state.kiloChats[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'kilo_help_1' });
  expect(state.kiloChats[1].messages.at(-1).content).toContain('Prism');
  const child = page.frameLocator('.message.model .artefact-frame').frameLocator('iframe');
  await expect(child.locator('#counter')).toHaveText('0');
  await child.locator('#counter').click();
  await expect(child.locator('#counter')).toHaveText('1');
  await mode(page, 'off').click();
  await expect(page.locator('.message.model iframe')).toHaveCount(0);
  await expect(page.locator('.message.model pre code.language-html')).toHaveText(html);
  await mode(page, 'enforced').click();
  await expect(child.locator('#counter')).toHaveText('0');
  await clean(page, state);
});

for (const protocol of ['gemini', 'openai']) {
  test(`switching an existing ${protocol} conversation to Kilo confirms history sharing; cancel makes no call`, async ({ page }) => {
    const state = await setup(page, { protocol });
    await primaryChat(page, state);
    await kiloChat(page, state);
    await reloadModels(page, 1);
    await close(page);
    await send(page, 'Private old provider question', 'Synthetic primary answer');
    await settings(page);
    await chooseKilo(page, state);
    let warning;
    page.once('dialog', async dialog => { warning = dialog.message(); await dialog.dismiss(); });
    await page.locator('#message-input').fill('Continue only with consent');
    await page.locator('#send-button').click();
    await expect.poll(() => warning).toContain(KILO);
    expect(warning).toMatch(/entire|previous|conversation/i);
    await expect(page.locator('#message-input')).toHaveValue('Continue only with consent');
    expect(state.kiloChats).toHaveLength(0);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#send-button').click();
    await expect(page.locator('.message.model')).toHaveCount(2);
    await expect(page.locator('.message.model').last()).toContainText('Synthetic Kilo answer');
    expect(state.kiloChats[0].messages.filter(message => message.role !== 'system')).toEqual([
      { role: 'user', content: 'Private old provider question' },
      { role: 'assistant', content: 'Synthetic primary answer' },
      { role: 'user', content: 'Continue only with consent' },
    ]);
    expect(state.primaryChats).toHaveLength(1);
    await clean(page, state);
  });
}

test('colliding configured IDs and untrusted cached Kilo metadata cannot change provider identity or routes', async ({ page }) => {
  const state = await setup(page, { protocol: 'openai' });
  await page.route(`${CUSTOM}/models`, route => {
    state.primaryModels.push(route.request());
    return route.fulfill({ json: { data: [{ id: FREE }, { id: `kilo:${FREE}` }] } });
  });
  const configured = [];
  await page.route(`${CUSTOM}/chat/completions`, route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${KEY}`);
    configured.push(route.request().postDataJSON());
    return route.fulfill({ json: answer('Collision-safe primary answer') });
  });
  await kiloChat(page, state);
  await page.locator('#kilo-enabled').check();
  await reloadModels(page, 4);
  expect(await values(page)).toEqual(expect.arrayContaining([FREE, `api:kilo:${FREE}`, `kilo:${FREE}`, `kilo:${STEALTH}`]));
  const poisoned = await saved(page);
  const cached = poisoned.settings.models.find(model => model.source === 'kilo');
  Object.assign(cached, { endpoint: 'https://untrusted-kilo-route.test/v1', key: 'untrusted-cache-secret', protocol: 'gemini', remoteId: 'paid/replacement' });
  poisoned.settings.model = `kilo:${FREE}`;
  await page.evaluate(async workspace => (await import('./storage.js')).createStore().save(workspace), poisoned);
  await page.reload();
  await settings(page);
  await expect(page.locator('#model-select')).toHaveValue(`kilo:${FREE}`);
  await page.locator('#settings-tab-tools').click();
  await page.locator('#parallel-search').uncheck();
  await close(page);
  page.on('dialog', dialog => dialog.accept());
  await send(page, 'Test normalized Kilo cache', 'Synthetic Kilo answer');
  expect(state.kiloChats).toHaveLength(1);
  expect(configured).toHaveLength(0);
  const normalized = (await saved(page)).settings.models.find(model => model.source === 'kilo');
  for (const field of ['endpoint', 'key', 'protocol', 'remoteId']) expect(normalized).not.toHaveProperty(field);
  for (const [value, remote] of [[FREE, FREE], [`api:kilo:${FREE}`, `kilo:${FREE}`]]) {
    await settings(page);
    await page.locator('#model-select').selectOption(value);
    await close(page);
    await send(page, `Test configured ID ${remote}`, 'Collision-safe primary answer', configured.length + 2);
    expect(configured.at(-1).model).toBe(remote);
  }
  const disabled = await saved(page);
  disabled.settings.kiloEnabled = false;
  // An imported cache can contain Kilo records even when its toggle is false.
  disabled.settings.model = `kilo:${FREE}`;
  await page.evaluate(async workspace => (await import('./storage.js')).createStore().save(workspace), disabled);
  await page.reload();
  await settings(page);
  await expect(page.locator('#kilo-enabled')).not.toBeChecked();
  expect(await values(page)).toEqual(expect.arrayContaining([FREE, `api:kilo:${FREE}`]));
  expect(await values(page)).not.toContain(`kilo:${FREE}`);
  expect(state.primaryModels).toHaveLength(1);
  expect(state.kiloModels).toHaveLength(1);
  await clean(page, state);
});

test('Kilo chat errors preserve draft and selected free model without any paid or configured fallback', async ({ page }) => {
  const state = await setup(page);
  await primaryChat(page, state);
  await kiloChat(page, state, () => ({ status: 429, json: { error: { message: 'Synthetic free quota exhausted' } } }));
  await chooseKilo(page, state);
  await page.locator('#message-input').fill('Do not send this to a paid model');
  await page.locator('#send-button').click();
  await expect(page.locator('#chat-notice')).toBeVisible();
  await expect(page.locator('#message-input')).toHaveValue('Do not send this to a paid model');
  await expect(page.locator('#stop-button')).toBeHidden();
  await expect(page.locator('.message.model')).toHaveCount(0);
  await settings(page);
  await expect(page.locator('#model-select')).toHaveValue(`kilo:${FREE}`);
  expect(state.kiloChats).toHaveLength(1);
  expect(state.primaryChats).toHaveLength(0);
  await clean(page, state);
});

for (const viewport of [{ width: 1365, height: 1000, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
  test(`synthetic Kilo Connection card fits ${viewport.name} and has readable help`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await setup(page, { key: '' });
    await page.locator('#kilo-enabled').check();
    await reloadModels(page, 2);
    await page.locator('#model-select').selectOption(`kilo:${FREE}`);
    await page.locator('#kilo-card').scrollIntoViewIfNeeded();
    await expect(page.locator('#kilo-status')).toBeVisible();
    const metrics = await page.locator('#kilo-card').evaluate(card => {
      const box = card.getBoundingClientRect();
      const status = document.querySelector('#kilo-status');
      return { left: box.left, right: box.right, viewport: innerWidth, scroll: card.scrollWidth, client: card.clientWidth, helpOverflow: status.scrollHeight > status.clientHeight + 1, documentWidth: document.documentElement.scrollWidth };
    });
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(viewport.width);
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);
    expect(metrics.helpOverflow).toBe(false);
    expect(metrics.documentWidth).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `artifacts/prism-kilo-${viewport.name}.png`, fullPage: true, animations: 'disabled' });
    await clean(page, state);
  });
}
