import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from '../../server.mjs';
import { getArtefactInstruction } from '../../api.js';

let server, base;
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = { name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] };
const CUSTOM = 'Use short explanations and accessible controls.';
const HTML = '<!doctype html><html><head><style>body{margin:0;padding:16px;min-height:160px;box-sizing:border-box;font:16px sans-serif}button{padding:10px}</style></head><body><button id="increment">Increment</button><output id="count">0</output><script>let n=0;document.querySelector("#increment").onclick=()=>document.querySelector("#count").textContent=String(++n);document.querySelector("#increment").dataset.ready="true";</script></body></html>';
const COUNTER = `<artefact title="Toggle counter">${HTML}</artefact>`;
const MODES = ['off', 'on', 'enforced'];
const childOf = card => card.frameLocator('.artefact-frame').frameLocator('iframe');
const modeButton = (page, mode) => page.locator(`#artefact-mode-switch button[data-mode="${mode}"]`);
const section = page => page.locator('#sidebar').getByRole('region', { name: 'Interactive UI', exact: true });
const reply = text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });

test.beforeAll(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
});

async function openInstructions(page) {
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-instructions').click();
  await expect(page.locator('#system-prompt')).toBeEnabled();
}
async function savedWorkspace(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('prism-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('workspace', 'readonly').objectStore('workspace').get('current');
      read.onerror = () => { database.close(); reject(read.error); };
      read.onsuccess = () => { database.close(); resolve(read.result); };
    };
  }));
}
async function expectPersistedMode(page, mode) {
  await expect.poll(async () => (await savedWorkspace(page))?.settings?.artefactMode).toBe(mode);
  expect((await savedWorkspace(page)).settings).not.toHaveProperty('artefacts');
}
async function expectMode(page, mode) {
  await expect(page.locator('#artefact-mode-switch')).toHaveAttribute('data-state', mode);
  for (const candidate of MODES) {
    await expect(modeButton(page, candidate)).toHaveAttribute('aria-checked', String(candidate === mode));
    await expect(modeButton(page, candidate)).toHaveAttribute('tabindex', candidate === mode ? '0' : '-1');
  }
}
async function chooseMode(page, mode) {
  await modeButton(page, mode).click();
  await expectMode(page, mode);
  await expectPersistedMode(page, mode);
}
async function seedWorkspace(page, settings, conversations = [], activeId) {
  await page.goto(base);
  await expect(modeButton(page, 'on')).toBeEnabled();
  await page.evaluate(async saved => {
    const { createStore } = await import('./storage.js');
    await createStore().save(saved);
  }, { version: 1, settings, conversations, activeId });
  await page.reload();
}
async function connect(page) {
  await page.route(`${API}/models?*`, route => route.fulfill({ json: { models: [MODEL] } }));
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  await page.locator('#api-key').fill('mock-artefact-instructions-key');
  await page.locator('#fetch-models').click();
  await expect(page.locator('#model-count')).toHaveText('1 model available');
  await page.locator('#settings-tab-instructions').click();
  await page.locator('#system-prompt').fill(CUSTOM);
  await page.locator('#close-settings').click();
}
async function send(page, text, count) {
  await page.locator('#message-input').fill(text);
  await page.locator('#send-button').click();
  await expect(page.locator('.message.model')).toHaveCount(count);
  await expect(page.locator('.thinking')).toHaveCount(0);
  await expect(page.locator('#message-input')).toBeEnabled();
}
async function expectRendering(page, mode, count = 1) {
  const models = page.locator('.message.model');
  if (mode === 'off') {
    await expect(models.locator('iframe,.artefact-card')).toHaveCount(0);
    await expect(models.locator('pre code.language-html')).toHaveCount(count);
    for (const code of await models.locator('pre code.language-html').all()) expect(await code.textContent()).toBe(HTML);
    await expect(models.locator('#increment,script')).toHaveCount(0);
  } else {
    await expect(models.locator('.artefact-card')).toHaveCount(count);
    await expect(models.locator('pre code.language-html')).toHaveCount(0);
    const card = models.locator('.artefact-card').last();
    // The child can be ready before its asynchronous resize reaches the outer
    // host (initially 1px tall). Wait for the actual clickable preview geometry.
    await expect.poll(() => card.locator('.artefact-frame').evaluate(frame => frame.getBoundingClientRect().height)).toBeGreaterThanOrEqual(160);
    const child = childOf(card);
    await expect(child.locator('#increment[data-ready="true"]')).toBeVisible();
    const before = Number(await child.locator('#count').textContent());
    await child.locator('#increment').click();
    await expect(child.locator('#count')).toHaveText(String(before + 1));
  }
}

