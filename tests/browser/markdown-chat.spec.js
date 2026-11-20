import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from '../../server.mjs';

let server, base;
const API = 'https://generativelanguage.googleapis.com/v1beta';
const source = '## Project plan\n\nUse **bold**, *emphasis* and `inline code`.\n\n1. First step\n2. Second step\n\n> A useful quote\n\n| Task | Status |\n| --- | --- |\n| Markdown | Ready |\n\n```javascript\nconst html = "<img src=x onerror=alert(1)>";\n```\n\nSee [the docs](https://example.com/docs).\n\n![Project chart](https://images.markdown-chat.test/project.svg)';

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

test('assistant Markdown renders in chat and after reload while copy, export and history preserve source', async ({ page }) => {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedMarkdown = text; } } });
  });
  await page.route('https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route('https://images.markdown-chat.test/**', async route => {
    const headers = await route.request().allHeaders();
    expect(headers['x-goog-api-key']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="24"><rect width="64" height="24" fill="#a892df"/></svg>' });
  });
  await page.route(`${API}/models?*`, route => route.fulfill({ json: { models: [{ name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] }] } }));
  await page.route(`${API}/models/*:generateContent`, route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ text: source }] }, finishReason: 'STOP' }] } });
  });
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  await page.locator('#api-key').fill('mock-markdown-key');
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#close-settings').click();
  const prompt = '**Keep this user text literal**\n\n# Not a rendered heading';
  await page.locator('#message-input').fill(prompt);
  await page.locator('#send-button').click();
  const assistant = page.locator('.message.model .message-content');
  await expect(assistant.locator('h2')).toHaveText('Project plan');
  await expect(assistant.locator('strong')).toHaveText('bold');
  await expect(assistant.locator('em')).toHaveText('emphasis');
  await expect(assistant.locator('ol > li')).toHaveCount(2);
  await expect(assistant.locator('blockquote')).toContainText('A useful quote');
  await expect(assistant.locator('table tbody td')).toHaveText(['Markdown', 'Ready']);
  await expect(assistant.locator('pre code')).toContainText('<img src=x onerror=alert(1)>');
  await expect(assistant.locator('script')).toHaveCount(0);
  await expect(assistant.locator('img')).toHaveCount(1);
  await assistant.locator('img').scrollIntoViewIfNeeded();
  await expect.poll(() => assistant.locator('img').evaluate(image => image.complete && image.naturalWidth === 64)).toBe(true);
  await expect(assistant.locator('a')).toHaveAttribute('href', 'https://example.com/docs');
  await expect(page.locator('.message.user .message-content')).toHaveText(prompt);
  await expect(page.locator('.message.user .message-content strong,.message.user .message-content h1,.message.user .message-content img')).toHaveCount(0);
  await page.locator('.message.model .message-copy').click();
  expect(await page.evaluate(() => window.copiedMarkdown)).toBe(source);
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-data').click();
  await expect(page.locator('#storage-status')).toHaveText('Saved');
  await page.locator('#close-settings').click();
  const downloadWait = page.waitForEvent('download');
  await page.locator('#export-chat').click();
  const download = await downloadWait;
  expect(await readFile(await download.path(), 'utf8')).toContain(source);
  await page.reload();
  await expect(assistant.locator('h2')).toHaveText('Project plan');
  await expect(assistant.locator('table tbody td')).toHaveText(['Markdown', 'Ready']);
  await expect(assistant.locator('img')).toHaveCount(1);
  await assistant.locator('img').scrollIntoViewIfNeeded();
  await expect.poll(() => assistant.locator('img').evaluate(image => image.complete && image.naturalWidth === 64)).toBe(true);
  expect(requests).toHaveLength(1);
  await page.locator('#message-input').fill('Continue');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model h2')).toHaveCount(2);
  expect(requests[1].contents[1].parts[0].text).toBe(source);
  expect(errors).toEqual([]);
});
