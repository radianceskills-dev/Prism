import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createWorker } from '../../composio-worker/src/index.js';

// Exercise real browser CORS and the actual shared Worker handler. Only Kilo's
// upstream is synthetic; no inference prompts or credentials leave this process.
const BASE = 'http://127.0.0.1:3000';
const UPSTREAM = 'https://ai-gateway.kilo.ai/api/v1';
const FREE = 'synthetic/end-to-end:free';
const KEY = 'synthetic-primary-key-never-relay';
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const payload = body => JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));

test('real browser CORS traverses the shared Worker with anonymous discovery, attachments and tool continuation', async ({ page }) => {
  const upstreamCalls = [], incoming = [], errors = [], unexpected = [];
  let omitCors = true;
  const handler = createWorker(async (url, init = {}) => {
    upstreamCalls.push({ url: String(url), init });
    expect(String(url).startsWith(`${UPSTREAM}/`)).toBe(true);
    const headers = new Headers(init.headers);
    for (const name of ['authorization', 'cookie', 'x-goog-api-key', 'x-consumer-api-key', 'mcp-session-id']) expect(headers.has(name)).toBe(false);
    expect(JSON.stringify(init)).not.toContain(KEY);
    if (String(url) === `${UPSTREAM}/models`) return json({ data: [
      { id: FREE, name: 'End-to-end Free', pricing: { prompt: '0', completion: '0' } },
      { id: 'synthetic/end-to-end-stealth', name: 'End-to-end Stealth' },
      { id: 'synthetic/paid', pricing: { prompt: '0.1', completion: '0.1' } },
    ] });
    expect(String(url)).toBe(`${UPSTREAM}/chat/completions`);
    const body = payload(init.body);
    expect(body.model).toBe(FREE);
    const continuation = body.messages.some(message => message.role === 'tool');
    return json({ choices: [{ message: continuation ? { role: 'assistant', content: 'Shared Worker end-to-end answer' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'local-help', type: 'function', function: { name: 'prism_help', arguments: '{}' } }] }, finish_reason: continuation ? 'stop' : 'tool_calls' }] });
  });
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      incoming.push({ method: req.method, path: req.url, headers: { ...req.headers } });
      const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
        method: req.method, headers: req.headers, signal: controller.signal,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }),
      });
      const response = await handler.fetch(request, {});
      if (omitCors) response.headers.delete('access-control-allow-origin');
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
    } catch (error) { errors.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${server.address().port}`;
  try {
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'ambient-relay-cookie', value: 'never-forward', domain: '127.0.0.1', path: '/kilo', sameSite: 'Lax' }]);
    // No Playwright routing at all: Chromium interception can suppress CORS
    // preflights globally. Native URL blocking keeps external traffic offline
    // without changing normal loopback CORS behavior.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*', 'https://generativelanguage.googleapis.com/*', 'https://ai-gateway.kilo.ai/*'] });
    page.on('request', request => {
      const url = request.url();
      if (![`${BASE}/`, `${relay}/`, 'https://cdn.jsdelivr.net/', 'https://generativelanguage.googleapis.com/'].some(prefix => url.startsWith(prefix))) unexpected.push(url);
    });
    await page.goto(BASE);
    const blocked = await page.evaluate(async url => {
      try { await fetch(url, { credentials: 'omit' }); return false; } catch { return true; }
    }, `${relay}/kilo/v1/models`);
    expect(blocked).toBe(true); // Negative control proves genuine browser CORS.
    omitCors = false;
    incoming.length = 0; upstreamCalls.length = 0;
    await page.locator('#toggle-settings').click();
    await page.locator('#settings-tab-connection').click();
    await page.locator('#api-protocol-openai').check();
    await page.locator('#endpoint').fill(`${BASE}/v1`); // Preview rejects /v1/models; Kilo remains usable.
    await page.locator('#api-key').fill(KEY);
    await page.locator('#kilo-worker-url').fill(relay);
    await page.locator('#kilo-enabled').check();
    expect(incoming).toHaveLength(0);
    await page.locator('#fetch-models').click();
    await expect(page.locator('#model-count')).toHaveText('2 models available');
    await page.locator('#model-select').selectOption(`kilo:${FREE}`);
    await page.locator('#close-settings').click();
    await page.locator('#attachment-input').setInputFiles({ name: 'local-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic local attachment through the shared Worker.') });
    await page.locator('#message-input').fill('Use local help and answer.');
    await page.locator('#send-button').click();
    await expect(page.locator('.message.model')).toContainText('Shared Worker end-to-end answer');
    await expect(page.locator('#stop-button')).toBeHidden();
    const chats = upstreamCalls.filter(call => call.url.endsWith('/chat/completions'));
    expect(chats).toHaveLength(2);
    const first = payload(chats[0].init.body);
    expect(JSON.stringify(first.messages)).toContain('Synthetic local attachment through the shared Worker.');
    expect(first.tools.some(tool => tool.function.name === 'prism_help')).toBe(true);
    expect(incoming.some(call => call.method === 'OPTIONS' && call.path === '/kilo/v1/chat/completions')).toBe(true);
    expect(incoming.every(call => call.path.startsWith('/kilo/v1/'))).toBe(true);
    for (const call of incoming) for (const name of ['authorization', 'cookie', 'x-goog-api-key', 'x-consumer-api-key']) expect(call.headers[name]).toBeUndefined();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