// The old Settings switch is intentionally absent: this is a sidebar preference,
// independent of the custom system prompt that remains in Settings Instructions.
test('sidebar defaults to On with a labelled three-radio group, live help and exact per-mode guidance', async ({ page }) => {
  await page.goto(base);
  const card = section(page);
  const group = card.getByRole('radiogroup');
  await expect(card).toBeVisible();
  await expect(group).toHaveAttribute('id', 'artefact-mode-switch');
  expect(await group.evaluate(element => element.tagName)).toBe('FIELDSET');
  await expect(group).toHaveAttribute('aria-labelledby', 'artefact-mode-label');
  await expect(group).toHaveAttribute('aria-describedby', 'artefact-mode-help');
  await expect(group).toHaveAccessibleName('Interactive UI');
  await expect(group.getByRole('radio')).toHaveCount(3);
  await expectMode(page, 'on');
  await expect(card.locator('#artefact-mode-help')).toHaveAttribute('aria-live', 'polite');
  await card.getByText('View model guidance', { exact: true }).click();
  const descriptions = [];
  for (const mode of ['off', 'on', 'enforced']) {
    await chooseMode(page, mode);
    await expect(card.locator('#artefact-instruction-text')).toBeVisible();
    expect(await card.locator('#artefact-instruction-text').textContent()).toBe(getArtefactInstruction(mode));
    await expect(card.locator('#artefact-mode-help')).not.toBeEmpty();
    descriptions.push(await card.locator('#artefact-mode-help').textContent());
    await expect(modeButton(page, mode)).toHaveAttribute('type', 'button');
  }
  expect(new Set(descriptions).size).toBe(3);
  await openInstructions(page);
  await expect(page.locator('#artefact-instructions')).toHaveCount(0);
  await expect(page.locator('#settings-dialog #artefact-mode-switch,#settings-dialog #artefact-instruction-text')).toHaveCount(0);
  await page.locator('#system-prompt').fill(CUSTOM);
  await page.locator('#close-settings').click();
  await expectMode(page, 'enforced');
  await openInstructions(page);
  await expect(page.locator('#system-prompt')).toHaveValue(CUSTOM);
});

test('radio keyboard arrows wrap, Home/End select endpoints and keep one roving tab stop', async ({ page }) => {
  await page.goto(base);
  await modeButton(page, 'on').focus();
  for (const [key, mode] of [['ArrowRight', 'enforced'], ['ArrowRight', 'off'], ['ArrowLeft', 'enforced'], ['Home', 'off'], ['End', 'enforced'], ['ArrowDown', 'off'], ['ArrowUp', 'enforced']]) {
    await page.keyboard.press(key);
    await expectMode(page, mode);
    await expect(modeButton(page, mode)).toBeFocused();
    await expectPersistedMode(page, mode);
  }
});

