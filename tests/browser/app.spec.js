import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

let server;
let base;
const API = 'https://generativelanguage.googleapis.com/v1beta';
const models = [
  { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
  { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
];
const reply = text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function openSettings(page, tab = 'connection') {
  await page.locator('#toggle-settings').click();
  await page.locator(`#settings-tab-${tab}`).click();
}
async function closeSettings(page) {
  if (await page.locator('#settings-dialog').isVisible()) await page.locator('#close-settings').click();
}
async function connect(page, endpoint = API) {
  await openSettings(page);
  await page.route(`${endpoint}/models?*`, route => route.fulfill({ json: { models } }));
  await page.locator('#endpoint').fill(endpoint);
  await page.locator('#api-key').fill('test-key-never-persist');
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('2 models available');
  await expect(page.locator('#connection-status')).toBeHidden();
  await closeSettings(page);
}

test('desktop setup, model discovery, multi-turn chat, model switching, export, safe rendering', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await expect(page).toHaveTitle('Prism — Your AI workspace');
  await openSettings(page);
  await expect(page.locator('#endpoint')).toHaveValue(API);
  await closeSettings(page);
  await expect(page.locator('#send-button')).toBeDisabled();
  await page.screenshot({ path: 'artifacts/prism-desktop.png', fullPage: true, animations: 'disabled' });
  await connect(page);
  await expect(page.locator('#api-key')).toHaveAttribute('type', 'password');
  await openSettings(page);
  await page.locator('#toggle-key').click();
  await expect(page.locator('#api-key')).toHaveAttribute('type', 'text');
  await page.locator('#toggle-key').click();
  await closeSettings(page);
  let requests = [];
  await page.route(`${API}/models/*:generateContent`, async route => {
    requests.push({ url: route.request().url(), data: route.request().postDataJSON(), headers: route.request().headers() });
    await route.fulfill({ json: reply('Here is a small starting point.\n\n```javascript\nconst idea = "Something useful";\n```\n\n<img src=x onerror=alert(1)>') });
  });
  await openSettings(page, 'instructions');
  await page.locator('#system-prompt').fill('Be practical.');
  await closeSettings(page);
  await page.locator('.prompt-card').first().click();
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(1);
  await expect(page.locator('.message.model .thinking')).toHaveCount(0);
  await expect(page.locator('.message-content pre')).toHaveCount(1);
  await expect(page.locator('.message-content img')).toHaveCount(0);
  await expect(page.locator('.message.model')).toContainText('<img src=x onerror=alert(1)>');
  expect(requests[0].headers['x-goog-api-key']).toBe('test-key-never-persist');
  expect(requests[0].data.systemInstruction.parts[0].text).toMatch(/^Be practical\.\n\nPrism can render interactive HTML artefacts\./);
  await openSettings(page);
  await page.locator('#model-select').selectOption('models/gemini-2.5-pro');
  await closeSettings(page);
  await page.locator('#message-input').fill('Can you expand on that?');
  await page.locator('#message-input').press('Enter');
  await expect(page.locator('.message.model')).toHaveCount(2);
  await expect(page.locator('.thinking')).toHaveCount(0);
  expect(requests[1].url).toContain('gemini-2.5-pro:generateContent');
  expect(requests[1].data.contents.map(x => x.role)).toEqual(['user', 'model', 'user']);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-chat').click()]);
  expect(download.suggestedFilename()).toMatch(/^prism-chat-.*\.md$/);
  expect(await page.evaluate(() => indexedDB.databases().then(items => items.some(item => item.name === 'prism-local')))).toBe(true);
  await page.screenshot({ path: 'artifacts/prism-chat.png', fullPage: true, animations: 'disabled' });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#new-chat').click();
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('error recovery, stop, failed-turn rollback, and endpoint-change consent', async ({ page }) => {
  await page.goto(base);
  await connect(page);
  let mode = 'error';
  let calls = [];
  await page.route(`${API}/models/*:generateContent`, async route => {
    calls.push(route.request().postDataJSON());
    if (mode === 'error') await route.fulfill({ status: 429, json: { error: { message: 'Too many requests' } } });
    else if (mode === 'stop') await route.abort('aborted');
    else await route.fulfill({ json: reply('A useful reply') });
  });
  await page.locator('#message-input').fill('First attempt');
  await page.locator('#send-button').click();
  await expect(page.locator('#chat-notice')).toContainText('429');
  await expect(page.locator('#message-input')).toHaveValue('First attempt');
  await expect(page.locator('.message')).toHaveCount(0);
  mode = 'success';
  await page.locator('#send-button').click();
  await expect(page.locator('.thinking')).toHaveCount(0);
  await expect(page.locator('.message.model')).toContainText('A useful reply');
  expect(calls[1].contents).toHaveLength(1);
  // Leave the API call pending without a timer; cancellation must restore the draft.
  await page.unroute(`${API}/models/*:generateContent`);
  let pendingRoute;
  await page.route(`${API}/models/*:generateContent`, route => { pendingRoute = route; });
  await page.locator('#message-input').fill('Cancel this');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  await page.locator('#stop-button').click();
  await expect(page.locator('#chat-notice')).toContainText('Response stopped');
  await expect(page.locator('#message-input')).toHaveValue('Cancel this');
  if (pendingRoute) await pendingRoute.abort().catch(() => {});
  await connect(page, 'https://custom.example/v1beta');
  await expect(page.locator('#endpoint')).toHaveValue('https://custom.example/v1beta');
  await expect(page.locator('#endpoint-notice')).toHaveCount(0);
  let customCalls = 0;
  await page.route('https://custom.example/v1beta/models/*:generateContent', async route => { customCalls++; await route.fulfill({ json: reply('Custom response') }); });
  page.once('dialog', dialog => { expect(dialog.message()).toContain('entire current conversation'); dialog.dismiss(); });
  await page.locator('#send-button').click();
  expect(customCalls).toBe(0);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model').last()).toContainText('Custom response');
  expect(customCalls).toBe(1);
});

test('mobile layout, settings popup, conversation drawer, Enter handling and reload restore', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.screenshot({ path: 'artifacts/prism-mobile.png', fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.locator('#close-sidebar').click();
  await connect(page);
  await page.locator('#message-input').fill('Hello');
  await page.locator('#message-input').press('Shift+Enter');
  await expect(page.locator('#message-input')).toHaveValue('Hello\n');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('#api-key')).toHaveValue('test-key-never-persist');
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#message-input')).toHaveValue('Hello\n');
});
