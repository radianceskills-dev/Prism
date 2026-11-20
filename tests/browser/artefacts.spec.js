import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from '../../server.mjs';

let server, base;
const API = 'https://generativelanguage.googleapis.com/v1beta';
const COUNTER_HTML = '<!doctype html>\n<html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font:16px sans-serif;background:#f5f0ff}button{padding:10px}output{font-weight:bold}</style></head><body><h1>Interactive counter</h1><button id="increment">Increment</button> <output id="count">0</output><script>let count=0;document.querySelector("#increment").addEventListener("click",()=>{document.querySelector("#count").textContent=String(++count)});</script></body></html>';
const wrapper = (html, title = 'Interactive counter') => `<artefact title="${title}">${html}</artefact>`;

// The browser may inspect opaque sandbox frames through CDP; generated scripts may not.
const childOf = card => card.frameLocator('.artefact-frame').frameLocator('iframe');

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function openRenderer(page) {
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(base);
  await page.evaluate(async () => {
    const { renderAssistantContent } = await import('./artefacts.js');
    window.renderArtefactsUnderTest = renderAssistantContent;
    document.querySelector('#welcome')?.setAttribute('hidden', '');
    const article = document.createElement('article');
    article.className = 'message model';
    const main = document.createElement('div');
    main.className = 'message-main';
    const content = document.createElement('div');
    content.id = 'artefacts-under-test';
    content.className = 'message-content';
    main.append(content);
    article.append(main);
    document.querySelector('#messages').append(article);
  });
  return page.locator('#artefacts-under-test');
}

async function render(page, source) {
  await page.evaluate(text => window.renderArtefactsUnderTest(document.querySelector('#artefacts-under-test'), text), source);
}

async function frameHeight(card) {
  return card.locator('.artefact-frame').evaluate(element => element.getBoundingClientRect().height);
}

async function twoAnimationFrames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function expectMinimalChrome(card) {
  expect(await card.evaluate(element => element.tagName)).toBe('SECTION');
  await expect(card.locator(':scope > *')).toHaveCount(2);
  await expect(card.locator(':scope > iframe.artefact-frame')).toHaveCount(1);
  const download = card.locator(':scope > button.artefact-download');
  await expect(download).toHaveCount(1);
  await expect(card.getByRole('button')).toHaveCount(1);
  await expect(download).toHaveAttribute('aria-label', 'Download HTML');
  await expect(download).toHaveAttribute('title', 'Download HTML');
  expect(await download.textContent()).toBe('');
  await expect(download.locator('svg')).toHaveCount(1);
  await expect(download.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(card.locator('.artefact-toolbar,.artefact-title,.artefact-body,.artefact-source,[role="tablist"]')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^(Source|Preview)$/ })).toHaveCount(0);
  return download;
}

test('Off mode keeps multiple hostile artefacts as exact inert source with no frames, scripts or resource loads', async ({ page }) => {
  const content = await openRenderer(page);
  const requests = [];
  await page.route('https://off-mode.invalid/**', route => { requests.push(route.request().url()); return route.abort(); });
  const hostile = '\r\n</code></pre><img src="https://off-mode.invalid/escape.png" onerror="window.prismOffExecuted=true"><style>body{display:none}</style><script>window.prismOffExecuted=true;fetch("https://off-mode.invalid/script")</script>\r\n';
  const source = `## Before\n\n${wrapper(hostile, 'Hostile code')}\n\n**Between**\n\n${wrapper(COUNTER_HTML)}\n\n*After*`;
  await page.evaluate(text => window.renderArtefactsUnderTest(document.querySelector('#artefacts-under-test'), text, { enabled: false }), source);
  await expect(content.locator('pre code.language-html')).toHaveCount(2);
  expect(await content.locator('pre code.language-html').allTextContents()).toEqual([hostile, COUNTER_HTML]);
  await expect(content.locator('iframe,img,script,style,button,output')).toHaveCount(0);
  await expect(content.locator('h2')).toHaveText('Before');
  await expect(content.locator('strong')).toHaveText('Between');
  await expect(content.locator('em')).toHaveText('After');
  // Also tear down a previously running frame when the same container goes Off.
  await render(page, wrapper(COUNTER_HTML));
  await expect(childOf(content.locator('.artefact-card')).locator('#count')).toHaveText('0');
  await page.evaluate(text => window.renderArtefactsUnderTest(document.querySelector('#artefacts-under-test'), text, { enabled: false }), source);
  await expect(content.locator('iframe,.artefact-card')).toHaveCount(0);
  await twoAnimationFrames(page);
  expect(await page.evaluate(() => window.prismOffExecuted)).toBeUndefined();
  expect(requests).toEqual([]);
});