test('all modes send explicit guidance without changing custom instructions; switching immediately rerenders existing replies and preserves history', async ({ page }) => {
  const requests = [];
  await page.route(`${API}/models/*:generateContent`, route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: reply(COUNTER) });
  });
  await connect(page);
  const prompt = `Make a counter like this user example: ${COUNTER}`;
  for (const [index, mode] of ['on', 'off', 'enforced'].entries()) {
    if (index) {
      await page.locator('#message-input').fill('Keep this unsent draft.');
      const before = await savedWorkspace(page);
      await chooseMode(page, mode);
      await expect(page.locator('#message-input')).toHaveValue('Keep this unsent draft.');
      const after = await savedWorkspace(page);
      expect(after.activeId).toBe(before.activeId);
      expect(after.conversations[0].history).toEqual(before.conversations[0].history);
      expect(after.conversations[0].transcript).toEqual(before.conversations[0].transcript);
      expect(after.conversations[0].audit).toEqual(before.conversations[0].audit);
      await expectRendering(page, mode, index);
    }
    await send(page, prompt, index + 1);
    const instruction = requests[index].systemInstruction.parts[0].text;
    expect(instruction.startsWith(`${CUSTOM}\n\n${getArtefactInstruction(mode)}\n\n`)).toBe(true);
    expect(instruction).toContain('prism_help is an available read-only local hint tool.');
    if (mode === 'enforced') expect(instruction).toContain('Use interactive UI by default at the end of each answer.');
    expect(requests[index].contents.map(turn => turn.role)).toEqual(Array.from({ length: index * 2 + 1 }, (_, turn) => turn % 2 ? 'model' : 'user'));
    if (index) expect(requests[index].contents[1].parts[0].text).toBe(COUNTER);
    await expect(page.locator('.message.user .artefact-card,.message.user iframe')).toHaveCount(0);
    for (const content of await page.locator('.message.user .message-content').all()) await expect(content).toHaveText(prompt);
    await expectRendering(page, mode, index + 1);
    await openInstructions(page);
    await expect(page.locator('#system-prompt')).toHaveValue(CUSTOM);
    await page.locator('#close-settings').click();
  }
  expect(new Set(requests.map(body => body.systemInstruction.parts[0].text)).size).toBe(3);
  await expectPersistedMode(page, 'enforced');
});

for (const mode of MODES) {
  test(`saved ${mode} mode restores exact rendering and preserves source, copy/export, draft and tool activity through toggles`, async ({ page }) => {
    const user = `Literal user wrapper: ${COUNTER}`;
    const chat = {
      id: 'saved-counter', title: 'Keep my custom conversation title', endpoint: API, sessionId: 'saved-search', searchCount: 1,
      draft: 'Unsent saved draft',
      history: [{ role: 'user', parts: [{ text: user }] }, { role: 'model', parts: [{ text: COUNTER }] }],
      transcript: [
        { role: 'You', text: user },
        { role: 'Gemini Flash', text: COUNTER, searches: [{ status: 'complete', queries: ['counter accessibility'], objective: 'Find guidance' }] },
      ],
      audit: [{ name: 'notion-read-page', status: 'success' }],
    };
    let modelCalls = 0;
    await page.route(`${API}/models/*:generateContent`, route => { modelCalls++; return route.fulfill({ json: reply('Unexpected regeneration') }); });
    await seedWorkspace(page, { artefactMode: mode, system: CUSTOM, search: false }, [chat], chat.id);
    await expectMode(page, mode);
    await expectRendering(page, mode);
    const audit = await page.locator('#tool-audit').textContent();
    const search = await page.locator('.message.model .search-activity').textContent();
    const title = await page.locator('#chat-title').textContent();
    await page.evaluate(() => {
      window.copiedMessages = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedMessages.push(text); } } });
    });
    for (const target of [...MODES.filter(candidate => candidate !== mode), mode]) {
      const previous = await page.locator('#artefact-mode-switch').getAttribute('data-state');
      const card = page.locator('.message.model .artefact-card');
      const preservesPreview = previous !== 'off' && target !== 'off';
      const frameURL = preservesPreview ? await card.locator('.artefact-frame').getAttribute('src') : null;
      const counter = preservesPreview ? await childOf(card).locator('#count').textContent() : null;
      await chooseMode(page, target);
      if (preservesPreview) {
        await expect(card.locator('.artefact-frame')).toHaveAttribute('src', frameURL);
        await expect(childOf(card).locator('#count')).toHaveText(counter);
      }
      await expectRendering(page, target);
      await expect(page.locator('#message-input')).toHaveValue(chat.draft);
      await expect(page.locator('#chat-title')).toHaveText(title);
      expect(await page.locator('#tool-audit').textContent()).toBe(audit);
      expect(await page.locator('.message.model .search-activity').textContent()).toBe(search);
      await expect(page.locator('.message.user .message-content')).toHaveText(user);
      await expect(page.locator('.message.user iframe,.message.user .artefact-card')).toHaveCount(0);
      await page.locator('.message.model .message-copy').click();
      expect(await page.evaluate(() => window.copiedMessages.at(-1))).toBe(COUNTER);
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-chat').click()]);
      const exported = await readFile(await download.path(), 'utf8');
      expect(exported).toContain(COUNTER);
      expect(exported).toContain(user);
      const saved = await savedWorkspace(page);
      expect(saved.activeId).toBe(chat.id);
      expect(saved.conversations).toHaveLength(1);
      expect(saved.conversations[0]).toEqual(chat);
    }
    await page.reload();
    await expectMode(page, mode);
    await expectRendering(page, mode);
    await expect(page.locator('#message-input')).toHaveValue(chat.draft);
    expect(modelCalls).toBe(0);
  });
}

