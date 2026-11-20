import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';
let server, base;
test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));

test('conversation-only sidebar, settings tabs, keyboard dismissal and focus restoration', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(page.locator('#sidebar input, #sidebar select, #sidebar textarea')).toHaveCount(0);
  await expect(page.locator('#sidebar')).not.toContainText('privacy');
  await expect(page.locator('#sidebar')).not.toContainText('saved locally');
  await page.locator('#toggle-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#settings-tab-connection')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#settings-tab-tools')).toBeFocused();
  await expect(page.locator('#settings-panel-tools')).toBeVisible();
  await expect(page.locator('#settings-panel-connection')).toBeHidden();
  await page.locator('#settings-tab-instructions').click();
  await expect(page.locator('#system-prompt')).toBeVisible();
  await page.locator('#settings-tab-data').click();
  await expect(page.locator('#export-all')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(page.locator('#toggle-settings')).toBeFocused();
  await expect(page.locator('#toggle-settings')).toHaveAttribute('aria-expanded', 'false');
});

test('settings dropdown text has room for descenders on desktop, mobile and larger fonts', async ({ page }) => {
  const api = 'https://generativelanguage.googleapis.com/v1beta';
  await page.route(`${api}/models?*`, route => route.fulfill({ json: { models: [{ name: 'models/gemini-flash', displayName: 'Gemini Flash — gjpqy', supportedGenerationMethods: ['generateContent'] }] } }));
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  const select = page.locator('#model-select');
  const checkTextRoom = async () => {
    const metrics = await select.evaluate(element => {
      const css = getComputedStyle(element);
      // Chromium native selects can report line-height: normal even when CSS
      // specifies a number. Measure the font, including its descender region.
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      const font = context.measureText('ÅÉgjpqy');
      const line = parseFloat(css.lineHeight) || font.fontBoundingBoxAscent + font.fontBoundingBoxDescent;
      return { content: element.getBoundingClientRect().height - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom) - parseFloat(css.borderTopWidth) - parseFloat(css.borderBottomWidth), line };
    });
    expect(metrics.content).toBeGreaterThanOrEqual(metrics.line - 0.5);
  };
  await expect(select).toBeDisabled();
  await checkTextRoom();
  await page.locator('#api-key').fill('test-key');
  await page.locator('#fetch-models').click();
  await expect(select).toBeEnabled();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await checkTextRoom();
    await page.screenshot({ path: `artifacts/prism-dropdown-${width}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.addStyleTag({ content: '.settings-panel select { font-size: 20px; }' });
  await checkTextRoom();
});

test('mobile conversation drawer and settings popup fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#close-sidebar')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.locator('#toggle-sidebar')).toBeFocused();
  await page.locator('#toggle-settings').click();
  for (const name of ['connection', 'tools', 'instructions', 'data']) {
    await page.locator(`#settings-tab-${name}`).click();
    await expect(page.locator(`#settings-panel-${name}`)).toBeVisible();
  }
  const box = await page.locator('#settings-dialog').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/prism-settings-mobile.png', fullPage: true, animations: 'disabled' });
});