test('assistant artefact runs HTML, CSS and interactive JavaScript only inside nested opaque sandboxes', async ({ page }) => {
  const content = await openRenderer(page);
  await render(page, `## A working demo\n\nBefore **the preview**.\n\n${wrapper(COUNTER_HTML)}\n\nAfter *the preview*.`);
  const card = content.locator('.artefact-card');
  await expect(card).toHaveCount(1);
  await expectMinimalChrome(card);
  await expect(card.locator('.artefact-frame')).toHaveAttribute('title', 'Interactive counter');
  expect(await card.innerText()).toBe('');
  await expect(content.locator('h2')).toHaveText('A working demo');
  await expect(content.locator('.artefact-prose strong')).toHaveText('the preview');
  await expect(content.locator('em')).toHaveText('the preview');
  const host = card.locator('.artefact-frame');
  await expect(host).toHaveAttribute('sandbox', 'allow-scripts');
  const hostURL = new URL(await host.getAttribute('src'), base);
  expect(hostURL.origin).toBe(base);
  expect(hostURL.pathname).toBe('/artefact-frame.html');
  expect(hostURL.hash.length).toBeGreaterThan(20);
  const nested = card.frameLocator('.artefact-frame').locator('iframe');
  await expect(nested).toHaveAttribute('sandbox', 'allow-scripts');
  const child = childOf(card);
  await expect(child.locator('#count')).toHaveText('0');
  await child.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(child.locator('#count')).toHaveText('1');
  expect(await child.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 240, 255)');
  await expect(content.locator('script,style,button#increment,output#count')).toHaveCount(0);
});

test('sole icon download preserves exact octet-stream document bytes without resetting the live child', async ({ page }) => {
  const content = await openRenderer(page);
  const exactHTML = `\r\n  ${COUNTER_HTML.replaceAll('\n', '\r\n')}\r\n\r\n`;
  await page.evaluate(() => {
    const createObjectURL = URL.createObjectURL.bind(URL);
    window.artefactDownloadTypes = [];
    URL.createObjectURL = blob => {
      window.artefactDownloadTypes.push(blob.type);
      return createObjectURL(blob);
    };
  });
  await render(page, wrapper(exactHTML));
  const card = content.locator('.artefact-card');
  const downloadButton = await expectMinimalChrome(card);
  const frameURL = await card.locator('.artefact-frame').getAttribute('src');
  await childOf(card).getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(childOf(card).locator('#count')).toHaveText('1');
  const downloadWait = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadWait;
  expect(download.suggestedFilename()).toMatch(/\.html$/i);
  expect(await readFile(await download.path(), 'utf8')).toBe(exactHTML);
  expect(await page.evaluate(() => window.artefactDownloadTypes)).toEqual(['application/octet-stream']);
  await expect(card.locator('.artefact-frame')).toHaveAttribute('src', frameURL);
  await expect(childOf(card).locator('#count')).toHaveText('1');
  await childOf(card).getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(childOf(card).locator('#count')).toHaveText('2');
  await expectMinimalChrome(card);
});

