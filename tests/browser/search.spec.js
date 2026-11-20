import { test, expect } from '@playwright/test';
import { createServer } from '../../server.mjs';
let server, base;
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MCP = 'https://search.parallel.ai/mcp';
async function mockMCP(page, onSearch) {
  await page.route(MCP, async route => {
    const body = route.request().postDataJSON();
    expect(route.request().headers()['x-goog-api-key']).toBeUndefined();
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().postData()).not.toContain('private-gemini-key');
    if (body.method === 'initialize') return route.fulfill({ headers: { 'mcp-session-id': 'test-session', 'access-control-expose-headers': 'mcp-session-id' }, json: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } } });
    expect(route.request().headers()['mcp-session-id']).toBe('test-session');
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' });
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('web_search');
    return onSearch(route, body);
  });
}
const toolCall = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'parallel_search', args: { objective: 'Find Node.js documentation', search_queries: ['Node.js official docs'] } }, thoughtSignature: 'signature' }] } }] };
const answer = text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
test.beforeEach(async ({ page }) => {
  await page.goto(base);
  await page.route(`${API}/models?*`, route => route.fulfill({ json: { models: [{ name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] }] } }));
  await page.locator('#toggle-settings').click();
  await page.locator('#api-key').fill('private-gemini-key');
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#settings-tab-tools').click();
});

test('opt-in search executes tools, displays activity and citations; off prevents new searches', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole('switch')).not.toBeChecked();
  await page.getByRole('switch').check();
  await expect(page.locator('#search-mode')).toContainText('model decides');
  let searchCalls = 0;
  await mockMCP(page, async (route, body) => {
    searchCalls++;
    expect(body.params.arguments.search_queries).toEqual(['Node.js official docs']);
    await route.fulfill({ contentType: 'text/event-stream', body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Official docs https://nodejs.org/en/docs' }] } })}\n\n` });
  });
  let turns = 0;
  await page.route(`${API}/models/*:generateContent`, async route => {
    const body = route.request().postDataJSON();
    turns++;
    if (turns === 1) {
      expect(body.tools.flatMap(group => group.functionDeclarations).map(tool => tool.name)).toEqual(expect.arrayContaining(['parallel_search', 'prism_help']));
      await route.fulfill({ json: toolCall });
    } else {
      if (turns === 2) {
        expect(body.contents.at(-1).parts[0].functionResponse.response.text).toContain('nodejs.org');
        expect(body.contents.at(-2).parts[0].thoughtSignature).toBe('signature');
      } else expect(body.tools.flatMap(group => group.functionDeclarations).map(tool => tool.name)).toEqual(['prism_help']);
      await route.fulfill({ json: answer('Read [Node.js docs](https://nodejs.org/en/docs).\n[unsafe](javascript:alert(1))\n<img src=x onerror=alert(1)>') });
    }
  });
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Find current Node.js documentation');
  await page.locator('#send-button').click();
  await expect(page.locator('.thinking')).toHaveCount(0);
  await expect(page.locator('.search-activity summary')).toContainText('1 search completed');
  await expect(page.getByRole('link', { name: 'Node.js docs' })).toHaveAttribute('href', 'https://nodejs.org/en/docs');
  await expect(page.locator('.message-content a')).toHaveCount(1);
  await expect(page.locator('.message-content img')).toHaveCount(0);
  await page.locator('.search-activity summary').click();
  await expect(page.locator('.search-activity')).toContainText('Node.js official docs');
  await page.screenshot({ path: 'artifacts/prism-search.png', fullPage: true, animations: 'disabled' });
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await page.getByRole('switch').uncheck();
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Thanks');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(2);
  await expect(page.locator('.thinking')).toHaveCount(0);
  expect(searchCalls).toBe(1);
});

test('search errors are visible and returned to model for a graceful response', async ({ page }) => {
  await page.getByRole('switch').check();
  await mockMCP(page, route => route.fulfill({ status: 429, json: { error: 'Parallel rate limit reached' } }));
  let count = 0;
  await page.route(`${API}/models/*:generateContent`, async route => {
    if (++count === 1) return route.fulfill({ json: toolCall });
    expect(route.request().postDataJSON().contents.at(-1).parts[0].functionResponse.response.error).toContain('rate limit');
    await route.fulfill({ json: answer('Search is unavailable. I cannot verify this right now.') });
  });
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Search the web');
  await page.locator('#send-button').click();
  await expect(page.locator('.search-activity summary')).toContainText('failed');
  await page.locator('.search-activity summary').click();
  await expect(page.locator('.search-error')).toContainText('rate limit');
  await expect(page.locator('.message-content').last()).toContainText('cannot verify');
  await page.reload();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#search-mode')).toContainText('1/20 searches used');
});

