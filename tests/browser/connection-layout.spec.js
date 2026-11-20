import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

let server, base;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const CUSTOM = 'https://connection-layout.example.test/v1';
const KEY = 'mock-connection-layout-key';
const MODELS = Array.from({ length: 29 }, (_, index) => ({
  name: `models/gemini-layout-${index}`,
  displayName: `Gemini Layout ${String(index + 1).padStart(2, '0')}`,
  supportedGenerationMethods: ['generateContent'],
}));
const modelsPattern = endpoint => new RegExp(`^${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/models(?:\\?.*)?$`);
const radios = page => page.locator('#api-protocol input[type="radio"]');
const reload = page => page.getByRole('button', { name: 'Reload models', exact: true });

// Use the real static application on a disposable loopback port. Only model
// provider requests are mocked; no live account, credentials or API is required.
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

async function open(page, { navigate = true } = {}) {
  if (navigate) await page.goto(base);
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
  if (!await page.locator('#settings-dialog').isVisible()) await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-connection').click();
}
async function saved(page) {
  return page.evaluate(async () => (await import('./storage.js')).createStore().load());
}
async function connect(page) {
  await page.locator('#api-key').fill(KEY);
  await reload(page).click();
  await expect(page.locator('#model-count')).toHaveText('29 models available');
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#model-select option')).toHaveCount(29);
}
async function fieldAssociations(page) {
  for (const id of ['endpoint', 'api-key', 'model-select']) {
    const association = await page.locator(`#${id}`).evaluate(element => ({
      labels: [...element.labels].map(label => ({ text: label.textContent.trim(), target: label.htmlFor })),
    }));
    expect(association.labels.some(label => label.target === id && label.text.length > 0), `${id} has a nonempty correctly associated label`).toBe(true);
  }
  await expect(page.locator('#model-card label[for="model-select"]')).toHaveText('Choose Your Model');
}
async function keyboardFocusReload(page) {
  // Reach the icon-only button through the actual tab sequence, not .focus().
  await page.locator('#api-key').focus();
  let reached = false;
  // The optional Kilo card adds its switch, shared Worker URL and help links
  // between credentials and the model reload button.
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    reached = await reload(page).evaluate(element => element === document.activeElement);
    if (reached) break;
  }
  expect(reached, 'Reload models is reachable by keyboard').toBe(true);
  const style = await reload(page).evaluate(element => {
    const css = getComputedStyle(element);
    return { visible: element.matches(':focus-visible'), outline: css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0, shadow: css.boxShadow !== 'none' };
  });
  expect(style.visible).toBe(true);
  expect(style.outline || style.shadow, 'Keyboard focus has a visible outline or ring').toBe(true);
}
async function fits(page, width, height, { verticalControls = false } = {}) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const selector of ['#settings-dialog', '#connection-card', '#kilo-card', '#model-card', '#endpoint', '#api-key', '#kilo-worker-url', '#fetch-models', '#model-select']) {
    // Connection now contains three cards. Each control must be usable within
    // the existing scroll pane, not simultaneously visible in a short modal.
    if (verticalControls && selector !== '#settings-dialog') await page.locator(selector).scrollIntoViewIfNeeded();
    const box = await page.locator(selector).boundingBox();
    expect(box, selector).not.toBeNull();
    expect(box.x, selector).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, selector).toBeLessThanOrEqual(width + 0.5);
    expect(box.width, selector).toBeGreaterThan(0);
    if (verticalControls) {
      expect(box.y, selector).toBeGreaterThanOrEqual(-0.5);
      expect(box.y + box.height, selector).toBeLessThanOrEqual(height + 0.5);
    }
  }
  const modal = await page.locator('#settings-dialog').boundingBox();
  expect(modal.y).toBeGreaterThanOrEqual(-0.5);
  expect(modal.y + modal.height).toBeLessThanOrEqual(height + 0.5);
  expect(await page.locator('#settings-panel-connection').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const selector of ['#connection-card', '#kilo-card', '#model-card']) {
    expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1), selector).toBe(true);
  }
}
async function readableError(page) {
  const notice = page.locator('#connection-status');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/Could not reach the API|API error/);
  await notice.scrollIntoViewIfNeeded();
  const metrics = await notice.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { text: { top: text.top, bottom: text.bottom, left: text.left, right: text.right }, box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right }, height: innerHeight, overflow: element.scrollHeight > element.clientHeight + 1 };
  });
  expect(metrics.overflow).toBe(false);
  expect(metrics.text.left).toBeGreaterThanOrEqual(metrics.box.left - 1);
  expect(metrics.text.right).toBeLessThanOrEqual(metrics.box.right + 1);
  expect(metrics.text.top).toBeGreaterThanOrEqual(metrics.box.top - 1);
  expect(metrics.text.bottom).toBeLessThanOrEqual(metrics.box.bottom + 1);
  expect(metrics.box.top).toBeGreaterThanOrEqual(0);
  expect(metrics.box.bottom).toBeLessThanOrEqual(metrics.height);
}

