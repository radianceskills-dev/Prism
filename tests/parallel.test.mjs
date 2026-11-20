import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parallelSearch, ParallelError, validateSearchInput } from '../parallel.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const input = { objective: 'Find official Node.js docs.', search_queries: ['Node.js official documentation'] };
const initialized = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } };
const content = text => ({ content: [{ type: 'text', text }] });
const json = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
  headers: { 'Content-Type': 'application/json', ...headers },
});
const sse = (id, result, { noClose = false, onCancel = () => {} } = {}) => {
  const bytes = new TextEncoder().encode(`: keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":${id},\r\ndata: "result":${JSON.stringify(result)}}\r\n\r\n`);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; }
      else if (!noClose) controller.close();
    },
    cancel: onCancel,
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
};
function mockMCP(final = () => json(2, content('Public excerpt')), init = () => json(1, initialized)) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, ...options, body });
    if (body.method === 'initialize') return init();
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return final(options);
  };
  return { fetchImpl, calls };
}

test('JSON MCP lifecycle is fixed, anonymous, web_search-only and forwards negotiated session', async () => {
  const mock = mockMCP(() => json(2, { content: [{ type: 'text', text: '<script>untrusted</script>' }, { type: 'image', data: 'ignored' }, { type: 'text', text: 'second' }] }),
    () => json(1, { ...initialized, protocolVersion: '2025-06-18' }, { 'Mcp-Session-Id': 'session-from-upstream' }));
  assert.deepEqual(await parallelSearch({ ...input, model_name: 'gemini-test', session_id: 'conversation-id' }, mock), { text: '<script>untrusted</script>\n\nsecond' });
  assert.deepEqual(mock.calls.map(call => call.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
  for (const call of mock.calls) {
    assert.equal(call.url, 'https://search.parallel.ai/mcp');
    assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.headers['x-goog-api-key'], undefined);
  }
  for (const call of mock.calls.slice(1)) {
    assert.equal(call.headers['Mcp-Session-Id'], 'session-from-upstream');
    assert.equal(call.headers['MCP-Protocol-Version'], '2025-06-18');
  }
  assert.equal(mock.calls[1].body.id, undefined);
  assert.deepEqual(mock.calls[2].body.params, { name: 'web_search', arguments: { ...input, model_name: 'gemini-test', session_id: 'conversation-id' } });
});

test('SSE handles split CRLF, multiline data, notifications and UTF-8; cancels after result', async () => {
  let cancelled = false;
  const mock = mockMCP(() => sse(2, content('Public café 文 excerpt'), { noClose: true, onCancel: () => { cancelled = true; } }), () => sse(1, initialized));
  assert.deepEqual(await parallelSearch(input, mock), { text: 'Public café 文 excerpt' });
  assert.equal(cancelled, true);
  assert.equal(mock.calls[2].headers['Mcp-Session-Id'], undefined);
});

test('SSE accepts LF and final unterminated event', async () => {
  const mock = mockMCP(() => new Response(`: hello\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: content('done') })}`, { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.deepEqual(await parallelSearch(input, mock), { text: 'done' });
});

test('validates fields and rejects tool/URL/credential injection without contacting upstream', async () => {
  const invalid = [null, [], 'query', {}, { ...input, objective: ' ' }, { ...input, objective: 'x'.repeat(10001) },
    { ...input, search_queries: [] }, { ...input, search_queries: [1] }, { ...input, search_queries: [' '] },
    { ...input, search_queries: Array(11).fill('x') }, { ...input, search_queries: ['x'.repeat(1001)] },
    { ...input, session_id: 's'.repeat(101) }, { ...input, model_name: 2 },
    { ...input, tool: 'web_fetch' }, { ...input, url: 'http://private.invalid/' }, { ...input, apiKey: 'private-key' }];
  for (const value of invalid) {
    let called = false;
    await assert.rejects(parallelSearch(value, { fetchImpl: () => { called = true; } }), error => error.status === 400);
    assert.equal(called, false);
  }
  assert.deepEqual(validateSearchInput({ ...input, model_name: 'm'.repeat(100), session_id: 's'.repeat(100) }), { ...input, model_name: 'm'.repeat(100), session_id: 's'.repeat(100) });
});

test('reports isError tool text and JSON-RPC errors usefully', async () => {
  await assert.rejects(parallelSearch(input, mockMCP(() => json(2, { ...content('Anonymous quota exceeded'), isError: true }))), /Parallel search failed: Anonymous quota exceeded/);
  await assert.rejects(parallelSearch(input, mockMCP(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Invalid search arguments' } }), { headers: { 'Content-Type': 'application/json' } }))), /MCP error: Invalid search arguments/);
});

test('rejects malformed/mismatched/empty responses and unsupported negotiation', async () => {
  for (const final of [
    () => new Response('bad json', { headers: { 'Content-Type': 'application/json' } }),
    () => json(999, content('wrong ID')),
    () => json(2, {}),
    () => json(2, { content: [] }),
    () => new Response('HTML error', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('data: {"jsonrpc":"2.0","id":999,"result":{}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
  ]) await assert.rejects(parallelSearch(input, mockMCP(final)), ParallelError);
  await assert.rejects(parallelSearch(input, mockMCP(undefined, () => json(1, { protocolVersion: 'future' }))), /unsupported MCP protocol/);
});

test('HTTP failures and redirects do not leak upstream bodies', async () => {
  for (const status of [401, 429, 500, 302]) {
    const mock = mockMCP(() => new Response('private provider diagnostics', { status, headers: { Location: 'https://evil.invalid' } }));
    await assert.rejects(parallelSearch(input, mock), error => error.status === (status === 429 ? 429 : 502) && error.message.includes(`HTTP ${status}`) && !error.message.includes('private'));
  }
});

test('bounds declared and streamed upstream bodies and returned text', async () => {
  const finals = [
    () => json(2, content('small'), { 'Content-Length': '1048577' }),
    () => new Response(' '.repeat(1048577), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(':'.repeat(1048577), { headers: { 'Content-Type': 'text/event-stream' } }),
    () => json(2, content('x'.repeat(262145))),
    () => json(2, content('文'.repeat(87382))), // 262146 UTF-8 bytes, fewer UTF-16 characters.
  ];
  for (const final of finals) await assert.rejects(parallelSearch(input, mockMCP(final)), /size limit/);
});

test('accepts the exact UTF-8 text limit and counts joined text separators', async () => {
  const text = 'é'.repeat(131072);
  assert.deepEqual(await parallelSearch(input, mockMCP(() => json(2, content(text)))), { text });
  await assert.rejects(parallelSearch(input, mockMCP(() => json(2, {
    content: [{ type: 'text', text }, { type: 'text', text: 'x' }],
  }))), /size limit/);
});

test('cancels a pending fetch on caller abort and does not start when already aborted', async () => {
  const controller = new AbortController();
  let fetchSignal;
  const started = deferred();
  const result = parallelSearch(input, { signal: controller.signal, fetchImpl: (_url, options) => {
    fetchSignal = options.signal;
    started.resolve();
    return new Promise(() => {});
  } });
  await started.promise;
  controller.abort(new DOMException('User stopped', 'AbortError'));
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(fetchSignal.aborted, true);
  let called = false;
  await assert.rejects(parallelSearch(input, { signal: controller.signal, fetchImpl: () => { called = true; } }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('one lifecycle deadline cancels stalled SSE reader', async () => {
  let cancelled = false;
  const mock = mockMCP(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(parallelSearch(input, { ...mock, timeoutMs: 30 }), error => error.status === 504);
  assert.equal(cancelled, true);
});

test('notification failure stops lifecycle; invalid session headers are rejected', async () => {
  const mock = mockMCP();
  const fetchImpl = (url, options) => JSON.parse(options.body).method === 'notifications/initialized'
    ? new Response(null, { status: 503 }) : mock.fetchImpl(url, options);
  await assert.rejects(parallelSearch(input, { fetchImpl }), /HTTP 503/);
  assert.equal(mock.calls.length, 1);
  await assert.rejects(parallelSearch(input, mockMCP(undefined, () => json(1, initialized, { 'Mcp-Session-Id': 'x'.repeat(513) }))), /invalid MCP session/);
});

test('caller abort cancels a pending SSE stream reader', async () => {
  const reading = deferred();
  const controller = new AbortController();
  let cancelled = false;
  const mock = mockMCP(() => new Response(new ReadableStream({
    pull() { reading.resolve(); }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const pending = parallelSearch(input, { ...mock, signal: controller.signal });
  await reading.promise;
  controller.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
