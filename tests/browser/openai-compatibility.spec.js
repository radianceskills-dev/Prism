import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';

const API = 'https://compatible-proxy.test/v1';
const MODEL = 'proxy/chat-model';
const KEY = 'private-compatible-provider-key';
const MCP = 'https://search.parallel.ai/mcp';
const SECRET = 'SENSITIVE_UPSTREAM_PAYLOAD_NOT_FOR_DISPLAY';
const CALL_ID = 'proxy_search_1';
let server, base;

const answer = text => ({ choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }] });
const userMessages = body => body.messages.filter(message => message.role !== 'system');

async function activeChat(page) {
  return page.evaluate(async () => {
    const workspace = await (await import('/storage.js')).createStore().load();
    return workspace?.conversations.find(chat => chat.id === workspace.activeId) ?? null;
  });
}
async function settled(page) {
  await expect(page.locator('#stop-button')).toBeHidden();
  await expect(page.locator('#send-button')).toBeVisible();
  await expect(page.locator('#message-input')).toBeEnabled();
  await expect(page.locator('#api-protocol-openai')).toBeEnabled();
}
async function send(page, text, reply, count) {
  await page.locator('#message-input').fill(text);
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(count);
  await expect(page.locator('.message.model').last()).toContainText(reply);
  await settled(page);
  await expect(page.locator('#chat-notice')).toBeHidden();
}
async function setup(page, { search = false } = {}) {
  const requests = [], mcp = [], unexpected = [], diagnostics = [];
  // Optional presentation CDNs and third-party tools must not make this a live-network test.
  await page.route('https://**/*', route => { unexpected.push(route.request().url()); return route.abort(); });
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  page.on('console', message => diagnostics.push(message.text()));
  page.on('pageerror', error => diagnostics.push(error.message));
  await page.route(`${API}/models`, route => route.fulfill({ json: { data: [{ id: MODEL }] } }));
  await page.route(MCP, async route => {
    const request = route.request(), body = request.postDataJSON();
    mcp.push(body);
    expect(request.headers().authorization).toBeUndefined();
    expect(request.headers()['x-goog-api-key']).toBeUndefined();
    expect(request.postData()).not.toContain(KEY);
    if (body.method === 'initialize') return route.fulfill({ headers: { 'mcp-session-id': 'compatibility-session', 'access-control-expose-headers': 'mcp-session-id' }, json: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } } });
    expect(request.headers()['mcp-session-id']).toBe('compatibility-session');
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('web_search');
    expect(body.params.arguments.search_queries).toEqual(['Node.js documentation']);
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Official documentation: https://nodejs.org/en/docs' }] } } });
  });
  await page.goto(base);
  await expect(page.locator('#api-protocol-openai')).toBeEnabled();
  await page.locator('#toggle-settings').click();
  await page.locator('#api-protocol-openai').check();
  await page.locator('#endpoint').fill(API);
  await page.locator('#api-key').fill(KEY);
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#settings-tab-tools').click();
  await page.locator('#parallel-search').setChecked(search);
  await page.locator('#close-settings').click();
  return { requests, mcp, unexpected, diagnostics };
}
async function completions(page, state, respond) {
  await page.route(`${API}/chat/completions`, async route => {
    const request = route.request(), body = request.postDataJSON();
    expect(request.headers().authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers()['x-goog-api-key']).toBeUndefined();
    expect(request.url()).not.toContain(KEY);
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(false);
    state.requests.push(body);
    await route.fulfill({ json: respond(body, state.requests.length) });
  });
}

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