test('Connection groups compact credentials and model cards with an accessible icon reload and adjacent desktop count', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.route(modelsPattern(GEMINI), route => route.fulfill({ json: { models: MODELS } }));
  await open(page);
  await expect(page.locator('#connection-form > #connection-fields #connection-card')).toHaveCount(1);
  await expect(page.locator('#connection-form > #connection-fields #model-card')).toHaveCount(1);
  await expect(page.locator('#connection-card #api-protocol')).toHaveJSProperty('tagName', 'FIELDSET');
  await expect(page.locator('#api-protocol > legend')).toHaveText('API format');
  await expect(radios(page)).toHaveCount(2);
  for (const format of ['gemini', 'openai']) {
    await expect(page.locator(`#api-protocol-${format}`)).toHaveAttribute('type', 'radio');
    await expect(page.locator(`#api-protocol-${format}`)).toHaveAttribute('name', 'api-protocol');
    await expect(page.locator(`#api-protocol-${format}`)).toHaveAttribute('value', format);
  }
  await expect(page.locator('#api-protocol-gemini')).toBeChecked();
  for (const id of ['endpoint', 'api-key', 'toggle-key']) await expect(page.locator(`#connection-card #${id}`)).toHaveCount(1);
  for (const id of ['model-count', 'fetch-models', 'model-select']) await expect(page.locator(`#model-card #${id}`)).toHaveCount(1);
  await expect(page.locator('#connection-card p, #model-card p:not(#connection-status)')).toHaveCount(0);
  await expect(page.locator('#settings-panel-connection #model-key-link, #settings-panel-connection #model-details, #settings-panel-connection #protocol-help, #settings-panel-connection #endpoint-help, #settings-panel-connection .field-tag')).toHaveCount(0);
  await expect(page.locator('#connection-status')).toBeHidden();
  await expect(reload(page)).toHaveAttribute('title', 'Reload models');
  await expect(reload(page)).toHaveAttribute('type', 'submit');
  expect((await reload(page).textContent()).trim()).toBe('');
  await expect(reload(page).locator('svg')).toHaveCount(1);
  await fieldAssociations(page);
  await connect(page);
  await expect(page.locator('#connection-status')).toBeHidden();
  const heading = await page.locator('#model-card label[for="model-select"]').boundingBox();
  const count = await page.locator('#model-count').boundingBox();
  expect(count.x).toBeGreaterThanOrEqual(heading.x + heading.width - 1);
  expect(Math.abs(count.y + count.height / 2 - heading.y - heading.height / 2)).toBeLessThanOrEqual(10);
  await keyboardFocusReload(page);
  await fits(page, 1365, 900, { verticalControls: true });
  await page.screenshot({ path: 'artifacts/prism-connection-settings.png', fullPage: true, animations: 'disabled' });
});

