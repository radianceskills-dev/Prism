import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from '../../build.mjs';

// Serve only the exported files via browser routing, with no Prism application server.
// A nested HTTPS URL also catches absolute-path and mixed-content regressions.
for (const protocol of ['gemini', 'openai']) {
test(`static export runs under an HTTPS subpath with direct ${protocol === 'gemini' ? 'Gemini' : 'OpenAI-compatible'} and MCP requests`, async ({ page }, testInfo) => {
  const output = testInfo.outputPath('site');
  await build(output);
  const localRequests = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const files = { 'index.html': 'text/html', 'styles.css': 'text/css', 'app.js': 'text/javascript', 'api.js': 'text/javascript', 'attachments.js': 'text/javascript', 'kilo.js': 'text/javascript', 'notion.js': 'text/javascript', 'mcp-client.js': 'text/javascript', 'composio.js': 'text/javascript', 'storage.js': 'text/javascript', 'parallel.mjs': 'text/javascript', 'favicon.svg': 'image/svg+xml', 'markdown.js': 'text/javascript', 'vendor-marked.js': 'text/javascript', 'vendor-dompurify.js': 'text/javascript', 'artefacts.js': 'text/javascript', 'artefact-frame.html': 'text/html', 'catbox.js': 'text/javascript' };
  await page.route('https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route('https://prism-static.test/**', async route => {
    localRequests.push({ method: route.request().method(), url: route.request().url() });
    const pathname = new URL(route.request().url()).pathname;
    const name = pathname === '/prism/' ? 'index.html' : pathname.startsWith('/prism/') ? pathname.slice('/prism/'.length) : '';
    if (route.request().method() !== 'GET' || !Object.hasOwn(files, name)) return route.fulfill({ status: 404, body: 'Static files only' });
    await route.fulfill({ contentType: files[name], body: await readFile(join(output, name)) });
  });
  const api = protocol === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://compatible.provider.test/v1';
  const models = protocol === 'gemini' ? { models: [{ name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: 'org/chat:variant' }] };
  await page.route(protocol === 'gemini' ? `${api}/models?*` : `${api}/models`, route => route.fulfill({ json: models }));
  let generation = 0;
  await page.route(protocol === 'gemini' ? `${api}/models/*:generateContent` : `${api}/chat/completions`, route => {
    const body = route.request().postDataJSON();
    expect(route.request().headers()['x-goog-api-key']).toBe(protocol === 'gemini' ? 'static-test-key' : undefined);
    expect(route.request().headers().authorization).toBe(protocol === 'openai' ? 'Bearer static-test-key' : undefined);
    const args = { objective: 'Find Node.js official docs', search_queries: ['Node.js documentation'] };
    if (++generation === 1) {
      if (protocol === 'openai') {
        expect(body.model).toBe('org/chat:variant');
        expect(body.messages[0].role).toBe('system');
        expect(body.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['parallel_search', 'prism_help']));
      }
      return route.fulfill({ json: protocol === 'gemini'
        ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'parallel_search', args } }] } }] }
        : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'static_search_1', type: 'function', function: { name: 'parallel_search', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] } });
    }
    const toolResult = protocol === 'gemini' ? body.contents.at(-1).parts[0].functionResponse.response : JSON.parse(body.messages.at(-1).content);
    expect(toolResult.text).toContain('https://nodejs.org');
    if (protocol === 'openai') {
      expect(body.messages.at(-1).role).toBe('tool');
      expect(body.messages.at(-1).tool_call_id).toBe('static_search_1');
    }
    const text = 'See [official docs](https://nodejs.org/en/docs).';
    return route.fulfill({ json: protocol === 'gemini'
      ? { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }
      : { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] } });
  });
  const methods = [];
  await page.route('https://search.parallel.ai/mcp', async route => {
    const request = route.request();
    expect(request.postData()).not.toContain('static-test-key');
    expect(request.headers()['x-goog-api-key']).toBeUndefined();
    expect(request.headers().authorization).toBeUndefined();
    const body = request.postDataJSON();
    methods.push(body.method);
    if (body.method === 'initialize') return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } } });
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Official Node.js documentation https://nodejs.org/en/docs' }] } } });
  });
  await page.goto('https://prism-static.test/prism/');
  await page.locator('#toggle-settings').click();
  await page.locator(`#api-protocol-${protocol}`).check();
  await page.locator('#endpoint').fill(api);
  await page.locator('#api-key').fill('static-test-key');
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await expect(page.locator('#connection-status')).toBeHidden();
  await page.locator('#settings-tab-tools').click();
  await page.getByRole('switch').check();
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Find the latest Node.js documentation');
  await page.locator('#send-button').click();
  await expect(page.locator('.search-activity summary')).toContainText('1 search completed');
  await expect(page.getByRole('link', { name: 'official docs' })).toHaveAttribute('href', 'https://nodejs.org/en/docs');
  expect(generation).toBe(2);
  expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  // Meta-policy fallback: a plain static host supplies no custom headers.
  // Images and link mediation must also work beneath the deployment subpath.
  await page.route('https://images.prism-static.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#a892df"/></svg>' }));
  await page.context().route('https://links.prism-static.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Static external link</title><h1>Static external link</h1>' }));
  await page.evaluate(async () => {
    const { renderAssistantContent } = await import('./artefacts.js');
    const target = document.createElement('div');
    target.id = 'static-artefact';
    document.querySelector('#messages').append(target);
    renderAssistantContent(target, '![Static Markdown image](https://images.prism-static.test/markdown.svg)\n\n<artefact title="Static counter"><!doctype html><html><body><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><img id="cdn" src="https://images.prism-static.test/artefact.svg"><a id="external" href="https://links.prism-static.test/destination" target="_self">Open external link</a></body></html></artefact>');
  });
  const child = page.frameLocator('#static-artefact .artefact-frame').frameLocator('iframe');
  const markdownImage = page.locator('#static-artefact img[alt="Static Markdown image"]');
  await markdownImage.scrollIntoViewIfNeeded();
  for (const image of [markdownImage, child.locator('#cdn')]) {
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth === 32)).toBe(true);
  }
  const counter = child.locator('#counter');
  await expect(counter).toHaveText('0');
  await counter.click();
  await expect(counter).toHaveText('1');
  const pendingPopup = page.context().waitForEvent('page');
  await child.locator('#external').click();
  const popup = await pendingPopup;
  await expect(popup).toHaveURL('https://links.prism-static.test/destination');
  await expect(popup.locator('h1')).toHaveText('Static external link');
  expect(await popup.evaluate(() => window.opener === null && document.referrer === '')).toBe(true);
  await popup.close();
  expect(page.url()).toBe('https://prism-static.test/prism/');
  await expect(counter).toHaveText('1');
  expect(localRequests.some(request => new URL(request.url).pathname === '/prism/artefact-frame.html')).toBe(true);
  expect(localRequests.every(request => request.method === 'GET' && new URL(request.url).pathname.startsWith('/prism/'))).toBe(true);
  expect(localRequests.some(request => request.url.endsWith('/prism/parallel.mjs'))).toBe(true);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => typeof Buffer)).toBe('undefined');
});
}