test('artefact chrome is neutral and its faint icon-only download sits below the frame with visible keyboard focus', async ({ page }) => {
  const content = await openRenderer(page);
  await render(page, wrapper('<!doctype html><html><body><div style="height:180px">Unframed preview</div></body></html>', 'Accessible preview title'));
  const card = content.locator('.artefact-card');
  const download = await expectMinimalChrome(card);
  await expect(childOf(card).locator('body')).toContainText('Unframed preview');
  await expect.poll(() => frameHeight(card)).toBeGreaterThanOrEqual(180);
  const chrome = await card.evaluate(element => {
    const style = getComputedStyle(element);
    const frame = getComputedStyle(element.querySelector('iframe'));
    return {
      background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      frameBackground: frame.backgroundColor,
      frameBorders: [frame.borderTopWidth, frame.borderRightWidth, frame.borderBottomWidth, frame.borderLeftWidth],
    };
  });
  expect(chrome).toEqual({ background: 'rgba(0, 0, 0, 0)', image: 'none', shadow: 'none', borders: ['0px', '0px', '0px', '0px'], radii: ['0px', '0px', '0px', '0px'], padding: ['0px', '0px', '0px', '0px'], frameBackground: 'rgba(0, 0, 0, 0)', frameBorders: ['0px', '0px', '0px', '0px'] });
  const geometry = await card.evaluate(element => {
    const frame = element.querySelector('iframe').getBoundingClientRect();
    const button = element.querySelector('button').getBoundingClientRect();
    const style = getComputedStyle(element.querySelector('button'));
    return { frameBottom: frame.bottom, frameRight: frame.right, buttonTop: button.top, buttonRight: button.right, buttonBottom: button.bottom, width: button.width, height: button.height, cardBottom: element.getBoundingClientRect().bottom, position: style.position, float: style.cssFloat };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(32);
  expect(geometry.height).toBeGreaterThanOrEqual(32);
  expect(geometry.buttonTop).toBeGreaterThanOrEqual(geometry.frameBottom - .5);
  expect(Math.abs(geometry.buttonRight - geometry.frameRight)).toBeLessThanOrEqual(1);
  expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.cardBottom + .5);
  expect(['absolute', 'fixed']).not.toContain(geometry.position);
  expect(geometry.float).toBe('none');
  const iconOpacity = () => download.evaluate(element => Number(getComputedStyle(element).opacity) * Number(getComputedStyle(element.querySelector('svg')).opacity));
  await page.mouse.move(0, 0);
  await expect.poll(iconOpacity).toBeGreaterThanOrEqual(.2);
  await expect.poll(iconOpacity).toBeLessThanOrEqual(.45);
  await download.hover();
  await expect.poll(iconOpacity).toBeGreaterThanOrEqual(.8);
  await page.mouse.move(0, 0);
  await expect.poll(iconOpacity).toBeLessThanOrEqual(.45);
  await page.keyboard.press('Tab');
  await download.focus();
  expect(await download.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await expect.poll(iconOpacity).toBeGreaterThanOrEqual(.99);
  expect(await download.evaluate(element => {
    const style = getComputedStyle(element);
    return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1) || style.boxShadow !== 'none';
  })).toBe(true);
});

test('touch download has a 44px target below the preview and minimal chrome fits narrow mobile screens', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const content = await openRenderer(page);
    await render(page, wrapper('<!doctype html><html><body><div style="height:180px;width:100%">Mobile preview</div></body></html>', 'Hidden mobile title'));
    const card = content.locator('.artefact-card');
    const download = await expectMinimalChrome(card);
    await expect.poll(() => frameHeight(card)).toBeGreaterThanOrEqual(180);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await card.evaluate(element => {
        const card = element.getBoundingClientRect();
        const frame = element.querySelector('iframe').getBoundingClientRect();
        const button = element.querySelector('button').getBoundingClientRect();
        return { page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, cardLeft: card.left, cardRight: card.right, frameRight: frame.right, frameBottom: frame.bottom, buttonLeft: button.left, buttonRight: button.right, buttonTop: button.top, buttonWidth: button.width, buttonHeight: button.height };
      });
      expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.cardLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.cardRight).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.frameRight).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.buttonLeft).toBeGreaterThanOrEqual(geometry.cardLeft);
      expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.cardRight + .5);
      expect(geometry.buttonTop).toBeGreaterThanOrEqual(geometry.frameBottom - .5);
      expect(geometry.buttonWidth).toBeGreaterThanOrEqual(44);
      expect(geometry.buttonHeight).toBeGreaterThanOrEqual(44);
    }
    await expect(download).toHaveAccessibleName('Download HTML');
    expect(await card.innerText()).toBe('');
  } finally { await context.close(); }
});

test('fenced and inline wrappers stay code, raw HTML stays inert, and Markdown still renders around a real artefact', async ({ page }) => {
  const content = await openRenderer(page);
  const requested = [];
  await page.route('**/*artefact-probe*', route => { requested.push(route.request().url()); return route.fulfill({ body: '' }); });
  const example = wrapper('<h1>Example only</h1>', 'Do not run');
  await render(page, [
    `\`${example}\``,
    `\`\`\`html\n${example}\n\`\`\``,
    `~~~html\n${example}\n~~~`,
    '<script>window.artefactEscaped=true</script>',
    '<img src="https://example.invalid/artefact-probe-raw" onerror="window.artefactEscaped=true">',
    '**Actual preview follows:**',
    wrapper(COUNTER_HTML),
    '### End of message',
  ].join('\n\n'));
  await expect(content.locator('.artefact-card')).toHaveCount(1);
  await expect(childOf(content.locator('.artefact-card')).locator('#count')).toHaveText('0');
  await expect(content.locator('pre code').filter({ hasText: 'Example only' })).toHaveCount(2);
  await expect(content.locator('p code').filter({ hasText: 'Example only' })).toHaveCount(1);
  await expect(content.locator('.artefact-prose strong')).toHaveText('Actual preview follows:');
  await expect(content.locator('h3')).toHaveText('End of message');
  await expect(content.locator('img,script')).toHaveCount(0);
  expect(await page.evaluate(() => window.artefactEscaped)).toBeUndefined();
  expect(requested).toEqual([]);
});

