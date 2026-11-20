import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

let server;
let base;

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function openRenderer(page) {
  // The app's optional Tailwind CDN is not required by this local renderer.
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(base);
  await page.evaluate(async () => {
    const { renderMarkdown } = await import('./markdown.js');
    window.renderUnderTest = renderMarkdown;
    document.querySelector('#welcome')?.setAttribute('hidden', '');
    const article = document.createElement('article');
    article.className = 'message model';
    const main = document.createElement('div');
    main.className = 'message-main';
    const content = document.createElement('div');
    content.id = 'markdown-under-test';
    content.className = 'message-content';
    main.append(content);
    article.append(main);
    document.querySelector('#messages').append(article);
  });
  return page.locator('#markdown-under-test');
}

async function render(page, source) {
  await page.evaluate(text => window.renderUnderTest(document.querySelector('#markdown-under-test'), text), source);
}

test('direct module renders headings, paragraphs, inline formatting, lists and nesting', async ({ page }) => {
  const content = await openRenderer(page);
  await render(page, '# Main heading\n\n## Subheading\n\n### Third\n\n#### Fourth\n\n##### Fifth\n\n###### Sixth\n\nA **strong** and *emphasized* paragraph with ~~old~~ and `x < y`.\n\nA second paragraph.\n\n1. First\n   - Nested bullet\n     1. Deep ordered\n   - Another bullet\n2. Second\n\n> A quote\n>\n> - Quoted list\n\n- [x] Done\n- [ ] Pending');
  for (let level = 1; level <= 6; level++) await expect(content.locator(`h${level}`)).toHaveCount(1);
  await expect(content.locator('strong')).toHaveText('strong');
  await expect(content.locator('em')).toHaveText('emphasized');
  await expect(content.locator('del')).toHaveText('old');
  await expect(content.locator('code')).toHaveText('x < y');
  await expect(content.locator(':scope > p')).toHaveCount(2);
  await expect(content.locator(':scope > ol > li')).toHaveCount(2);
  await expect(content.locator('ol > li > ul > li > ol > li')).toHaveText('Deep ordered');
  await expect(content.locator('blockquote ul li')).toHaveText('Quoted list');
  const tasks = content.locator('input[type=checkbox]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toBeChecked();
  await expect(tasks.nth(1)).not.toBeChecked();
  await expect(tasks.nth(0)).toBeDisabled();
  await expect(tasks.nth(1)).toBeDisabled();
  const styles = await content.evaluate(element => ({
    ordered: getComputedStyle(element.querySelector('ol')).listStyleType,
    unordered: getComputedStyle(element.querySelector('ul')).listStyleType,
    heading: parseFloat(getComputedStyle(element.querySelector('h1')).fontSize),
    body: parseFloat(getComputedStyle(element).fontSize),
    emphasis: getComputedStyle(element.querySelector('em')).fontStyle,
  }));
  expect(styles.ordered).toBe('decimal');
  expect(styles.unordered).toBe('disc');
  expect(styles.heading).toBeGreaterThan(styles.body);
  expect(styles.emphasis).toBe('italic');
});

test('GFM tables and fenced code preserve inert code and language labels', async ({ page }) => {
  const content = await openRenderer(page);
  const code = '<img src="https://tracking.invalid/code" onerror="window.markdownExecuted=1">\nconst html = "<script>alert(1)</script>";';
  await render(page, `| Name | Value |\n| :--- | ---: |\n| **Alpha** | 42 |\n| Beta | \\| |\n\n\`\`\`javascript\n${code}\n\`\`\``);
  await expect(content.locator('.markdown-table-scroll table')).toHaveCount(1);
  await expect(content.locator('thead th')).toHaveText(['Name', 'Value']);
  await expect(content.locator('tbody tr')).toHaveCount(2);
  await expect(content.locator('tbody strong')).toHaveText('Alpha');
  await expect(content.locator('th').nth(1)).toHaveAttribute('align', 'right');
  await expect(content.locator('pre .code-language')).toHaveText('javascript');
  expect(await content.locator('pre code').textContent()).toBe(`${code}\n`);
  await expect(content.locator('img,script')).toHaveCount(0);
  await render(page, '```html\" onclick=alert(1)\n<b>inert</b>\n```');
  await expect(content.locator('pre code')).toHaveText('<b>inert</b>');
  await expect(content.locator('[onclick], b')).toHaveCount(0);
  await expect(content.locator('.code-language')).toHaveCount(0);
});

test('only absolute credential-free HTTP(S) links are live and have new-tab isolation', async ({ page }) => {
  const content = await openRenderer(page);
  const rejected = [
    ['script', 'javascript:alert(1)'], ['mixed', 'JaVaScRiPt:alert(1)'],
    ['entity', 'jav&#x61;script:alert(1)'], ['data', 'data:text/html;base64,PHNjcmlwdD4='],
    ['mail', 'mailto:someone@example.com'], ['file', 'file:///C:/secret'],
    ['relative', '/settings'], ['protocol-relative', '//tracking.invalid/path'],
    ['credentials', 'https://user:secret@tracking.invalid/path'],
    ['encoded-user', 'https://user%40name:secret@tracking.invalid/path'],
    ['backslash', 'https://safe.invalid\\@tracking.invalid/path'],
  ];
  await render(page, '[HTTPS](https://example.com/docs?q=one&lang=en "Documentation") and [HTTP](http://example.org/help).\n\n' + rejected.map(([name, url]) => `[${name}](${url})`).join('\n\n'));
  const links = content.locator('a');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('href', 'https://example.com/docs?q=one&lang=en');
  await expect(links.nth(0)).toHaveAttribute('title', 'Documentation');
  await expect(links.nth(1)).toHaveAttribute('href', 'http://example.org/help');
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  for (const [name] of rejected) await expect(content).toContainText(name);
});

test('HTTPS Markdown CDN images load safely, fit mobile, and linked images open detached tabs', async ({ page, context }) => {
  const content = await openRenderer(page);
  const requests = [];
  const cdn = 'https://images.markdown-content.test';
  const destination = 'https://links.markdown-content.test/chart';
  await page.route(`${cdn}/**`, async route => {
    requests.push(await route.request().allHeaders());
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="180"><rect width="1200" height="180" fill="#a892df"/></svg>' });
  });
  await context.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Chart destination</title><h1>Chart destination</h1>' }));
  await render(page, `![Chart "quoted" <em>alt</em>](${cdn}/inline.svg "CDN image")\n\n![Reference image][chart]\n\n[chart]: ${cdn}/reference.svg\n\n[![Linked chart](${cdn}/linked.svg)](${destination})`);
  const images = content.locator('img');
  await expect(images).toHaveCount(3);
  await expect(images.first()).toHaveAttribute('alt', 'Chart "quoted" <em>alt</em>');
  await expect(images.first()).toHaveAttribute('title', 'CDN image');
  await expect(content.locator('em,[onerror],script')).toHaveCount(0);
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth === 1200)).toBe(true);
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(image).toHaveAttribute('loading', 'lazy');
  }
  const originalURL = page.url();
  const pending = context.waitForEvent('page');
  await content.getByRole('link').click();
  const popup = await pending;
  await expect(popup).toHaveURL(destination);
  await expect(popup.locator('h1')).toHaveText('Chart destination');
  expect(await popup.evaluate(() => window.opener === null && document.referrer === '')).toBe(true);
  await popup.close();
  expect(page.url()).toBe(originalURL);
  expect(requests).toHaveLength(3);
  expect(requests.every(headers => !headers.referer && !headers.authorization && !headers['x-goog-api-key'])).toBe(true);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const sizes = await content.evaluate(element => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, content: element.clientWidth, images: [...element.querySelectorAll('img')].map(image => image.getBoundingClientRect().width) }));
    expect(sizes.page).toBeLessThanOrEqual(sizes.viewport);
    expect(sizes.images.every(width => width <= sizes.content)).toBe(true);
  }
});