const migrations = [
  ['missing legacy preference', {}, 'on'],
  ['legacy false', { artefacts: false }, 'off'],
  ['legacy true', { artefacts: true }, 'on'],
  ['new off overrides legacy true', { artefactMode: 'off', artefacts: true }, 'off'],
  ['new on overrides legacy false', { artefactMode: 'on', artefacts: false }, 'on'],
  ['new enforced overrides legacy false', { artefactMode: 'enforced', artefacts: false }, 'enforced'],
  ['invalid new mode falls back to legacy false', { artefactMode: 'invalid', artefacts: false }, 'off'],
  ['invalid new mode without legacy defaults On', { artefactMode: 'invalid' }, 'on'],
];
for (const [name, preference, expected] of migrations) {
  test(`workspace migration: ${name}`, async ({ page }) => {
    const chat = {
      id: 'migration-chat', title: 'Keep this custom legacy title', draft: 'Keep this legacy draft',
      history: [{ role: 'user', parts: [{ text: 'Original question' }] }, { role: 'model', parts: [{ text: 'Saved answer' }] }],
      transcript: [{ role: 'You', text: 'Original question' }, { role: 'Gemini Flash', text: 'Saved answer' }],
      audit: [{ name: 'notion-read-page', status: 'success' }],
    };
    await seedWorkspace(page, { system: CUSTOM, search: false, ...preference }, [chat], chat.id);
    await expectMode(page, expected);
    await expectPersistedMode(page, expected);
    const migrated = await savedWorkspace(page);
    expect(migrated.activeId).toBe(chat.id);
    expect(migrated.conversations).toEqual([chat]);
    await expect(page.locator('#chat-title')).toHaveText(chat.title);
    await expect(page.locator('#message-input')).toHaveValue(chat.draft);
    await expect(page.locator('#saved-chats .conversation-item')).toHaveText(chat.title);
    await openInstructions(page);
    await expect(page.locator('#system-prompt')).toHaveValue(CUSTOM);
    // Force an ordinary save, including when migration kept the default mode.
    await page.locator('#system-prompt').fill(`${CUSTOM} Saved after migration.`);
    await expectPersistedMode(page, expected);
    await page.reload();
    await expectMode(page, expected);
    await openInstructions(page);
    await expect(page.locator('#system-prompt')).toHaveValue(`${CUSTOM} Saved after migration.`);
  });
}

test('all mode buttons are disabled during a model turn and reenable without changing mode or guidance', async ({ page }) => {
  let release, dispatched;
  const responseGate = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { dispatched = resolve; });
  await page.route(`${API}/models/*:generateContent`, async route => {
    dispatched();
    await responseGate;
    await route.fulfill({ json: reply('Finished.') });
  });
  await connect(page);
  await chooseMode(page, 'enforced');
  await page.locator('#message-input').fill('Wait while I inspect the sidebar.');
  await page.locator('#send-button').click();
  await requestStarted;
  try {
    for (const mode of MODES) await expect(modeButton(page, mode)).toBeDisabled();
    await expectMode(page, 'enforced');
    await modeButton(page, 'enforced').press('Home');
    await expectMode(page, 'enforced');
    await expectPersistedMode(page, 'enforced');
  } finally { release(); }
  await expect(page.locator('.message.model')).toContainText('Finished.');
  for (const mode of MODES) await expect(modeButton(page, mode)).toBeEnabled();
  await chooseMode(page, 'off');
});

