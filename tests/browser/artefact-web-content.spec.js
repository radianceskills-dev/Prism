import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

let server, base;
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const CDN = 'https://images.prism-web-content.test';
const SITE = 'https://links.prism-web-content.test';

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function openArtefact(page, html) {
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(base);
  await page.evaluate(async html => {
    const { renderAssistantContent } = await import('./artefacts.js');
    document.querySelector('#welcome').hidden = true;
    const container = document.createElement('div');
    container.id = 'web-content-under-test';
    document.querySelector('#messages').append(container);
    renderAssistantContent(container, `<artefact title="Embedded web content">${html}</artefact>`);
  }, html);
  return page.frameLocator('#web-content-under-test .artefact-frame').frameLocator('iframe');
}

test('HTTPS CDN img, responsive picture/srcset, and CSS background resources load without a referrer', async ({ page }) => {
  const requests = [];
  await page.route(`${CDN}/**`, async route => {
    requests.push({ url: route.request().url(), headers: await route.request().allHeaders() });
    await route.fulfill({ contentType: 'image/png', body: IMAGE });
  });
  const child = await openArtefact(page, `<!doctype html><html><body style="margin:0"><img id="plain" width="40" height="30" src="${CDN}/plain.png"><picture><source srcset="${CDN}/responsive.png 1x, ${CDN}/responsive-2x.png 2x"><img id="responsive" width="40" height="30" src="${CDN}/fallback.png"></picture><div id="background" style="width:40px;height:30px;background-image:url('${CDN}/background.png')"></div></body></html>`);
  for (const selector of ['#plain', '#responsive']) {
    await expect.poll(() => child.locator(selector).evaluate(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)).toBe(true);
  }
  await expect.poll(() => requests.some(request => request.url.endsWith('/background.png'))).toBe(true);
  expect(requests.some(request => /\/responsive(?:-2x)?\.png$/.test(request.url))).toBe(true);
  expect(requests.every(request => !request.headers.referer)).toBe(true);
  expect(requests.every(request => !request.headers.cookie)).toBe(true);
  await expect(page.locator('#web-content-under-test > .artefact-card > .artefact-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('#web-content-under-test .artefact-frame').locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
});

test('ordinary, _self, _top and dynamically inserted links open detached destination tabs and leave the preview running', async ({ page, context }) => {
  const destinationRequests = [];
  await context.route(`${SITE}/**`, async route => {
    destinationRequests.push({ url: route.request().url(), headers: await route.request().allHeaders() });
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>External destination</title><h1>External destination</h1><script>document.body.dataset.scriptRan="yes"</script>' });
  });
  const child = await openArtefact(page, `<!doctype html><html><body style="padding:16px"><a id="ordinary" href="${SITE}/ordinary">Ordinary link</a><br><a id="self" href="${SITE}/self" target="_self">Self-target link</a><br><a id="top" href="${SITE}/top" target="_top">Top-target link</a><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><script>const link=document.createElement('a');link.id='dynamic';link.href='${SITE}/dynamic';link.textContent='Dynamic keyboard link';document.body.append(link)</script></body></html>`);
  await child.locator('#counter').click();
  const originalURL = page.url();
  for (const id of ['ordinary', 'self', 'top', 'dynamic']) {
    const pending = context.waitForEvent('page');
    if (id === 'dynamic') await child.locator(`#${id}`).press('Enter');
    else await child.locator(`#${id}`).click();
    const popup = await pending;
    await expect(popup).toHaveURL(`${SITE}/${id}`);
    await expect(popup.locator('h1')).toHaveText('External destination');
    await expect(popup.locator('body')).toHaveAttribute('data-script-ran', 'yes');
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe('');
    await popup.close();
    expect(page.url()).toBe(originalURL);
    await expect(child.locator('#counter')).toHaveText('1');
  }
  expect(destinationRequests).toHaveLength(4);
  expect(destinationRequests.every(request => !request.headers.referer)).toBe(true);
  await child.locator('#counter').click();
  await expect(child.locator('#counter')).toHaveText('2');
});

test('unsafe links and synthetic link clicks cannot open tabs or execute javascript', async ({ page, context }) => {
  const opened = [];
  context.on('page', popup => opened.push(popup));
  const child = await openArtefact(page, `<!doctype html><html><body style="padding:16px"><a id="javascript" href="javascript:document.body.dataset.executed='yes'">Unsafe script</a><br><a id="credentials" href="https://name:password@links.prism-web-content.test/private">Credential URL</a><br><a id="data" href="data:text/html,unsafe">Unsafe data</a><a id="synthetic" href="${SITE}/synthetic">Synthetic link</a><button id="trigger" onclick="document.querySelector('#synthetic').click()">Trigger synthetic click</button></body></html>`);
  for (const id of ['javascript', 'credentials', 'data']) await child.locator(`#${id}`).click();
  await child.locator('#trigger').click();
  await child.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(opened).toEqual([]);
  await expect(child.locator('body')).not.toHaveAttribute('data-executed');
  expect(page.url()).toBe(`${base}/`);
});