test('parser guards quoted/list fences, raw examples and escaped tags while preserving CRLF and inert hostile titles', async ({ page }) => {
  const content = await openRenderer(page);
  const probes = [];
  await page.route('**/*artefact-probe*', route => { probes.push(route.request().url()); return route.fulfill({ body: '' }); });
  const example = wrapper('<h1>Do not execute this example</h1>', 'Example only');
  const html = '\r\n<!doctype html>\r\n<html><body><p id="actual">Actual CRLF preview</p></body></html>\r\n';
  const hostileTitle = "<img src='https://example.invalid/artefact-probe-title' onerror='window.artefactTitleExecuted=true'>";
  const source = [
    `> ~~~html\n> ${example}\n> ~~~`,
    `- ~~~html\n  ${example}\n  ~~~`,
    `> - ~~~html\n>   ${example}\n>   ~~~`,
    `>     ${example}`,
    `<!-- ${example} -->`,
    `<script>${example}</script>`,
    `<pre>${example}</pre>`,
    `<span data-example='${example}'>Literal attribute example</span>`,
    `<div\n data-example='>${example}'>Multiline quoted attribute</div>`,
    `<pre data-example=">">${example}</pre>`,
    `\\${example}`,
    wrapper(html, hostileTitle),
  ].join('\n\n');
  const parsed = await page.evaluate(async text => (await import('./artefacts.js')).splitArtefacts(text), source);
  expect(parsed.filter(part => part.type === 'artefact')).toEqual([{ type: 'artefact', title: hostileTitle, html }]);
  await render(page, source);
  const card = content.locator('.artefact-card');
  await expect(card).toHaveCount(1);
  const downloadButton = await expectMinimalChrome(card);
  await expect(card.locator('.artefact-frame')).toHaveAttribute('title', hostileTitle);
  expect(await card.innerText()).toBe('');
  await expect(childOf(card).locator('#actual')).toHaveText('Actual CRLF preview');
  const downloadWait = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadWait;
  expect(await readFile(await download.path(), 'utf8')).toBe(html);
  await expect(card.locator('.artefact-frame')).toHaveAttribute('title', hostileTitle);
  await expect(content.locator('img,script')).toHaveCount(0);
  expect(await page.evaluate(() => window.artefactTitleExecuted)).toBeUndefined();
  expect(probes).toEqual([]);
});

test('unclosed, orphaned, nested and broken wrapper syntax stays inert', async ({ page }) => {
  const content = await openRenderer(page);
  for (const source of [
    '<artefact title="Unclosed"><script>window.artefactEscaped=true</script>',
    '<h1>Orphan closing tag</h1></artefact>',
    '<artefact title="Outer"><artefact title="Inner"><h1>Nested</h1></artefact></artefact>',
    '<artefact title="Broken><h1>Broken quote</h1></artefact>',
  ]) {
    await render(page, source);
    await expect(content.locator('.artefact-card,iframe,script,h1')).toHaveCount(0);
    await expect(content).not.toBeEmpty();
    expect(await page.evaluate(() => window.artefactEscaped)).toBeUndefined();
  }
});

test('autoheight exceeds 4000px, grows and shrinks without a maximum, and fits a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const content = await openRenderer(page);
  const html = '<!doctype html><html><head><style>html,body{margin:0;padding:0;width:100%;box-sizing:border-box}#spacer{height:4600px;width:100%;background:#e9ddff}</style></head><body><button id="grow">Grow</button><button id="shrink">Shrink</button><div id="spacer"></div><script>document.querySelector("#grow").onclick=()=>document.querySelector("#spacer").style.height="6200px";document.querySelector("#shrink").onclick=()=>document.querySelector("#spacer").style.height="70px";</script></body></html>';
  await render(page, wrapper(html, 'Tall responsive preview'));
  const card = content.locator('.artefact-card');
  const child = childOf(card);
  await expect.poll(() => frameHeight(card)).toBeGreaterThan(4500);
  expect(await card.locator('.artefact-frame').evaluate(element => getComputedStyle(element).maxHeight)).toBe('none');
  const firstHeight = await frameHeight(card);
  await child.getByRole('button', { name: 'Grow', exact: true }).click();
  await expect.poll(() => frameHeight(card)).toBeGreaterThan(6100);
  expect(await frameHeight(card)).toBeGreaterThan(firstHeight + 1400);
  await child.getByRole('button', { name: 'Shrink', exact: true }).click();
  await expect.poll(() => frameHeight(card)).toBeLessThan(500);
  const geometry = await card.evaluate(element => ({
    page: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    card: element.getBoundingClientRect().width,
    frame: element.querySelector('.artefact-frame').getBoundingClientRect().width,
  }));
  expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.card).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.frame).toBeLessThanOrEqual(geometry.card);
});

test('generated scripts cannot read storage or parent documents, navigate top, submit forms or open popups', async ({ page, context }) => {
  const content = await openRenderer(page);
  await page.evaluate(() => {
    localStorage.setItem('artefact-parent-secret', 'do-not-leak');
    document.body.dataset.artefactUntouched = 'yes';
  });
  const probes = [], popups = [];
  await page.route('**/*artefact-probe*', route => { probes.push(route.request().url()); return route.fulfill({ body: '' }); });
  context.on('page', popup => popups.push(popup));
  const html = '<!doctype html><html><body><output id="security-result"></output><form id="form" action="https://example.invalid/artefact-probe-form" method="POST"><input name="secret" value="test"></form><script>const report={};for(const [name,fn] of Object.entries({storage:()=>localStorage.getItem("artefact-parent-secret"),parent:()=>parent.document.body.dataset.artefactUntouched="changed",top:()=>top.location.href="https://example.invalid/artefact-probe-top"})){try{fn();report[name]="allowed"}catch{report[name]="blocked"}}report.popup=window.open("https://example.invalid/artefact-probe-popup")===null?"blocked":"allowed";document.querySelector("#form").requestSubmit();document.querySelector("#security-result").textContent=JSON.stringify(report);</script></body></html>';
  await render(page, wrapper(html, 'Security probes'));
  const output = childOf(content.locator('.artefact-card')).locator('#security-result');
  await expect(output).not.toBeEmpty();
  expect(JSON.parse(await output.textContent())).toEqual({ storage: 'blocked', parent: 'blocked', top: 'blocked', popup: 'blocked' });
  await twoAnimationFrames(page);
  expect(await page.evaluate(() => ({ secret: localStorage.getItem('artefact-parent-secret'), untouched: document.body.dataset.artefactUntouched }))).toEqual({ secret: 'do-not-leak', untouched: 'yes' });
  expect(page.url()).toBe(`${base}/`);
  expect(probes).toEqual([]);
  expect(popups).toEqual([]);
});