test('mode buttons are disabled before workspace initialization completes', async ({ page }) => {
  let release, dispatched;
  const moduleGate = new Promise(resolve => { release = resolve; });
  const moduleRequested = new Promise(resolve => { dispatched = resolve; });
  await page.route('**/storage.js', async route => {
    dispatched();
    await moduleGate;
    await route.continue();
  });
  await page.goto(base, { waitUntil: 'commit' });
  await moduleRequested;
  try {
    for (const mode of MODES) await expect(modeButton(page, mode)).toBeDisabled();
  } finally { release(); }
  for (const mode of MODES) await expect(modeButton(page, mode)).toBeEnabled();
  await expectMode(page, 'on');
});

for (const width of [320, 390]) {
  test(`${width}px mobile drawer fits controls and guidance with reduced motion, keyboard and pending-turn disabling`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let release, dispatched;
    const responseGate = new Promise(resolve => { release = resolve; });
    const requestStarted = new Promise(resolve => { dispatched = resolve; });
    await page.route(`${API}/models/*:generateContent`, async route => {
      dispatched();
      await responseGate;
      await route.fulfill({ json: reply('Mobile turn finished.') });
    });
    await connect(page);
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.locator('#toggle-sidebar').click();
    await expect(section(page)).toBeVisible();
    await section(page).getByText('View model guidance', { exact: true }).click();
    await expect(section(page).locator('#artefact-instruction-text')).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    const motion = await page.locator('#sidebar, #artefact-mode-switch button').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, transitions: style.transitionDuration.split(',').map(duration => parseFloat(duration) * (duration.trim().endsWith('ms') ? 1 : 1000)) };
    }));
    for (const style of motion) {
      expect(style.animation).toBe('none');
      expect(Math.max(...style.transitions)).toBeLessThanOrEqual(.01);
    }
    await modeButton(page, 'on').focus();
    await page.keyboard.press('End');
    await expectMode(page, 'enforced');
    await expect(modeButton(page, 'enforced')).toBeFocused();
    const geometry = await section(page).evaluate(element => {
      const box = element.getBoundingClientRect();
      const sidebar = document.querySelector('#sidebar');
      return {
        left: box.left, right: box.right, viewport: innerWidth, page: document.documentElement.scrollWidth,
        card: element.scrollWidth, cardClient: element.clientWidth,
        drawer: sidebar.scrollWidth, drawerClient: sidebar.clientWidth,
        buttons: [...element.querySelectorAll('[role="radio"]')].map(button => {
          const rect = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          const text = range.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: button.scrollWidth, client: button.clientWidth, textLeft: text.left, textRight: text.right };
        }),
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.card).toBeLessThanOrEqual(geometry.cardClient);
    expect(geometry.drawer).toBeLessThanOrEqual(geometry.drawerClient);
    for (const button of geometry.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(geometry.left);
      expect(button.right).toBeLessThanOrEqual(geometry.right);
      expect(button.width).toBeLessThanOrEqual(button.client);
      expect(button.textLeft).toBeGreaterThanOrEqual(button.left);
      expect(button.textRight).toBeLessThanOrEqual(button.right);
    }
    await page.screenshot({ path: testInfo.outputPath(`interactive-ui-sidebar-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.locator('#close-sidebar').click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.locator('#message-input').fill('Hold a mobile turn.');
    await page.locator('#send-button').click();
    await requestStarted;
    try {
      await page.locator('#toggle-sidebar').click();
      await expect(section(page)).toBeVisible();
      for (const mode of MODES) await expect(modeButton(page, mode)).toBeDisabled();
      await expectMode(page, 'enforced');
    } finally { release(); }
    for (const mode of MODES) await expect(modeButton(page, mode)).toBeEnabled();
    await chooseMode(page, 'off');
    await page.locator('#close-sidebar').click();
    await expect(page.locator('.message.model')).toContainText('Mobile turn finished.');
  });
}