test('stop during search counts its attempt; mobile switch and usage persist on reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('switch').check();
  await page.locator('#close-settings').click();
  let pending;
  await mockMCP(page, route => { pending = route; });
  await page.route(`${API}/models/*:generateContent`, route => route.fulfill({ json: toolCall }));
  await page.locator('#message-input').fill('Search and stop');
  await page.locator('#send-button').click();
  await expect(page.locator('.search-activity summary')).toContainText('Searching');
  await expect(page.locator('#parallel-search')).toBeDisabled();
  await page.locator('#stop-button').click();
  await expect(page.locator('#chat-notice')).toContainText('Response stopped');
  await expect(page.locator('#message-input')).toHaveValue('Search and stop');
  await expect(page.locator('.message')).toHaveCount(0);
  if (pending) await pending.abort().catch(() => {});
  await page.reload();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.getByRole('switch')).toBeChecked();
  await expect(page.locator('#search-mode')).toContainText('1/20 searches used');
});

test('twenty searches are shared across turns and reloads, isolated by conversation, and do not block chatting', async ({ page }) => {
  await page.getByRole('switch').check();
  let searchCalls = 0;
  await mockMCP(page, async (route, body) => {
    // Reserve the attempt durably before dispatch, so refresh/Stop cannot refund it.
    const persistedCount = await page.evaluate(async () => {
      const { createStore } = await import('/storage.js');
      const workspace = await createStore().load();
      return workspace.conversations.find(chat => chat.id === workspace.activeId)?.searchCount;
    });
    expect(persistedCount).toBe(searchCalls + 1);
    searchCalls++;
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `Mock result ${searchCalls}` }] } } });
  });
  const savedTurnCount = () => page.evaluate(async () => {
    const { createStore } = await import('/storage.js');
    const workspace = await createStore().load();
    return workspace.conversations.find(chat => chat.id === workspace.activeId)?.transcript?.length || 0;
  });
  const batches = [];
  await page.route(`${API}/models/*:generateContent`, async route => {
    const body = route.request().postDataJSON();
    const lastParts = body.contents.at(-1).parts;
    if (lastParts.some(part => part.functionResponse)) {
      batches.push(lastParts.filter(part => part.functionResponse).length);
      if (lastParts.length === 16) expect(lastParts.at(-1).functionResponse.response.error).toContain('Search limit reached');
      return route.fulfill({ json: answer('Research complete.') });
    }
    const prompt = lastParts.find(part => typeof part.text === 'string')?.text;
    const count = prompt === 'First research session' ? 5 : prompt === 'Use remaining budget' ? 16 : 0;
    if (count) {
      expect(body.tools[0].functionDeclarations.some(tool => tool.name === 'parallel_search')).toBe(true);
      const original = toolCall.candidates[0].content.parts[0];
      return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: Array.from({ length: count }, (_, index) => ({ ...original, functionCall: { ...original.functionCall, id: `search-${searchCalls}-${index}` } })) } }] } });
    }
    if (prompt === 'Continue without searching') {
      expect(body.tools.flatMap(group => group.functionDeclarations).map(tool => tool.name)).toEqual(['prism_help']);
      return route.fulfill({ json: answer('Budget exhausted; chat still works.') });
    }
    return route.fulfill({ json: answer('Secondary conversation.') });
  });
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('First research session');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model').last()).toContainText('Research complete.');
  expect(searchCalls).toBe(5); // The former three-search turn limit no longer applies.
  await expect.poll(savedTurnCount).toBe(2);
  await page.reload();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#search-mode')).toContainText('5/20 searches used');
  await page.locator('#close-settings').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#new-chat').click();
  await expect(page.locator('#welcome')).toBeVisible();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#search-mode')).toContainText('0/20 searches used');
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Second workspace');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model').last()).toContainText('Secondary conversation.');
  await page.locator('#saved-chats button').filter({ hasText: 'First research session' }).click();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#search-mode')).toContainText('5/20 searches used');
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Use remaining budget');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(2);
  await expect(page.locator('.message.model').last()).toContainText('Research complete.');
  expect(searchCalls).toBe(20);
  expect(batches).toEqual([5, 16]); // Fifteen run; the twenty-first conversation attempt receives a limit error.
  await expect.poll(savedTurnCount).toBe(4);
  await page.reload();
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#search-mode')).toContainText('20/20 searches used');
  await expect(page.locator('#search-mode')).toContainText('limit reached');
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Continue without searching');
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model').last()).toContainText('Budget exhausted; chat still works.');
  expect(searchCalls).toBe(20);
});
