// Documentation-only fixtures. No real model, credentials, accounts or user profile.
// Run from the repository root after npm ci --ignore-scripts; requires Microsoft Edge.
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from '../server.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const localPath = name => fileURLToPath(new URL(name, import.meta.url));

const assets = new URL('../docs/assets/', import.meta.url);
await mkdir(assets, { recursive: true });
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const API = 'https://generativelanguage.googleapis.com/v1beta';
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 920 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.message().startsWith('Start a new conversation?') ? dialog.accept() : dialog.dismiss());
  let mockedModels = 0, mockedReplies = 0;
  const demo = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Launch checklist demo</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#1e1e1e;color:#fff;font-family:'DejaVu Sans',sans-serif;font-size:12px}header{display:flex;justify-content:space-between;align-items:center;gap:12px}.eyebrow{color:#00ffff;letter-spacing:2px;font-size:9px;font-weight:700}h1{font-size:27px;letter-spacing:-1px;margin:9px 0 7px}p{color:#c7cbd0;margin:0;line-height:1.6}.status{border:1px solid #465669;padding:7px 10px;border-radius:20px;font-size:9px;color:#b9d5ff;white-space:nowrap}.progress-meta{display:flex;justify-content:space-between;margin:23px 0 8px;font-size:10px;color:#c7cbd0}.track{height:5px;border-radius:5px;background:#3b3b3b;overflow:hidden}.bar{height:100%;background:#00ffff;width:66.67%}.tasks{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:20px 0 16px}label{display:flex;align-items:center;gap:9px;border:1px solid #414141;background:#272727;padding:11px 10px;border-radius:7px;font-size:10px;cursor:pointer}input{accent-color:#0066ff;margin:0;width:14px;height:14px}footer{display:flex;justify-content:space-between;border-top:1px solid #414141;padding-top:12px;font-size:9px;color:#a9b1bc}button{font:inherit;color:#00ffff;border:0;background:none;padding:0;cursor:pointer}button:focus-visible{outline:2px solid #00ffff;outline-offset:4px}@media(max-width:500px){body{padding:18px}.tasks{grid-template-columns:1fr}h1{font-size:23px}}
</style></head><body><header><div><div class="eyebrow">SMALL IDEAS. REAL MOMENTUM.</div><h1>Ready for lift-off.</h1><p>A little launch plan you can actually use.</p></div><span class="status">Interactive demo</span></header><div class="progress-meta"><span>Your launch checklist</span><strong id="progress" aria-live="polite">4 of 6 complete</strong></div><div class="track"><div class="bar" id="bar"></div></div><div class="tasks"><label><input type="checkbox" checked>Shape the idea</label><label><input type="checkbox" checked>Build a first version</label><label><input type="checkbox" checked>Write the quick start</label><label><input type="checkbox" checked>Review permissions</label><label><input type="checkbox">Polish the details</label><label><input type="checkbox">Share with the world</label></div><footer><span>Try a checkbox — this preview is live.</span><button id="reset" type="button">Reset checklist</button></footer><script>const boxes=[...document.querySelectorAll('input')];function update(){const count=boxes.filter(box=>box.checked).length;document.querySelector('#progress').textContent=count+' of 6 complete';document.querySelector('#bar').style.width=count/6*100+'%'}boxes.forEach(box=>box.addEventListener('change',update));document.querySelector('#reset').addEventListener('click',()=>{boxes.forEach((box,index)=>box.checked=index<4);update()});update();</script></body></html>`;
  const fullReply = `### From an idea to something you can use\n\nHere’s a self-contained launch checklist. Tick a box to update your progress, or download the HTML to keep it.\n\n<artefact title="Launch checklist">${demo}</artefact>`;

  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(base + '/')) return route.continue();
    if (url.startsWith('https://cdn.jsdelivr.net/')) return route.fulfill({ contentType: 'text/javascript', body: '// No remote scripts in documentation fixtures.' });
    if (url.startsWith(API + '/models?')) {
      mockedModels++;
      return route.fulfill({ json: { models: [{ name: 'models/prism-demo', displayName: 'Prism demo', supportedGenerationMethods: ['generateContent'] }] } });
    }
    if (url === API + '/models/prism-demo:generateContent') {
      mockedReplies++;
      const contents = route.request().postDataJSON().contents;
      const text = contents.at(-1).parts.map(part => part.text || '').join(' ');
      const reply = text.includes('launch checklist') ? fullReply : 'A good place to begin: keep the goal small, compare your options, and build something useful.';
      return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ text: reply }] }, finishReason: 'STOP' }] } });
    }
    throw new Error(`Unexpected documentation-fixture request to ${new URL(url).origin}`);
  });
  await page.goto(base);
  await page.locator('#toggle-settings').click();
  await page.locator('#api-key').fill('demo-fixture-not-a-real-credential');
  await page.locator('#fetch-models').click();
  await page.locator('#model-count').getByText('1 model available', { exact: true }).waitFor();
  await page.locator('#close-settings').click();
  async function send(text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#send-button').click();
    await page.locator('.message.model').waitFor();
    await page.locator('.message.model .thinking').waitFor({ state: 'hidden' });
    await page.locator('#send-button').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#message-input') && !document.querySelector('#message-input').disabled);
  }
  await send('Explore a project idea');
  await page.locator('#new-chat').click();
  await send('Compare model formats');
  await page.locator('#new-chat').click();
  await send('Build an interactive launch checklist with a progress tracker.');
  const child = page.frameLocator('.artefact-frame').frameLocator('iframe');
  await child.getByRole('heading', { name: 'Ready for lift-off.' }).waitFor();
  await child.getByLabel('Share with the world').check();
  assert.equal(await child.locator('#progress').textContent(), '5 of 6 complete');
  await child.getByRole('button', { name: 'Reset checklist' }).click();
  assert.equal(await child.locator('#progress').textContent(), '4 of 6 complete');
  await page.locator('#messages').evaluate(element => { element.scrollTop = 0; });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: localPath('../docs/assets/workspace.png'), animations: 'disabled' });
  await page.locator('#toggle-settings').click();
  await page.locator('#settings-tab-connection').click();
  await page.locator('.settings-panels').evaluate(element => { element.scrollTop = 0; });
  await page.locator('#settings-dialog').screenshot({ path: localPath('../docs/assets/connections.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  assert.equal(mockedModels, 1);
  assert.equal(mockedReplies, 3);
  await context.unroute('**/*');
  const art = await browser.newPage({ viewport: { width: 1280, height: 320 }, deviceScaleFactor: 1 });
  const svg = await readFile(new URL('prism-banner.svg', assets), 'utf8');
  await art.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await art.screenshot({ path: localPath('../artifacts/readme-banner-preview.png') });
  await art.close();
  console.log(JSON.stringify({ generated: ['docs/assets/workspace.png', 'docs/assets/connections.png'], syntheticDemo: true, realProviderRequests: 0, freshBrowserContext: true, checkedInteractivePreview: true, pageErrors: errors.length, mockedModels, mockedReplies }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
