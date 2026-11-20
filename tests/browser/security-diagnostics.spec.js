import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

let server, base;
const API = 'https://diagnostics.example.test/v1';
const KEY = 'mock-diagnostics-current-api-key';
const OLD_KEY = 'mock-diagnostics-cleared-gemini-key';
const MODEL = 'org/diagnostics:chat';
const HTML = '<!doctype html><html><body><button id="increment">Increment</button><output id="count">0</output><script>let n=0;document.querySelector("#increment").onclick=()=>document.querySelector("#count").textContent=String(++n);</script></body></html>';
const invalidCSPSource = /invalid source|invalid[^\n]*(?:connect-src|content security policy)|(?:connect-src|content security policy)[^\n]*invalid/i;
const reply = text => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const requestRecord = request => ({ url: request.url(), headers: request.headers(), method: request.method() });

// Match the existing browser suites: one disposable instance of the real static
// preview server, on an OS-selected loopback port, with provider traffic mocked.
test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function settings(page) {
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
  if (!await page.locator('#settings-dialog').isVisible()) await page.locator('#toggle-settings').click();
}
async function openAI(page) {
  await settings(page);
  await page.locator('#api-protocol-openai').check();
  await page.locator('#endpoint').fill(API);
  await page.locator('#api-key').fill(KEY);
}
async function settleSettings(page) {
  // Persisting a format is a useful deterministic fence: the change handler has
  // finished, but must not have performed discovery or sent an old credential.
  await expect.poll(() => page.evaluate(async () => (await (await import('./storage.js')).createStore().load()).settings.protocol)).toBe('openai');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function expectAuthenticationHelp(locator) {
  await expect(locator).toContainText(/401/);
  await expect(locator).toContainText(/authentication rejected/i);
  await expect(locator).toContainText(/OpenAI/i);
  await expect(locator).toContainText(/key/i);
  await expect(locator).toContainText(/format.*clear|switch.*clear/i);
  await expect(locator).not.toContainText(KEY);
  await expect(locator).not.toContainText(OLD_KEY);
}

// Capture before navigation: both response-header and meta policies are parsed
// before app.js runs. Keep collecting through both nested artefact documents.
test('fresh app and a working interactive artefact emit no invalid CSP source diagnostics', async ({ page }) => {
  const diagnostics = [];
  page.on('console', message => { if (invalidCSPSource.test(message.text())) diagnostics.push(message.text()); });
  await page.route(`${API}/models`, route => route.fulfill({ json: { data: [{ id: MODEL }] } }));
  await page.route(`${API}/chat/completions`, route => route.fulfill({ json: reply(`<artefact title="CSP counter">${HTML}</artefact>`) }));
  await page.goto(base);
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
  expect(diagnostics, 'fresh document header/meta CSP must not contain ignored sources').toEqual([]);
  await openAI(page);
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Create an interactive counter');
  await page.locator('#send-button').click();
  const card = page.locator('.message.model .artefact-card');
  await expect(card).toHaveCount(1);
  const runtime = card.frameLocator('.artefact-frame').frameLocator('iframe');
  await expect(runtime.locator('#count')).toHaveText('0');
  await runtime.locator('#increment').click();
  await expect(runtime.locator('#count')).toHaveText('1');
  expect(diagnostics, 'artefact host/runtime CSP must not contain ignored sources').toEqual([]);
});

test('switching format makes no automatic requests, clears old auth, and discovery 401 explains how to reconnect without leaking keys', async ({ page }) => {
  const requests = [], consoleMessages = [];
  page.on('console', message => consoleMessages.push(message.text()));
  await page.route(`${API}/models*`, route => {
    const request = requestRecord(route.request());
    requests.push(request);
    if (request.headers['x-goog-api-key']) return route.fulfill({ json: { models: [{ name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] }] } });
    return route.fulfill({ status: 401, json: { error: { message: `Credential rejected: ${KEY}` } } });
  });
  await page.goto(base);
  await settings(page);
  await page.locator('#endpoint').fill(API);
  await page.locator('#api-key').fill(OLD_KEY);
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  expect(requests).toHaveLength(1);
  expect(requests[0].headers['x-goog-api-key']).toBe(OLD_KEY);
  await page.locator('#api-protocol-openai').check();
  await expect(page.locator('#endpoint')).toHaveValue(API);
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('#model-select')).toBeDisabled();
  await settleSettings(page);
  expect(requests, 'format change must not send the cleared Gemini key or automatically fetch models').toHaveLength(1);
  await page.locator('#api-key').fill(KEY);
  expect(requests, 'typing a replacement key is not consent to a model request').toHaveLength(1);
  await page.locator('#fetch-models').click();
  await expectAuthenticationHelp(page.locator('#connection-status'));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ url: `${API}/models`, method: 'GET', headers: { authorization: `Bearer ${KEY}` } });
  expect(requests[1].headers['x-goog-api-key']).toBeUndefined();
  expect(requests.every(request => !request.url.includes(KEY) && !request.url.includes(OLD_KEY))).toBe(true);
  expect(consoleMessages.join('\n')).not.toContain(KEY);
  expect(consoleMessages.join('\n')).not.toContain(OLD_KEY);
});

test('OpenAI chat 401 retains the unsent draft and shows actionable format/key guidance with provider credentials redacted', async ({ page }) => {
  const requests = [], consoleMessages = [];
  page.on('console', message => consoleMessages.push(message.text()));
  await page.route(`${API}/models`, route => route.fulfill({ json: { data: [{ id: MODEL }] } }));
  await page.route(`${API}/chat/completions`, route => {
    requests.push(requestRecord(route.request()));
    return route.fulfill({ status: 401, json: { error: { message: `Invalid API key ${KEY}` } } });
  });
  await page.goto(base);
  await openAI(page);
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#close-settings').click();
  const draft = 'Keep this draft when authentication fails';
  await page.locator('#message-input').fill(draft);
  await page.locator('#send-button').click();
  await expectAuthenticationHelp(page.locator('#chat-notice'));
  await expect(page.locator('#message-input')).toHaveValue(draft);
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.locator('#stop-button')).toBeHidden();
  await expect(page.locator('#send-button')).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  expect(requests[0].headers['x-goog-api-key']).toBeUndefined();
  expect(requests[0].url).not.toContain(KEY);
  expect(consoleMessages.join('\n')).not.toContain(KEY);
});