test('native radio arrow selection persists while format changes clear credentials and model cache without API traffic', async ({ page }) => {
  const requests = [];
  await page.route(modelsPattern(CUSTOM), route => {
    requests.push(route.request().url());
    return route.fulfill({ json: { models: MODELS } });
  });
  await open(page);
  await page.locator('#endpoint').fill(CUSTOM);
  await connect(page);
  await page.locator('#model-select').selectOption('models/gemini-layout-7');
  await expect.poll(async () => (await saved(page)).settings.model).toBe('models/gemini-layout-7');
  await page.reload();
  await open(page, { navigate: false });
  await expect(page.locator('#endpoint')).toHaveValue(CUSTOM);
  await expect(page.locator('#api-key')).toHaveValue(KEY);
  await expect(page.locator('#model-select')).toHaveValue('models/gemini-layout-7');
  await expect(page.locator('#model-count')).toHaveText('29 models available');
  await page.locator('#toggle-key').click();
  await expect(page.locator('#api-key')).toHaveAttribute('type', 'text');
  await page.locator('#api-protocol-gemini').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#api-protocol-openai')).toBeChecked();
  await expect(page.locator('#api-protocol-openai')).toBeFocused();
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('#api-key')).toHaveAttribute('type', 'password');
  await expect(page.locator('#endpoint')).toHaveValue(CUSTOM);
  await expect(page.locator('#model-select')).toBeDisabled();
  await expect(page.locator('#model-count')).not.toContainText('29');
  await expect(page.locator('#connection-status')).toBeHidden();
  await expect.poll(async () => (await saved(page)).settings).toMatchObject({ protocol: 'openai', endpoint: CUSTOM, key: '', models: [] });
  expect(requests).toHaveLength(1);
  await page.reload();
  await open(page, { navigate: false });
  await expect(page.locator('#api-protocol-openai')).toBeChecked();
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('#endpoint')).toHaveValue(CUSTOM);
  await page.locator('#api-protocol-openai').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#api-protocol-gemini')).toBeChecked();
  await expect(page.locator('#api-protocol-gemini')).toBeFocused();
  await expect.poll(async () => (await saved(page)).settings.protocol).toBe('gemini');
  expect(requests).toHaveLength(1);
});

test('discovery exposes busy state and disables both cards, then restores controls after success and network failure', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let attempt = 0;
  await page.route(modelsPattern(GEMINI), async route => {
    attempt++;
    if (attempt === 1) await gate;
    if (attempt === 2) return route.abort('failed');
    return route.fulfill({ json: { models: MODELS } });
  });
  await open(page);
  await page.locator('#api-key').fill(KEY);
  await reload(page).click();
  try {
    await expect(reload(page)).toHaveAttribute('aria-busy', 'true');
    for (const selector of ['#api-protocol-gemini', '#api-protocol-openai', '#endpoint', '#api-key', '#toggle-key', '#fetch-models', '#model-select']) await expect(page.locator(selector)).toBeDisabled();
    await expect(page.locator('#connection-status')).toBeHidden();
  } finally { release(); }
  await expect(page.locator('#model-count')).toHaveText('29 models available');
  await expect(reload(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(reload(page)).toBeEnabled();
  await expect(radios(page).first()).toBeEnabled();
  await expect(page.locator('#model-select')).toBeEnabled();
  await reload(page).click();
  await readableError(page);
  await expect(reload(page)).not.toHaveAttribute('aria-busy', 'true');
  for (const selector of ['#api-protocol-gemini', '#api-protocol-openai', '#endpoint', '#api-key', '#toggle-key', '#fetch-models']) await expect(page.locator(selector)).toBeEnabled();
  await reload(page).click();
  await expect(page.locator('#connection-status')).toBeHidden();
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('#model-count')).toHaveText('29 models available');
  expect(attempt).toBe(3);
});

test('both cards inherit the disabled connection fieldset before application initialization', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/storage.js', async route => { await gate; await route.continue(); });
  await page.goto(base, { waitUntil: 'commit' });
  try {
    await page.locator('#connection-fields').waitFor({ state: 'attached' });
    for (const selector of ['#api-protocol-gemini', '#api-protocol-openai', '#endpoint', '#api-key', '#toggle-key', '#fetch-models', '#model-select']) await expect(page.locator(selector)).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
  await expect(page.locator('#endpoint')).toBeEnabled();
});

for (const width of [320, 390]) {
  test(`Connection cards, controls and network errors fit ${width}px mobile without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let fail = false;
    await page.route(modelsPattern(GEMINI), route => fail ? route.abort('failed') : route.fulfill({ json: { models: MODELS } }));
    await open(page);
    await fieldAssociations(page);
    await connect(page);
    await fits(page, width, 844, { verticalControls: true });
    await keyboardFocusReload(page);
    await page.screenshot({ path: `artifacts/prism-connection-settings-mobile-${width}.png`, fullPage: true, animations: 'disabled' });
    fail = true;
    await reload(page).click();
    await readableError(page);
    await fits(page, width, 844);
    await expect(reload(page)).toBeEnabled();
    await expect(reload(page)).not.toHaveAttribute('aria-busy', 'true');
  });
}