test('HTTPS CDN images, srcset and CSS backgrounds load without a referrer and resize for intrinsic image height', async ({ page }) => {
  const content = await openRenderer(page);
  const requests = [];
  const cdn = 'https://images.prism-test.invalid';
  await page.route(`${cdn}/**`, route => {
    requests.push({ url: route.request().url(), referrer: route.request().headers().referer });
    const tall = route.request().url().endsWith('/tall.svg');
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="${tall ? 900 : 18}"><rect width="24" height="100%" fill="#8d72bd"/></svg>` });
  });
  const blocked = [];
  await page.route('http://images.prism-test.invalid/**', route => { blocked.push(route.request().url()); return route.fulfill({ body: 'must not load' }); });
  const html = `<!doctype html><html><head><style>body{margin:0}img{display:block;max-width:100%;height:auto}#background{width:30px;height:20px;background-image:url('${cdn}/background.svg')}</style></head><body><img id="hero" src="${cdn}/hero.svg" alt="CDN hero"><img id="responsive" src="${cdn}/fallback.svg" srcset="${cdn}/one.svg 1x, ${cdn}/two.svg 2x" alt="Responsive CDN image"><div id="background"></div><img id="insecure" src="http://images.prism-test.invalid/plain.svg" alt="Blocked HTTP image"></body></html>`;
  await render(page, wrapper(html, 'CDN images'));
  const card = content.locator('.artefact-card');
  const child = childOf(card);
  await expect.poll(() => child.locator('#hero').evaluate(image => image.complete && image.naturalWidth)).toBe(24);
  await expect.poll(() => child.locator('#responsive').evaluate(image => image.complete && image.naturalWidth)).toBe(24);
  expect(await child.locator('#responsive').evaluate(image => image.currentSrc)).toMatch(/https:\/\/images\.prism-test\.invalid\/(one|two)\.svg$/);
  await expect.poll(() => requests.some(request => request.url === `${cdn}/background.svg`)).toBe(true);
  expect(requests.every(request => request.referrer === undefined)).toBe(true);
  expect(await child.locator('#insecure').evaluate(image => image.naturalWidth)).toBe(0);
  expect(blocked).toEqual([]);
  const initialHeight = await frameHeight(card);
  await child.locator('#hero').evaluate((image, url) => { image.src = url; }, `${cdn}/tall.svg`);
  await expect.poll(() => child.locator('#hero').evaluate(image => image.complete && image.naturalHeight)).toBe(900);
  await expect.poll(() => frameHeight(card)).toBeGreaterThan(900);
  expect(await frameHeight(card)).toBeGreaterThan(initialHeight + 800);
  await expectMinimalChrome(card);
});

test('clicked web links open separate isolated tabs for missing or overridden targets, keyboard, middle click and dynamic links', async ({ page, context }) => {
  test.setTimeout(60000);
  const content = await openRenderer(page);
  const destination = 'https://links.prism-test.invalid';
  const requests = [];
  await context.route(`${destination}/**`, route => {
    requests.push({ url: route.request().url(), referrer: route.request().headers().referer });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>External destination</title><p id="destination">Opened safely</p>' });
  });
  const html = `<!doctype html><html><head><style>body{padding:12px;font:15px sans-serif}a,button{display:block;margin:8px 0;padding:7px}</style></head><body><a id="plain" href="${destination}/plain"><span>Missing target</span></a><a id="self" target="_self" href="${destination}/self">Self target</a><a id="top" target="_top" href="${destination}/top">Top target</a><a id="blank" target="_blank" href="${destination}/blank">Blank target</a><a id="keyboard" href="${destination}/keyboard">Keyboard link</a><a id="middle" href="${destination}/middle">Middle click link</a><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="160" height="30"><a id="svg" xlink:href="${destination}/svg"><text x="0" y="20">SVG chart link</text></a></svg><div id="shadow-host"></div><button id="add">Add a dynamic link</button><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<a id="shadow" href="${destination}/shadow">Shadow DOM link</a>';document.querySelector('#add').onclick=()=>{const link=document.createElement('a');link.id='dynamic';link.href='${destination}/dynamic';link.textContent='Dynamic link';document.body.append(link)};</script></body></html>`;
  await render(page, wrapper(html, 'External links'));
  const card = content.locator('.artefact-card');
  const child = childOf(card);
  const frameURL = await card.locator('.artefact-frame').getAttribute('src');
  for (const [id, action] of [['plain', 'click'], ['self', 'click'], ['top', 'click'], ['blank', 'click'], ['keyboard', 'keyboard'], ['middle', 'middle'], ['svg', 'click'], ['shadow', 'click'], ['dynamic', 'click']]) {
    await test.step(`Open ${id} using ${action}`, async () => {
      if (id === 'dynamic') await child.locator('#add').click();
      const pending = context.waitForEvent('page', { timeout: 5000 });
      if (action === 'keyboard') await child.locator(`#${id}`).press('Enter');
      else await child.locator(`#${id}`).click(action === 'middle' ? { button: 'middle' } : {});
      const popup = await pending.catch(error => { throw new Error(`Link ${id} (${action}) did not open: ${error.message}`); });
      await popup.waitForLoadState('domcontentloaded');
      await expect(popup.locator('#destination')).toHaveText('Opened safely');
      expect(popup.url()).toBe(`${destination}/${id}`);
      expect(await popup.evaluate(() => ({ noOpener: window.opener === null, referrer: document.referrer }))).toEqual({ noOpener: true, referrer: '' });
      await popup.close();
      expect(page.url()).toBe(`${base}/`);
      await expect(card.locator('.artefact-frame')).toHaveAttribute('src', frameURL);
      expect(await child.locator('body').evaluate(() => location.href)).toBe('about:srcdoc');
      await expect(card.locator('.artefact-frame')).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(card.frameLocator('.artefact-frame').locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    });
  }
  expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/plain', '/self', '/top', '/blank', '/keyboard', '/middle', '/svg', '/shadow', '/dynamic']);
  expect(requests.every(request => request.referrer === undefined)).toBe(true);
});

test('unsafe links, synthetic clicks and forged link channels cannot open tabs even during real user activation', async ({ page, context }) => {
  const content = await openRenderer(page);
  const popups = [], probes = [];
  context.on('page', popup => popups.push(popup));
  await context.route(/artefact-link-probe/, route => { probes.push(route.request().url()); return route.fulfill({ body: 'External test destination' }); });
  const destination = 'https://links.prism-test.invalid/artefact-link-probe';
  const html = `<!doctype html><html><head><style>body{padding:12px;font:15px sans-serif}a,button{display:block;margin:8px 0;padding:7px}</style></head><body><button id="attack">A real unrelated button</button><a id="synthetic" href="${destination}/synthetic">Scripted link</a><a id="javascript" href="javascript:document.querySelector('#unsafe-ran').textContent='executed'">Unsafe script URL</a><a id="data" href="data:text/html,blocked">Unsafe data URL</a><a id="credentials" href="https://user:password@links.prism-test.invalid/artefact-link-probe-credentials">Credential-bearing URL</a><a id="relative" href="/artefact-link-probe-relative">Relative URL</a><a id="protocol-relative" href="//links.prism-test.invalid/artefact-link-probe-relative">Protocol-relative URL</a><a id="mailto" href="mailto:test@example.invalid">Mail URL</a><output id="unsafe-ran">unchanged</output><output id="attack-result">initializing</output><script>
  const key=document.scripts[0].textContent.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)?.[0];
  const channel=new MessageChannel();
  parent.postMessage({type:'prism-artefact-link-channel',key},'*',[channel.port2]);
  const forge=()=>{
    window.open('${destination}/direct-window-open');
    channel.port1.postMessage({type:'open-link',url:'${destination}/forged-port'});
    parent.postMessage({type:'prism-artefact-open-link',key,token:key,url:'${destination}/forged-host'},'*');
    top.postMessage({type:'prism-artefact-open-link',token:document.body.dataset.outerToken||key,url:'${destination}/forged-app'},'*');
    document.querySelector('#synthetic').click();
    document.querySelector('#synthetic').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
  };
  forge();
  Element.prototype.closest=function(){return document.querySelector('#synthetic')};
  Event.prototype.composedPath=function(){return [document.querySelector('#synthetic')]};
  String.prototype.trim=function(){return '${destination}/forged-trim'};
  for(const [name,value] of Object.entries({protocol:'https:',href:'${destination}/forged-getter',username:'',password:''}))Object.defineProperty(URL.prototype,name,{get(){return value}});
  window.URL=function(){return {protocol:'https:',href:'${destination}/forged-url',username:'',password:''}};
  document.querySelector('#attack').onclick=()=>{forge();document.querySelector('#attack-result').textContent='attack finished'};
  document.querySelector('#attack-result').textContent=key?'key recovered':'missing key';
  </script></body></html>`;
  await render(page, wrapper(html, 'Link security probes'));
  const card = content.locator('.artefact-card');
  const child = childOf(card);
  await expect(child.locator('#attack-result')).toHaveText('key recovered');
  const token = new URL(await card.locator('.artefact-frame').getAttribute('src')).hash.slice(1);
  await child.locator('body').evaluate((body, value) => { body.dataset.outerToken = value; }, token);
  await child.locator('#attack').click();
  await expect(child.locator('#attack-result')).toHaveText('attack finished');
  for (const id of ['javascript', 'data', 'credentials', 'relative', 'protocol-relative', 'mailto']) await child.locator(`#${id}`).click();
  await twoAnimationFrames(page);
  expect(popups).toEqual([]);
  expect(probes).toEqual([]);
  await expect(child.locator('#unsafe-ran')).toHaveText('unchanged');
  expect(page.url()).toBe(`${base}/`);
  expect(await child.locator('body').evaluate(() => location.href)).toBe('about:srcdoc');
  // A real click still uses the actual href, not poisoned trim/URL getters.
  const pending = context.waitForEvent('page', { timeout: 5000 });
  await child.locator('#synthetic').click();
  const popup = await pending;
  await popup.waitForLoadState('domcontentloaded');
  expect(popup.url()).toBe(`${destination}/synthetic`);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
  expect(popups).toHaveLength(1);
  expect(probes).toEqual([`${destination}/synthetic`]);
});

test('artifact CSP blocks external and same-origin fetches, HTTP images, scripts, styles and child frames', async ({ page }) => {
  const content = await openRenderer(page);
  const probes = [];
  await page.route('**/*artefact-probe*', route => { probes.push(route.request().url()); return route.fulfill({ contentType: 'text/javascript', body: 'window.remoteArtefactScript=true;' }); });
  const local = `${base}/artefact-probe-local`;
  const remote = 'https://example.invalid/artefact-probe';
  const html = `<!doctype html><html><head><link rel="stylesheet" href="${remote}-style"><style>@import url("${local}-style");body{background-image:url("http://example.invalid/artefact-probe-background")}</style></head><body><img src="http://example.invalid/artefact-probe-image"><img src="${local}-image"><script src="${remote}-script"></script><script src="${local}-script"></script><iframe src="${remote}-frame"></iframe><iframe src="${local}-frame"></iframe><output id="network-result">running</output><script>Promise.allSettled([fetch(${JSON.stringify(remote + '-fetch')}),fetch(${JSON.stringify(local + '-fetch')})]).then(results=>document.querySelector("#network-result").textContent=JSON.stringify(results.map(result=>result.status)));</script></body></html>`;
  await render(page, wrapper(html, 'Network probes'));
  const card = content.locator('.artefact-card');
  const child = childOf(card);
  await expect(child.locator('#network-result')).toHaveText('["rejected","rejected"]');
  await twoAnimationFrames(page);
  expect(await child.locator('body').evaluate(() => window.remoteArtefactScript)).toBeUndefined();
  const policy = await child.locator('meta[http-equiv="Content-Security-Policy" i]').getAttribute('content');
  expect(policy).toMatch(/(?:^|;)\s*frame-src\s+'none'(?:\s*;|$)/);
  expect(probes).toEqual([]);
});

test('trusted host blocks generated iframe self-navigation and meta refresh before network dispatch', async ({ page }) => {
  const content = await openRenderer(page);
  const probes = [], blocked = [];
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('frame-src about:')) blocked.push(message.text());
  });
  await page.route('**/*artefact-probe*', route => { probes.push(route.request().url()); return route.fulfill({ body: '<p>Unexpected navigation</p>' }); });
  for (const destination of [`${base}/artefact-probe-self`, 'https://example.invalid/artefact-probe-self']) {
    const html = `<!doctype html><html><body><button id="navigate">Attempt navigation</button><output id="attempt-result">ready</output><script>document.querySelector("#navigate").onclick=()=>{try{location.href=${JSON.stringify(destination)}}catch{}document.querySelector("#attempt-result").textContent="attempted"};</script></body></html>`;
    await render(page, wrapper(html, 'Self-navigation probe'));
    const child = childOf(content.locator('.artefact-card'));
    const blockedBefore = blocked.length;
    await child.getByRole('button', { name: 'Attempt navigation', exact: true }).click();
    // Chromium may replace the child with a blocked-navigation error document.
    // Assert the browser's actual CSP decision, not retention of the old DOM.
    await expect.poll(() => blocked.length).toBeGreaterThan(blockedBefore);
    expect(probes).toEqual([]);
    expect(page.url()).toBe(`${base}/`);
  }
  for (const destination of [`${base}/artefact-probe-refresh`, 'https://example.invalid/artefact-probe-refresh']) {
    const html = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${destination}"></head><body><output id="refresh-result">refresh blocked</output></body></html>`;
    const blockedBefore = blocked.length;
    await render(page, wrapper(html, 'Meta refresh probe'));
    await expect.poll(() => blocked.length).toBeGreaterThan(blockedBefore);
    expect(probes).toEqual([]);
    expect(page.url()).toBe(`${base}/`);
  }
});