for (const search of [false, true]) {
  test(`proxy text with tool_calls:null completes and preserves a valid second turn with search ${search ? 'enabled' : 'disabled'}`, async ({ page }) => {
    const state = await setup(page, { search });
    await completions(page, state, (body, index) => {
      if (search) expect(body.tools.some(tool => tool.function.name === 'parallel_search')).toBe(true);
      else expect(body.tools.map(tool => tool.function.name)).toEqual(['prism_help']);
      return answer(index === 1 ? 'Normal proxy answer' : 'Second proxy answer');
    });
    await send(page, 'First proxy question', 'Normal proxy answer', 1);
    await send(page, 'Second proxy question', 'Second proxy answer', 2);
    expect(state.requests).toHaveLength(2);
    expect(userMessages(state.requests[1])).toEqual([
      { role: 'user', content: 'First proxy question' },
      { role: 'assistant', content: 'Normal proxy answer' },
      { role: 'user', content: 'Second proxy question' },
    ]);
    await expect.poll(async () => (await activeChat(page))?.history.length).toBe(4);
    const saved = await activeChat(page);
    expect(saved.history.map(turn => turn.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(saved.history.flatMap(turn => turn.parts).some(part => part.functionCall || part.functionResponse)).toBe(false);
    expect(saved.audit).toEqual([]);
    expect(saved.searchCount).toBe(0);
    expect(saved.draft).toBe('');
    await expect(page.locator('.search-activity')).toHaveCount(0);
    expect(state.mcp).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(state.diagnostics).toEqual([]);
  });
}

test('a real Parallel tool round accepts a null-call final answer and preserves paired IDs, usage and drafts across reload', async ({ page }) => {
  const state = await setup(page, { search: true });
  const args = { objective: 'Find Node.js official documentation', search_queries: ['Node.js documentation'] };
  await completions(page, state, (body, index) => index === 1
    ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: CALL_ID, type: 'function', function: { name: 'parallel_search', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }
    : answer(index === 2 ? 'Normal proxy answer after one search' : 'Follow-up without another search'));
  await send(page, 'Search the Node.js documentation', 'Normal proxy answer after one search', 1);
  expect(state.requests).toHaveLength(2);
  const continuation = userMessages(state.requests[1]);
  expect(continuation.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
  expect(continuation[1].tool_calls).toEqual([{ id: CALL_ID, type: 'function', function: { name: 'parallel_search', arguments: JSON.stringify(args) } }]);
  expect(continuation[2].tool_call_id).toBe(CALL_ID);
  expect(JSON.parse(continuation[2].content).text).toContain('https://nodejs.org/en/docs');
  await expect(page.locator('.search-activity')).toHaveCount(1);
  await expect.poll(async () => (await activeChat(page))?.transcript.length).toBe(2);
  const first = await activeChat(page);
  expect(first.searchCount).toBe(1);
  expect(first.transcript[1].searches).toHaveLength(1);
  const parts = first.history.flatMap(turn => turn.parts);
  expect(parts.filter(part => part.functionCall).map(part => part.functionCall.id)).toEqual([CALL_ID]);
  expect(parts.filter(part => part.functionResponse).map(part => part.functionResponse.id)).toEqual([CALL_ID]);
  await page.locator('#message-input').fill('An unsent follow-up draft');
  await expect.poll(async () => (await activeChat(page))?.draft).toBe('An unsent follow-up draft');
  await page.reload();
  await expect(page.locator('#message-input')).toHaveValue('An unsent follow-up draft');
  await expect(page.locator('#send-button')).toBeEnabled();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#search-mode')).toContainText('1/20 searches used');
  await page.locator('#close-settings').click();
  await send(page, 'Continue from that answer', 'Follow-up without another search', 2);
  expect(state.requests).toHaveLength(3);
  const next = userMessages(state.requests[2]);
  expect(next.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
  expect(next[2].tool_call_id).toBe(CALL_ID);
  expect(next[3]).toEqual({ role: 'assistant', content: 'Normal proxy answer after one search' });
  expect(state.mcp.filter(body => body.method === 'tools/call')).toHaveLength(1);
  await expect.poll(async () => (await activeChat(page))?.transcript.length).toBe(4);
  const final = await activeChat(page);
  expect(final.searchCount).toBe(1);
  expect(final.draft).toBe('');
  expect(state.unexpected).toEqual([]);
  expect(state.diagnostics).toEqual([]);
});

const invalidReplies = [
  { name: 'null tool calls with a tool_calls finish reason', message: { tool_calls: null }, finish: 'tool_calls', reason: /finish_reason.*tool_calls.*no tool calls/i },
  { name: 'empty tool calls with a tool_calls finish reason', message: { tool_calls: [] }, finish: 'tool_calls', reason: /finish_reason.*tool_calls.*no tool calls/i },
  { name: 'omitted tool calls with a tool_calls finish reason', message: {}, finish: 'tool_calls', reason: /finish_reason.*tool_calls.*no tool calls/i },
  { name: 'unsupported legacy function_call data', message: { function_call: { name: 'parallel_search', arguments: '{"search_queries":["DO NOT EXECUTE"]}' } }, finish: 'stop', reason: /legacy|function_call|unsupported/i },
  { name: 'unsupported legacy function_call finish reason', message: { tool_calls: null }, finish: 'function_call', reason: /legacy|function_call|unsupported/i },
];
for (const invalid of invalidReplies) {
  test(`${invalid.name} fails safely with rollback and no tools or automatic retry`, async ({ page }) => {
    const state = await setup(page, { search: true });
    await completions(page, state, (body, index) => index === 1 ? answer('A prior successful answer') : {
      choices: [{ message: { role: 'assistant', content: `${SECRET}: ${KEY}`, ...invalid.message }, finish_reason: invalid.finish }],
      private_payload: SECRET,
    });
    await send(page, 'A prior successful question', 'A prior successful answer', 1);
    const draft = `Keep this failed ${invalid.finish} question`;
    await page.locator('#message-input').fill(draft);
    await page.locator('#send-button').click();
    await expect(page.locator('#chat-notice')).toBeVisible();
    await expect(page.locator('#chat-notice')).toContainText(invalid.reason);
    await expect(page.locator('#chat-notice')).toContainText(/no tools(?: from this batch)? were executed/i);
    await settled(page);
    await expect(page.locator('#message-input')).toHaveValue(draft);
    await expect(page.locator('#send-button')).toBeEnabled();
    await expect(page.locator('.message.model')).toHaveCount(1);
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText(SECRET);
    await expect(page.locator('body')).not.toContainText(KEY);
    await expect.poll(async () => (await activeChat(page))?.draft).toBe(draft);
    const saved = await activeChat(page);
    expect(saved.history.map(turn => turn.role)).toEqual(['user', 'model']);
    expect(saved.history[1].parts).toEqual([{ text: 'A prior successful answer' }]);
    expect(saved.transcript).toHaveLength(2);
    expect(saved.audit).toEqual([]);
    expect(saved.searchCount).toBe(0);
    await page.reload();
    await expect(page.locator('#message-input')).toHaveValue(draft);
    await expect(page.locator('.message.model')).toHaveCount(1);
    await expect(page.locator('#send-button')).toBeEnabled();
    expect(state.requests).toHaveLength(2);
    expect(state.mcp).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(state.diagnostics.join('\n')).not.toContain(SECRET);
    expect(state.diagnostics.join('\n')).not.toContain(KEY);
    await expect(page.locator('.search-activity')).toHaveCount(0);
  });
}