test('malicious raw HTML and unsafe Markdown image URLs stay literal and never execute or fetch', async ({ page }) => {
  const content = await openRenderer(page);
  const requested = [];
  const dialogs = [];
  const errors = [];
  page.on('request', request => requested.push(request.url()));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*markdown-probe*', route => route.fulfill({ body: '' }));
  await render(page, [
    '<script>window.markdownExecuted=1;alert("raw script")</script>',
    '<img src="https://tracking.invalid/markdown-probe-image" onerror="window.markdownExecuted=1">',
    '<img src="/markdown-probe-local" srcset="/markdown-probe-srcset 2x">',
    '<svg onload="window.markdownExecuted=1"><image href="/markdown-probe-svg" /></svg>',
    '<iframe src="/markdown-probe-frame" srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="/markdown-probe-object"></object><video poster="/markdown-probe-poster"></video>',
    '<style>@import "/markdown-probe-style";body{background:url(/markdown-probe-bg)}</style>',
    '<a href="javascript:alert(1)" onclick="window.markdownExecuted=1">raw link</a>',
    '<form action="/markdown-probe-form"><input autofocus onfocus="alert(1)"></form>',
    '![pixel](http://tracking.invalid/markdown-probe-pixel)',
    '![data](data:image/svg+xml,<svg onload=alert(1)>)',
    '![reference][pixel]\n\n[pixel]: //tracking.invalid/markdown-probe-reference',
    '[![linked pixel](https://user:password@tracking.invalid/markdown-probe-linked)](https://example.com)',
    '![relative](/markdown-probe-relative)',
    '![script](javascript:alert(1))',
  ].join('\n\n'));
  // Two frames allow load/error handlers to run if any executable nodes slipped in.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(content.locator('script,img,svg,iframe,object,video,style,form,[onerror],[onclick],[onload]')).toHaveCount(0);
  await expect(content).toContainText('<script>window.markdownExecuted=1;alert("raw script")</script>');
  await expect(content).toContainText('![pixel](http://tracking.invalid/markdown-probe-pixel)');
  expect(await page.evaluate(() => window.markdownExecuted)).toBeUndefined();
  expect(requested).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('mobile wide tables and code scroll inside message and re-render replaces prior content', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const content = await openRenderer(page);
  const wide = 'long_unbroken_column_'.repeat(12);
  await render(page, `| ${wide} | ${wide} |\n| --- | --- |\n| value | value |\n\n\`\`\`text\n${'x'.repeat(400)}\n\`\`\``);
  const sizes = await content.evaluate(element => {
    const table = element.querySelector('.markdown-table-scroll');
    const pre = element.querySelector('pre');
    return {
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      message: element.getBoundingClientRect().width,
      table: table.getBoundingClientRect().width,
      tableClient: table.clientWidth,
      tableScroll: table.scrollWidth,
      pre: pre.getBoundingClientRect().width,
      preClient: pre.clientWidth,
      preScroll: pre.scrollWidth,
    };
  });
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.table).toBeLessThanOrEqual(sizes.message);
  expect(sizes.pre).toBeLessThanOrEqual(sizes.message);
  expect(sizes.tableScroll).toBeGreaterThan(sizes.tableClient);
  expect(sizes.preScroll).toBeGreaterThan(sizes.preClient);
  await render(page, '**Replacement**');
  await expect(content.locator('strong')).toHaveText('Replacement');
  await expect(content.locator('table,pre')).toHaveCount(0);
  await render(page, '');
  await expect(content).toBeEmpty();
});