test('multiple independent cards ignore forged window messages and do not mutate the parent', async ({ page }) => {
  const content = await openRenderer(page);
  await page.evaluate(() => {
    window.artefactMessages = [];
    window.addEventListener('message', event => {
      if (event.data && typeof event.data === 'object') {
        try { window.artefactMessages.push(JSON.parse(JSON.stringify(event.data))); } catch { /* Non-JSON messages are unrelated. */ }
      }
    });
  });
  await render(page, `${wrapper(COUNTER_HTML, 'First counter')}\n\n${wrapper(COUNTER_HTML, 'Second counter')}`);
  const cards = content.locator('.artefact-card');
  await expect(cards).toHaveCount(2);
  await expect(childOf(cards.nth(0)).locator('#count')).toHaveText('0');
  await expect(childOf(cards.nth(1)).locator('#count')).toHaveText('0');
  await childOf(cards.nth(0)).getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(childOf(cards.nth(0)).locator('#count')).toHaveText('1');
  await expect(childOf(cards.nth(1)).locator('#count')).toHaveText('0');
  const tokens = await cards.locator('.artefact-frame').evaluateAll(frames => frames.map(frame => new URL(frame.src).hash.slice(1)));
  expect(tokens[0].length).toBeGreaterThan(20);
  expect(tokens[1]).not.toBe(tokens[0]);
  await expect.poll(() => page.evaluate(() => window.artefactMessages.filter(message => message.type === 'prism-artefact-resize').length)).toBeGreaterThanOrEqual(2);
  const before = [await frameHeight(cards.nth(0)), await frameHeight(cards.nth(1))];
  // Correct event.source but incorrect token must also be ignored.
  await cards.nth(0).frameLocator('.artefact-frame').locator('body').evaluate((_body, otherToken) => {
    parent.postMessage({ type: 'prism-artefact-resize', token: 'wrong-token', height: 31000, command: 'window.artefactParentExecuted=true' }, '*');
    parent.postMessage({ type: 'prism-artefact-resize', token: otherToken, height: 31000 }, '*');
  }, tokens[1]);
  await page.evaluate(() => {
    const mutateHeights = value => {
      if (Array.isArray(value)) return value.map(mutateHeights);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /height/i.test(key) && typeof item === 'number' ? 31000 : mutateHeights(item)]));
    };
    // Replay real channel/token data from a different source window. A receiver
    // checking only a secret or message shape (not event.source) would accept it.
    for (const message of window.artefactMessages) window.postMessage(mutateHeights(message), '*');
    for (const type of ['prism-artefact-resize', 'prism-artefact-init', 'resize', 'artefact-resize', 'artefact:resize', 'artefact:height']) {
      window.postMessage({ type, token: 'wrong-token', channel: 'wrong-channel', height: 31000, command: 'window.artefactParentExecuted=true' }, '*');
    }
  });
  await twoAnimationFrames(page);
  const after = [await frameHeight(cards.nth(0)), await frameHeight(cards.nth(1))];
  expect(after[0]).toBeLessThan(before[0] + 20);
  expect(after[1]).toBeLessThan(before[1] + 20);
  expect(await page.evaluate(() => window.artefactParentExecuted)).toBeUndefined();
});

