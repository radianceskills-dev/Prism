import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server.mjs';

async function localServer(t) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('serves the fixed public allowlist with correct MIME types and HEAD responses', async t => {
  const base = await localServer(t);
  for (const [path, type] of [
    ['/', 'text/html; charset=utf-8'], ['/index.html', 'text/html; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8'],
    ['/api.js', 'text/javascript; charset=utf-8'], ['/parallel.mjs', 'text/javascript; charset=utf-8'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/notion.js', 'text/javascript; charset=utf-8'], ['/storage.js', 'text/javascript; charset=utf-8'],
    ['/mcp-client.js', 'text/javascript; charset=utf-8'], ['/composio.js', 'text/javascript; charset=utf-8'],
    ['/attachments.js', 'text/javascript; charset=utf-8'], ['/kilo.js', 'text/javascript; charset=utf-8'],
    ['/markdown.js', 'text/javascript; charset=utf-8'], ['/vendor-marked.js', 'text/javascript; charset=utf-8'],
    ['/vendor-dompurify.js', 'text/javascript; charset=utf-8'],
    ['/artefacts.js', 'text/javascript; charset=utf-8'], ['/artefact-frame.html', 'text/html; charset=utf-8'],
    ['/catbox.js', 'text/javascript; charset=utf-8'],
    ['/LICENSE-marked.txt', 'text/plain; charset=utf-8'], ['/LICENSE-dompurify.txt', 'text/plain; charset=utf-8'],
    ['/LICENSE-dompurify-MPL.txt', 'text/plain; charset=utf-8'],
    ['/LICENSE', 'text/plain; charset=utf-8'], ['/THIRD_PARTY_NOTICES.md', 'text/plain; charset=utf-8'],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
    const body = await response.arrayBuffer();
    assert.ok(body.byteLength > 0, path);
    assert.equal(Number(response.headers.get('content-length')), body.byteLength, path);
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200, path);
    assert.equal(head.headers.get('content-type'), type, path);
    assert.equal(Number(head.headers.get('content-length')), body.byteLength, path);
    assert.equal(await head.text(), '', path);
  }
  assert.equal((await fetch(`${base}/parallel.mjs?version=1`)).status, 200);
});

test('never serves backend, configuration, dependencies, private files or SPA fallbacks', async t => {
  const base = await localServer(t);
  for (const path of [
    '/package.json', '/package-lock.json', '/server.mjs', '/build.mjs', '/_headers', '/.gitignore',
    '/.env', '/.env.local', '/tests/api.test.mjs', '/tests/parallel.test.mjs',
    '/node_modules/@playwright/test/package.json', '/dist/index.html', '/missing', '/chat/session',
    '/%2eenv', '/%2e%2e/.env', '/..%2f.env', '/..%5c.env', '/index.html/extra',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'Not found', path);
  }
});

test('has no search HTTP route and accepts only static GET/HEAD methods', async t => {
  const base = await localServer(t);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await fetch(`${base}/api/parallel/search`, { method })).status, 404);
  }
  for (const path of ['/', '/parallel.mjs', '/api/parallel/search']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  }
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import\s+.*from\s+['"]\.\/parallel\.mjs['"]/);
  assert.doesNotMatch(source, /parallelSearch|validateSearchInput|api\/parallel\/search/);
});

test('preview and static hosting headers match, including direct HTTPS and loopback connections', async t => {
  const base = await localServer(t);
  const headersFile = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  const rules = new Map();
  let current;
  for (const line of headersFile.trimEnd().split(/\r?\n/)) {
    if (!/^\s/.test(line)) { current = new Map(); rules.set(line, current); }
    else {
      const separator = line.indexOf(':');
      current.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }
  assert.equal(rules.get('/*').has('content-security-policy'), false, 'Never merge the app CSP into the executable host');
  for (const path of ['/', '/index.html', '/parallel.mjs', '/missing']) {
    const hostedHeaders = new Map([...rules.get('/*'), ...(rules.get(path) || [])]);
    const response = await fetch(base + path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const csp = response.headers.get('content-security-policy');
    for (const directive of [
      "default-src 'self'", "script-src 'self' https://cdn.jsdelivr.net", "frame-ancestors 'none'", "object-src 'none'",
      "base-uri 'none'", "form-action 'none'", "img-src 'self' https: data:",
      "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    ]) assert.ok(csp.split('; ').includes(directive), directive);
    for (const [name, value] of hostedHeaders) assert.equal(response.headers.get(name), value, name);
    await response.text();
  }
  const host = await fetch(base + '/artefact-frame.html');
  for (const [name, value] of [...rules.get('/*'), ...rules.get('/artefact-frame.html')]) assert.equal(host.headers.get(name), value, name);
  const csp = host.headers.get('content-security-policy');
  assert.match(csp, /frame-src about:/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  assert.ok(csp.split('; ').includes('img-src https: data: blob:'), 'HTTPS images are explicitly allowed');
  for (const directive of ["script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "font-src data:", "media-src data: blob:", "worker-src 'none'", "object-src 'none'"]) {
    assert.ok(csp.split('; ').includes(directive), `Only images gain remote resource access: ${directive}`);
  }
  const html = await host.text();
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`), 'host header and meta policy agree');
  assert.match(html, /function heightBridge\(key\) \{\s*'use strict';/, 'Serialized bootstrap must retain its own strict mode');
  const childPolicy = /const policy = "([^"]+)"/.exec(html)?.[1];
  assert.ok(childPolicy?.split('; ').includes('img-src https: data: blob:'), 'inner policy also permits HTTPS images');
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "form-action 'none'", "script-src 'unsafe-inline'"]) {
    assert.ok(childPolicy.split('; ').includes(directive), `Inner restrictions retained: ${directive}`);
  }
});