test('actual chat renders assistant artefacts, leaves user wrappers literal, and restores functional preview without regenerating', async ({ page }) => {
  const modelBodies = [];
  const response = `## Counter demo\n\n${wrapper(COUNTER_HTML)}\n\nThis **counter** runs inside the preview.`;
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route(`${API}/models?*`, route => route.fulfill({ json: { models: [{ name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] }] } }));
  await page.route(`${API}/models/*:generateContent`, route => {
    modelBodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ text: response }] }, finishReason: 'STOP' }] } });
  });
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  await page.locator('#api-key').fill('mock-artefact-key');
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#close-settings').click();
  const prompt = `Make a counter like this: ${wrapper('<h1>User source only</h1>', 'User example')}`;
  await page.locator('#message-input').fill(prompt);
  await page.locator('#send-button').click();
  const card = page.locator('.message.model .artefact-card');
  await expect(card).toHaveCount(1);
  await expect(page.locator('.message.user .message-content')).toHaveText(prompt);
  await expect(page.locator('.message.user .artefact-card,.message.user iframe')).toHaveCount(0);
  await expect(page.locator('.message.model h2')).toHaveText('Counter demo');
  await childOf(card).getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(childOf(card).locator('#count')).toHaveText('1');
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-data').click();
  await expect(page.locator('#storage-status')).toHaveText('Saved');
  await page.reload();
  await expect(card).toHaveCount(1);
  await expect(childOf(card).locator('#count')).toHaveText('0');
  await childOf(card).getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(childOf(card).locator('#count')).toHaveText('1');
  expect(modelBodies).toHaveLength(1);
});
