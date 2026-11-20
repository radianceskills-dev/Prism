import { DEFAULT_ENDPOINT, DEFAULT_OPENAI_ENDPOINT, normalizeProtocol, normalizeEndpoint, fetchModels, generateReply, redact, MAX_CHAT_SEARCHES, conversationSearchCount, normalizeArtefactMode, getArtefactInstruction } from './api.js';

import { createNotionClient } from './notion.js';
import { createComposioClient, normalizeWorkerURL } from './composio.js';
import { renderAssistantContent } from './artefacts.js';
import { createStore } from './storage.js';
import { kiloEndpoint, fetchKiloModels, normalizeKiloModel, isKiloModel, kiloModelId } from './kilo.js';
import { readAttachment, validateAttachments, attachmentsToParts, attachmentDataURL, formatAttachmentSize, ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES } from './attachments.js';

const $ = id => document.getElementById(id);
const assistantSources = new WeakMap();
const state = { protocol: 'gemini', modelsProtocol: 'gemini', conversationProtocol: null, artefactMode: 'on', models: [], history: [], transcript: [], busy: true, controller: null, connected: false, conversationEndpoint: null, searchSessionId: crypto.randomUUID(), searchCount: 0, chatId: crypto.randomUUID(), conversations: [], audit: [], notionTools: [], notionBusy: false, composioTools: [], composioBusy: false, loaded: false, clearing: false };
const store = createStore();
const notion = createNotionClient();
let composio = null, composioWorkerURL = '';
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('prism-local-events') : null;
let toastTimer;
state.attachments = [];
state.attachmentBusy = false;
let attachmentEpoch = 0;
$('attachment-input').accept = ATTACHMENT_ACCEPT;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}
function status(text = '', kind = '') {
  const count = kind === 'success' ? text : kind === 'error' && state.models.length ? `${state.models.length} model${state.models.length === 1 ? '' : 's'} available` : '';
  $('model-count').textContent = count;
  $('model-count').hidden = !count;
  $('connection-status').className = `connection-status ${kind}`;
  $('connection-status').lastElementChild.textContent = kind === 'error' ? text : '';
  $('connection-status').hidden = kind !== 'error';
}
function notice(text = '') {
  $('chat-notice').textContent = text;
  $('chat-notice').hidden = !text;
}
// Reserve kilo: for Kilo options, escaping provider IDs that use that namespace.
function modelValue(model) { return isKiloModel(model) || !/^(?:kilo|api):/.test(model.name) ? model.name : `api:${model.name}`; }
function selectedModel() { return state.models.find(model => modelValue(model) === $('model-select').value); }
function modelName(model) { return model?.displayName || model?.name?.replace(/^models\//, '') || 'No model selected'; }
function updateControls() {
  const ready = state.connected && !!selectedModel();
  $('send-button').disabled = state.busy || !ready || (!$('message-input').value.trim() && !state.attachments.length);
  $('attach-files').disabled = state.busy;
  $('attachment-input').disabled = state.busy;
  for (const button of $('attachment-list').querySelectorAll('button')) button.disabled = state.busy;
  $('model-select').disabled = state.busy || !state.models.length;
  $('connection-fields').disabled = state.busy;
  $('system-prompt').disabled = state.busy;
  $('artefact-mode-switch').disabled = state.busy;
  $('artefact-mode-switch').setAttribute('aria-disabled', String(state.busy));
  $('parallel-search').disabled = state.busy;
  $('new-chat').disabled = state.busy;
  for (const button of $('saved-chats').querySelectorAll('button')) button.disabled = state.busy;
  $('delete-chat').disabled = state.busy || !state.conversations.some(chat => chat.id === state.chatId);
  $('clear-data').disabled = state.busy || state.notionBusy || state.composioBusy;
  let sameWorker = false;
  try { sameWorker = !!composio && normalizeWorkerURL($('composio-worker-url').value) === composioWorkerURL; } catch { /* Invalid edits never receive saved credentials. */ }
  const composioConnected = sameWorker && composio.status().connected;
  const composioLocked = state.busy || state.composioBusy || state.notionBusy;
  $('composio-worker-url').disabled = composioLocked;
  $('kilo-worker-url').disabled = composioLocked;
  $('connect-composio').disabled = composioLocked || !$('composio-worker-url').value.trim();
  $('connect-composio').hidden = composioConnected;
  let composioSaved = !!composio;
  try { composioSaved ||= !!(localStorage.getItem('prism.composio.worker.client') || localStorage.getItem('prism.composio.worker.tokens') || sessionStorage.getItem('prism.composio.worker.pending')); }
  catch { composioSaved = true; }
  $('disconnect-composio').hidden = !composioSaved;
  $('disconnect-composio').disabled = composioLocked;
  $('refresh-composio').hidden = !composioConnected;
  $('refresh-composio').disabled = composioLocked;
  $('composio-enabled').disabled = composioLocked || !composioConnected || !state.composioTools.length;
  const connectedApps = notion.status().connected;
  $('connect-notion').disabled = state.busy || state.notionBusy;
  $('disconnect-notion').hidden = !connectedApps;
  $('disconnect-notion').disabled = state.busy || state.notionBusy;
  $('refresh-notion').hidden = !connectedApps;
  $('refresh-notion').disabled = state.busy || state.notionBusy;
  $('notion-enabled').disabled = state.busy || state.notionBusy || !connectedApps || !state.notionTools.length;
  $('export-chat').disabled = !state.transcript.length;
  $('footer-status').textContent = state.busy ? 'Working…' : ready ? modelName(selectedModel()) : 'No model connected';
}
function resizeInput() {
  $('message-input').style.height = 'auto';
  $('message-input').style.height = `${Math.min($('message-input').scrollHeight, 180)}px`;
  updateControls();
}
function attachmentMessage(text = '') {
  $('attachment-status').textContent = text;
  $('attachment-status').hidden = !text;
}
function attachmentSummary({ id, name, mimeType, size, kind }) { return { id, name, mimeType, size, kind }; }
function downloadAttachment(file) {
  const safe = validateAttachments([file])[0];
  const bytes = safe.kind === 'text' ? safe.text : Uint8Array.from(atob(safe.data), char => char.charCodeAt(0));
  // Always download, never navigate to or execute the selected file's contents.
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url; link.download = safe.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderAttachmentCards(container, attachments, { removable = false } = {}) {
  container.replaceChildren();
  for (const file of validateAttachments(attachments)) {
    const card = document.createElement('div');
    card.className = `attachment-card attachment-${file.kind}`;
    if (file.kind === 'image') {
      const image = document.createElement('img');
      image.src = attachmentDataURL(file); image.alt = file.name; image.decoding = 'async';
      card.append(image);
    } else {
      const badge = document.createElement('span');
      badge.className = 'attachment-badge'; badge.textContent = file.kind === 'pdf' ? 'PDF' : 'TXT';
      badge.setAttribute('aria-hidden', 'true'); card.append(badge);
    }
    const info = document.createElement('div'); info.className = 'attachment-info';
    const name = document.createElement('strong'); name.textContent = file.name; name.title = file.name;
    const detail = document.createElement('span'); detail.textContent = `${formatAttachmentSize(file.size)} · ${file.kind === 'text' ? 'UTF-8 text' : file.mimeType}`;
    info.append(name, detail); card.append(info);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'icon-button attachment-action';
    button.setAttribute('aria-label', `${removable ? 'Remove' : 'Download'} ${file.name}`);
    button.title = `${removable ? 'Remove' : 'Download'} ${file.name}`;
    if (removable) {
      button.textContent = '×'; button.disabled = state.busy;
      button.addEventListener('click', () => {
        if (state.busy) return;
        state.attachments = state.attachments.filter(item => item.id !== file.id);
        renderDraftAttachments(); attachmentMessage(state.attachments.length ? `${state.attachments.length} file(s) attached locally.` : 'Attachment removed.');
        void persist(); $('attach-files').focus();
      });
    } else { button.append(icon('download')); button.addEventListener('click', () => downloadAttachment(file)); }
    card.append(button);
    if (file.kind === 'text') {
      const preview = document.createElement('details'); preview.className = 'attachment-text-preview';
      const summary = document.createElement('summary'); summary.textContent = 'Text preview';
      const pre = document.createElement('pre'); pre.textContent = file.text.slice(0, 6000) + (file.text.length > 6000 ? '\n… Preview truncated; the complete file is sent.' : '');
      preview.append(summary, pre); card.append(preview);
    }
    container.append(card);
  }
  container.hidden = !attachments.length;
}
function renderDraftAttachments() {
  renderAttachmentCards($('attachment-list'), state.attachments, { removable: true });
  updateControls();
}
async function addLocalAttachments(files) {
  if (!files.length || state.busy || !state.loaded) return;
  const epoch = attachmentEpoch;
  try {
    if (files.length + state.attachments.length > MAX_ATTACHMENTS) throw new Error('Attach at most 4 files per message. Remove a file first.');
    if (files.reduce((sum, file) => sum + file.size, state.attachments.reduce((sum, file) => sum + file.size, 0)) > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('Attachments in one message must total 8 MiB or less. Choose smaller files.');
    state.busy = true; state.attachmentBusy = true; updateControls();
    attachmentMessage('Reading files locally…');
    const additions = await Promise.all(files.map(readAttachment));
    if (epoch !== attachmentEpoch || state.clearing) return;
    state.attachments = validateAttachments([...state.attachments, ...additions]);
    renderDraftAttachments();
    attachmentMessage(`${state.attachments.length} file(s) attached locally. Shared with your model endpoint only when you send.`);
    await persist();
  } catch (error) { if (epoch === attachmentEpoch) attachmentMessage(error.message); }
  finally {
    if (epoch === attachmentEpoch) { state.busy = false; state.attachmentBusy = false; updateControls(); }
  }
}
$('attach-files').addEventListener('click', () => { if (!state.busy) $('attachment-input').click(); });
$('attachment-input').addEventListener('change', event => {
  const files = Array.from(event.target.files || []); event.target.value = '';
  void addLocalAttachments(files);
});
$('message-input').addEventListener('paste', event => {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) return;
  event.preventDefault();
  if (state.busy) { attachmentMessage('Wait for this response to finish before attaching files.'); return; }
  void addLocalAttachments(files);
});
for (const type of ['dragenter', 'dragover']) $('chat-form').addEventListener(type, event => {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = state.busy ? 'none' : 'copy';
  $('chat-form').classList.toggle('is-file-drop', !state.busy);
});
$('chat-form').addEventListener('dragleave', event => { if (!$('chat-form').contains(event.relatedTarget)) $('chat-form').classList.remove('is-file-drop'); });
document.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => {
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  event.preventDefault(); $('chat-form').classList.remove('is-file-drop');
  if (!$('chat-form').contains(event.target)) { attachmentMessage('Drop files in the message composer to attach them.'); return; }
  if (state.busy) { attachmentMessage('Wait for this response to finish before attaching files.'); return; }
  void addLocalAttachments(files);
});
let settingsReturnFocus = null;
let sidebarReturnFocus = null;
function setSettingsOpen(open, tab = 'connection') {
  const dialog = $('settings-dialog');
  if (open) {
    settingsReturnFocus = document.activeElement;
    showSettingsTab(tab);
    if (!dialog.open) dialog.showModal();
    $('toggle-settings').setAttribute('aria-expanded', 'true');
    $(`settings-tab-${tab}`).focus();
  } else if (dialog.open) {
    dialog.close();
    $('toggle-settings').setAttribute('aria-expanded', 'false');
    if (settingsReturnFocus?.isConnected) settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }
}
function showSettingsTab(name) {
  const tabs = ['connection', 'tools', 'instructions', 'data'];
  if (!tabs.includes(name)) name = 'connection';
  for (const tab of tabs) {
    const button = $(`settings-tab-${tab}`);
    const panel = $(`settings-panel-${tab}`);
    const active = tab === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
}
function setSidebarOpen(open) {
  const sidebar = $('sidebar');
  if (open) {
    sidebarReturnFocus = document.activeElement;
    document.querySelector('.workspace').inert = true;
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.classList.add('is-open');
    $('sidebar-backdrop').hidden = false;
    $('toggle-sidebar').setAttribute('aria-expanded', 'true');
    $('close-sidebar').focus();
  } else {
    document.querySelector('.workspace').inert = false;
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    sidebar.classList.remove('is-open');
    $('sidebar-backdrop').hidden = true;
    $('toggle-sidebar').setAttribute('aria-expanded', 'false');
    if (sidebarReturnFocus?.isConnected) sidebarReturnFocus.focus();
    sidebarReturnFocus = null;
  }
}
function defaultEndpoint(protocol = state.protocol) { return protocol === 'openai' ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_ENDPOINT; }
function updateProtocolUI() {
  const openai = state.protocol === 'openai';
  for (const input of $('api-protocol').querySelectorAll('input')) input.checked = input.value === state.protocol;
  $('endpoint').placeholder = defaultEndpoint();
  // The configured provider is optional when anonymous Kilo discovery is enabled.
  $('api-key').required = !openai && !$('kilo-enabled').checked;
  $('endpoint').required = !$('kilo-enabled').checked;
  const keyURL = openai ? 'https://platform.openai.com/api-keys' : 'https://aistudio.google.com/apikey';
  $('data-key-link').href = keyURL;
  $('data-key-label').textContent = openai ? 'Get an OpenAI API key' : 'Get a Gemini API key';
}
function populateModels(previous = $('model-select').value) {
  $('model-select').replaceChildren(...state.models.map(model => new Option(modelName(model), modelValue(model))));
  const chosen = state.models.find(model => modelValue(model) === previous)
    || (state.protocol === 'gemini' && state.models.find(model => !isKiloModel(model) && /gemini-.*flash/.test(model.name) && !/image|tts|audio|live|native|preview|exp/.test(model.name)))
    || state.models[0];
  if (chosen) $('model-select').value = modelValue(chosen);
  else $('model-select').add(new Option('Choose a model', ''));
  updateModel();
}
function configuredKiloEndpoint() {
  try { return kiloEndpoint($('composio-worker-url').value); } catch { return ''; }
}
function updateKiloStatus(text) {
  const count = state.models.filter(isKiloModel).length;
  $('kilo-status').textContent = !$('kilo-enabled').checked ? 'Off · only your configured API is used.'
    : text || (!configuredKiloEndpoint() ? 'On · paste your shared Worker URL, then reload models.'
      : count ? `${count} Kilo model${count === 1 ? '' : 's'} available · via your Worker · no API key sent.` : 'On · reload models to discover Kilo’s free and stealth models via your Worker.');
}
function invalidateConnection() {
  // Editing the configured provider must not invalidate an independent Kilo cache.
  state.models = $('kilo-enabled').checked ? state.models.filter(isKiloModel) : [];
  state.modelsProtocol = state.protocol;
  populateModels();
  status();
  updateKiloStatus();
}
function updateModel() {
  const model = selectedModel();
  state.connected = !!model && (isKiloModel(model) ? $('kilo-enabled').checked && !!configuredKiloEndpoint() : state.protocol === 'openai' || !!$('api-key').value.trim());
  $('active-model').textContent = modelName(model);
  updateControls();
}
$('kilo-enabled').addEventListener('change', async () => {
  if (state.busy) return;
  updateProtocolUI();
  if (!$('kilo-enabled').checked) {
    state.models = state.models.filter(model => !isKiloModel(model));
    populateModels();
  }
  status(state.models.length ? `${state.models.length} model${state.models.length === 1 ? '' : 's'} available` : '', state.models.length ? 'success' : '');
  updateKiloStatus();
  await persist({ settingsOnly: true });
});
$('api-protocol').addEventListener('change', event => {
  if (state.busy) { updateProtocolUI(); return; }
  const protocol = normalizeProtocol(event.target.value);
  if (protocol === state.protocol) return;
  let endpoint = $('endpoint').value.trim();
  try { endpoint = normalizeEndpoint(endpoint); } catch { /* Keep custom input for the user to correct. */ }
  state.protocol = protocol;
  if (!endpoint || [DEFAULT_ENDPOINT, DEFAULT_OPENAI_ENDPOINT].includes(endpoint)) $('endpoint').value = defaultEndpoint();
  // Do not carry a credential into a different wire protocol/provider by accident.
  $('api-key').value = '';
  $('api-key').type = 'password';
  $('toggle-key').setAttribute('aria-label', 'Show API key');
  $('toggle-key').setAttribute('aria-pressed', 'false');
  updateProtocolUI();
  invalidateConnection();
  void persist({ settingsOnly: true });
});
updateProtocolUI();
function scrollToBottom() { $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight; }

function updateArtefactMode() {
  const group = $('artefact-mode-switch');
  group.dataset.state = state.artefactMode;
  for (const button of group.querySelectorAll('[role="radio"]')) {
    const selected = button.dataset.mode === state.artefactMode;
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  $('artefact-mode-help').textContent = {
    off: 'Plain code only. Interactive UI won’t run.',
    on: 'Interactive UI is available when useful.',
    enforced: 'Use interactive UI by default at the end of each answer.',
  }[state.artefactMode];
  $('artefact-instruction-text').textContent = getArtefactInstruction(state.artefactMode);
}
function setArtefactMode(value) {
  if (state.busy) return;
  const mode = normalizeArtefactMode(value);
  if (mode === state.artefactMode) return;
  const renderingChanged = (state.artefactMode === 'off') !== (mode === 'off');
  state.artefactMode = mode;
  updateArtefactMode();
  if (renderingChanged) {
    // Preserve articles, copy buttons, tool activity, draft and original history.
    // Entering Off removes running frames; leaving Off starts from saved source.
    const scrollTop = $('chat-scroll').scrollTop;
    for (const container of $('messages').querySelectorAll('.message.model > .message-main > .message-content')) {
      const source = assistantSources.get(container);
      if (typeof source === 'string') renderContent(container, source, 'model');
    }
    $('chat-scroll').scrollTop = scrollTop;
  }
  void persist({ settingsOnly: true });
}
for (const button of $('artefact-mode-switch').querySelectorAll('[role="radio"]')) {
  button.addEventListener('click', () => setArtefactMode(button.dataset.mode));
}
$('artefact-mode-switch').addEventListener('keydown', event => {
  if (state.busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...$('artefact-mode-switch').querySelectorAll('[role="radio"]')];
  const current = buttons.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next].click();
  buttons[next].focus();
});
updateArtefactMode();

// Only HTTP(S) links become anchors; model HTML and executable schemes stay inert text.
function renderLinks(container, text) {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s<>]+?)\)|https?:\/\/[^\s<>]+/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(end, match.index)));
    let href = match[2] || match[0];
    let suffix = '';
    if (!match[2]) { const trimmed = href.replace(/[.,;!?)\]]+$/, ''); suffix = href.slice(trimmed.length); href = trimmed; }
    try {
      const url = new URL(href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe link');
      const a = document.createElement('a');
      a.href = url.href;
      a.textContent = match[1] || href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      container.append(a, document.createTextNode(suffix));
    } catch { container.append(document.createTextNode(match[0])); }
    end = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(end)));
}
function renderSearches(article, searches) {
  article.querySelector('.search-activity')?.remove();
  if (!searches.length) return;
  const details = document.createElement('details');
  details.className = 'search-activity';
  const summary = document.createElement('summary');
  const running = searches.some(search => search.status === 'searching');
  const failed = searches.some(search => search.status === 'error');
  summary.textContent = running ? 'Searching the web with Parallel…' : `Parallel · ${searches.length} search${searches.length === 1 ? '' : 'es'}${failed ? ' · some searches failed' : ' completed'}`;
  details.append(summary);
  for (const search of searches) {
    const p = document.createElement('p');
    p.textContent = `${search.queries.join(' · ') || search.objective}\n${search.error || (search.status === 'searching' ? 'Searching…' : 'Results returned to the model')}`;
    if (search.error) p.className = 'search-error';
    details.append(p);
  }
  const main = article.querySelector('.message-main');
  main.insertBefore(details, main.querySelector('.message-content'));
}

// Keep user input literal; only assistant replies pass through the safe Markdown renderer.
function renderContent(container, text, role) {
  if (role === 'model') {
    assistantSources.set(container, text);
    return renderAssistantContent(container, text, { enabled: state.artefactMode !== 'off' });
  }
  const paragraph = document.createElement('p');
  renderLinks(paragraph, text);
  container.replaceChildren(paragraph);
}
function appendMessage(role, text, { model = '', warning = '', pending = false, attachments = [] } = {}) {
  $('welcome').hidden = true;
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  if (role === 'user') avatar.textContent = 'Y'; else avatar.append(icon('spark'));
  const main = document.createElement('div');
  main.className = 'message-main';
  const heading = document.createElement('div');
  heading.className = 'message-heading';
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  const meta = document.createElement('span');
  meta.textContent = role === 'user' ? 'Just now' : model;
  heading.append(label, meta);
  const content = document.createElement('div');
  content.className = 'message-content';
  if (pending) {
    content.classList.add('thinking');
    content.setAttribute('aria-label', 'Waiting for a response');
    for (let i = 0; i < 3; i++) content.append(document.createElement('span'));
  } else {
    renderContent(content, text, role);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'icon-button message-copy';
    copy.setAttribute('aria-label', 'Copy message');
    copy.append(icon('copy'));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Message copied'); }
      catch { toast('Could not copy. Select the message text to copy it.'); }
    });
    heading.append(copy);
  }
  main.append(heading, content);
  if (role === 'user' && attachments.length) {
    const files = document.createElement('div'); files.className = 'message-attachments';
    try { renderAttachmentCards(files, attachments); }
    catch { files.textContent = 'Saved attachment data is invalid or unavailable. It will not be sent without validation.'; }
    main.append(files);
  }
  if (warning) {
    const note = document.createElement('p');
    note.className = 'message-warning';
    note.textContent = warning;
    main.append(note);
  }
  article.append(avatar, main);
  $('messages').append(article);
  scrollToBottom();
  return article;
}

$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy) return;
  notice();
  const kiloEnabled = $('kilo-enabled').checked;
  let endpoint, providerError;
  try { endpoint = normalizeEndpoint($('endpoint').value); }
  catch (error) { providerError = error; }
  const key = $('api-key').value.trim();
  if (!key && state.protocol !== 'openai') providerError ||= new Error('Enter your API key first.');
  if (providerError && !kiloEnabled) { status(providerError.message, 'error'); return; }
  const previous = $('model-select').value;
  state.connected = false;
  state.busy = true;
  state.controller = new AbortController();
  const timer = setTimeout(() => state.controller?.abort('timeout'), 30000);
  $('fetch-models').setAttribute('aria-busy', 'true');
  status();
  updateControls();
  try {
    // Settle independently: either source remains usable if the other is unavailable.
    const [providerResult, kiloResult] = await Promise.allSettled([
      providerError ? Promise.reject(providerError) : fetchModels({ endpoint, key, protocol: state.protocol, signal: state.controller.signal }),
      kiloEnabled ? fetchKiloModels({ workerURL: $('composio-worker-url').value, signal: state.controller.signal }) : Promise.resolve([]),
    ]);
    state.models = [
      ...(providerResult.status === 'fulfilled' ? providerResult.value : []),
      ...(kiloResult.status === 'fulfilled' ? kiloResult.value : []),
    ];
    state.modelsProtocol = state.protocol;
    if (endpoint) $('endpoint').value = endpoint;
    populateModels(previous);
    const warnings = [];
    if (providerResult.status === 'rejected') warnings.push(`Configured API: ${redact(providerResult.reason?.message || 'Model discovery failed.', key)}`);
    else if (!providerResult.value.length) warnings.push('Configured API: no chat models were returned.');
    if (kiloEnabled) {
      if (kiloResult.status === 'rejected') {
        const message = state.controller.signal.aborted ? 'Discovery timed out. Reload models to try again.' : kiloResult.reason?.message || 'Model discovery failed.';
        warnings.push(`Kilo: ${redact(message, key)}`);
        updateKiloStatus(`Kilo unavailable · ${redact(message, key)}`);
      } else {
        if (!kiloResult.value.length) warnings.push('Kilo: no free or stealth chat models are available.');
        updateKiloStatus(kiloResult.value.length ? undefined : 'No free or stealth chat models are currently available.');
      }
    }
    status(warnings.length ? `${state.models.length ? `${state.models.length} models available. ` : ''}${warnings.join(' ')}` : `${state.models.length} model${state.models.length === 1 ? '' : 's'} available`, warnings.length ? 'error' : 'success');
  } catch (error) {
    state.models = [];
    $('model-select').replaceChildren(new Option('Choose a model', ''));
    status(state.controller.signal.aborted ? 'The connection timed out. Check your endpoint and try again.' : redact(error.message, key), 'error');
  } finally {
    clearTimeout(timer);
    state.busy = false;
    state.controller = null;
    $('fetch-models').setAttribute('aria-busy', 'false');
    updateModel();
    await persist();
  }
});

$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('message-input').value.trim();
  const model = selectedModel();
  if ((!text && !state.attachments.length) || state.busy) return;
  let attachments;
  try { attachments = validateAttachments(state.attachments); }
  catch (error) { attachmentMessage(error.message); return; }
  if (!state.connected || !model) {
    notice('Add your API key and fetch models in connection settings first.');
    setSettingsOpen(true);
    $('api-key').focus();
    return;
  }
  const kilo = isKiloModel(model);
  if (kilo && !$('kilo-enabled').checked) { notice('Enable Kilo Free Models and reload models first.'); return; }
  // A Kilo selection can never inherit the configured endpoint, format or credential.
  if (kilo && !configuredKiloEndpoint()) { notice('Paste your shared Cloudflare Worker URL and reload Kilo models first.'); return; }
  const endpoint = kilo ? configuredKiloEndpoint() : normalizeEndpoint($('endpoint').value);
  const protocol = kilo ? 'openai' : state.protocol;
  if (state.history.length && (state.conversationEndpoint !== endpoint || state.conversationProtocol !== protocol) && !confirm(`You changed the API endpoint or format. Continuing will send the entire current conversation to ${endpoint} using the ${protocol === 'openai' ? 'OpenAI-compatible' : 'Gemini'} API format. Continue? Choose Cancel, then New conversation to avoid sharing previous messages.`)) return;
  notice();
  setSettingsOpen(false);
  state.busy = true;
  state.controller = new AbortController();
  const timer = setTimeout(() => state.controller?.abort('timeout'), 120000);
  const userMessage = { role: 'user', parts: [...(text ? [{ text }] : []), ...attachmentsToParts(attachments)] };
  state.pendingDraft = { text, attachments };
  const userNode = appendMessage('user', text, { attachments });
  const pendingNode = appendMessage('model', '', { model: modelName(model), pending: true });
  $('message-input').value = '';
  state.attachments = []; renderDraftAttachments(); attachmentMessage();
  resizeInput();
  $('stop-button').hidden = false;
  $('send-button').hidden = true;
  const key = kilo ? '' : $('api-key').value.trim();
  const turnId = crypto.randomUUID();
  try {
    // Keep pending file bytes as a recoverable local draft, never as an auto-replayed turn.
    await persist();
    const progress = [];
    const result = await generateReply({
      endpoint, key, protocol, model: kilo ? kiloModelId(model) : model.name, contents: [...state.history, userMessage],
      systemInstruction: $('system-prompt').value, artefactMode: state.artefactMode, signal: state.controller.signal,
      searchEnabled: $('parallel-search').checked, searchesUsed: state.searchCount, sessionId: state.searchSessionId,
      notionTools: $('notion-enabled').checked ? state.notionTools : [],
      notionCall: (name, args, options) => notion.callTool(name, args, options),
      composioTools: $('composio-enabled').checked ? state.composioTools : [],
      composioCall: (name, args, options) => {
        if (!composio || !$('composio-enabled').checked) throw new Error('Composio is disabled. The tool was not executed.');
        return composio.callTool(name, args, options);
      },
      onTool: entry => {
        const record = { ...entry, turn: turnId, time: new Date().toISOString() };
        const index = state.audit.findIndex(item => item.turn === turnId && item.index === entry.index);
        if (index < 0) state.audit.push(record); else state.audit[index] = record;
        renderAudit();
        void persist();
      },
      onSearch: async search => {
        if (search.status === 'searching') {
          // Reserve each attempt durably before sending it. Cancellation, a
          // provider error or a rolled-back model turn must not reset usage.
          state.searchCount = Math.min(MAX_CHAT_SEARCHES, state.searchCount + 1);
          updateSearchSettings();
          if (!await persist()) throw new Error('Unable to save search usage. This search was not sent; check browser storage.');
        }
        progress[search.index - 1] = search;
        renderSearches(pendingNode, progress);
        scrollToBottom();
      },
    });
    state.conversationEndpoint = endpoint;
    state.conversationProtocol = protocol;
    state.history = result.contents;
    const searchNotes = result.searches.length ? '\n\nParallel searches:\n' + result.searches.map(s => `- ${s.queries.join(' · ')}${s.error ? ` — failed: ${s.error}` : ''}`).join('\n') : '';
    // Payloads live once in history; transcript entries reference immutable file metadata.
    state.transcript.push({ role: 'You', text, ...(attachments.length ? { attachments: attachments.map(attachmentSummary) } : {}) }, { role: modelName(model), text: result.text + searchNotes, displayText: result.text, warning: result.warning, searches: result.searches });
    pendingNode.remove();
    const replyNode = appendMessage('model', result.text, { model: modelName(model), warning: result.warning });
    renderSearches(replyNode, result.searches);
    $('chat-title').textContent = (state.transcript[0].text || state.transcript[0].attachments?.[0]?.name || 'Attached files').slice(0, 55);
  } catch (error) {
    pendingNode.remove();
    userNode.remove();
    // Failed turns never pollute subsequent request history. Preserve any draft typed while waiting.
    $('message-input').value = text + ($('message-input').value ? `\n\n${$('message-input').value}` : '');
    state.attachments = attachments;
    renderDraftAttachments();
    attachmentMessage(attachments.length ? 'Your attached files are restored locally. Nothing will be retried automatically.' : '');
    const aborted = state.controller.signal.aborted;
    const uncertain = state.audit.filter(item => item.turn === turnId && item.status === 'running');
    for (const item of uncertain) { item.status = 'unknown'; item.error = 'Execution may have completed remotely. Check the connected app before retrying.'; }
    renderAudit();
    notice((uncertain.length || error.executionOutcomeUnknown) ? 'Notion execution outcome is unknown. Stop only cancels the local request; it cannot undo remote actions. Check the connected app before retrying.' : aborted ? state.controller.signal.reason === 'timeout' ? 'The response timed out after two minutes. Your message is restored; try again or use another model.' : 'Response stopped. Your message is restored below.' : redact(error.message, key));
    $('welcome').hidden = !!state.transcript.length;
  } finally {
    clearTimeout(timer);
    state.pendingDraft = null;
    state.busy = false;
    state.controller = null;
    $('stop-button').hidden = true;
    $('send-button').hidden = false;
    resizeInput();
    $('message-input').focus();
    await persist();
  }
});

$('endpoint').addEventListener('input', invalidateConnection);
$('api-key').addEventListener('input', invalidateConnection);
$('model-select').addEventListener('change', updateModel);
function updateSearchSettings() {
  const usage = `${state.searchCount}/${MAX_CHAT_SEARCHES} searches used`;
  $('search-mode').textContent = state.searchCount >= MAX_CHAT_SEARCHES
    ? `${usage} · Search limit reached for this conversation. Start a new conversation to search again.`
    : `${$('parallel-search').checked ? 'On · model decides when to search' : 'Web search off · no new searches'} · ${usage}`;
}
$('parallel-search').addEventListener('change', updateSearchSettings);
$('message-input').addEventListener('input', resizeInput);
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!state.busy) $('chat-form').requestSubmit();
  }
});
$('toggle-key').addEventListener('click', () => {
  const show = $('api-key').type === 'password';
  $('api-key').type = show ? 'text' : 'password';
  $('toggle-key').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
  $('toggle-key').setAttribute('aria-pressed', String(show));
});
$('toggle-settings').addEventListener('click', () => setSettingsOpen(!$('settings-dialog').open));
$('setup-connection')?.addEventListener('click', () => setSettingsOpen(true, 'connection'));
$('close-settings').addEventListener('click', () => setSettingsOpen(false));
$('settings-dialog').addEventListener('cancel', event => { event.preventDefault(); setSettingsOpen(false); });
$('settings-dialog').addEventListener('close', () => $('toggle-settings').setAttribute('aria-expanded', 'false'));
for (const tab of ['connection', 'tools', 'instructions', 'data']) $(`settings-tab-${tab}`).addEventListener('click', () => showSettingsTab(tab));
$('toggle-sidebar').addEventListener('click', () => setSidebarOpen(!$('sidebar').classList.contains('is-open')));
$('close-sidebar').addEventListener('click', () => setSidebarOpen(false));
$('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
matchMedia('(max-width:600px)').addEventListener('change', () => setSidebarOpen(false));
$('sidebar').addEventListener('keydown', event => {
  if (event.key !== 'Tab' || !$('sidebar').classList.contains('is-open')) return;
  const focusable = [...$('sidebar').querySelectorAll('a[href],button,summary,[tabindex]')].filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length);
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
document.querySelector('.settings-tabs').addEventListener('keydown', event => {
  const tabs = [...document.querySelectorAll('.settings-tab')];
  const current = tabs.indexOf(document.activeElement);
  if (current < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if ($('settings-dialog').open) setSettingsOpen(false); else if ($('sidebar').classList.contains('is-open')) setSidebarOpen(false); } });
$('stop-button').addEventListener('click', () => state.controller?.abort('user'));
$('new-chat').addEventListener('click', async () => {
  if (state.busy || (state.transcript.length && !confirm('Start a new conversation? This chat stays in Saved conversations on this browser.'))) return;
  await persist();
  openConversation();
  await persist();
  setSettingsOpen(false);
  $('message-input').focus();
});
for (const card of document.querySelectorAll('.prompt-card')) {
  card.addEventListener('click', () => {
    $('message-input').value = card.dataset.prompt;
    resizeInput();
    $('message-input').focus();
    if (!state.connected) { notice('Nice choice. Connect your API key and fetch models to send it.'); setSettingsOpen(true); }
  });
}
$('export-chat').addEventListener('click', () => {
  if (!state.transcript.length) return;
  const markdown = '# Prism conversation\n\n' + state.transcript.map(turn => {
    const files = Array.isArray(turn.attachments) ? turn.attachments : [];
    const names = files.map(file => `- ${String(file.name).replace(/[\\`*_{}[\]<>()#!|]/g, '\\$&')} (${formatAttachmentSize(file.size)})`).join('\n');
    return `## ${turn.role}\n\n${turn.text}${names ? `\n\nAttached files (names only; use Export all chats JSON for file contents):\n${names}` : ''}`;
  }).join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `prism-chat-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function renderSavedChats() {
  const fragment = document.createDocumentFragment();
  for (const chat of [...state.conversations].reverse()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-item';
    button.dataset.chatId = chat.id;
    button.setAttribute('aria-current', String(chat.id === state.chatId));
    button.textContent = chat.title || 'Conversation';
    button.title = chat.title || 'Conversation';
    button.addEventListener('click', async () => {
      if (state.busy) return;
      await persist();
      openConversation(state.conversations.find(item => item.id === chat.id));
      setSidebarOpen(false);
      await persist();
    });
    fragment.append(button);
  }
  $('saved-chats').replaceChildren(fragment);
  updateControls();
}
function renderAudit() {
  $('tool-audit').hidden = !state.audit.length;
  $('tool-audit-entries').replaceChildren();
  for (const entry of state.audit.slice(-30)) {
    const p = document.createElement('p');
    p.textContent = `${entry.provider === 'composio' ? 'Composio · ' : ''}${entry.name} · ${entry.status}${entry.error ? ' — ' + entry.error : ''}`;
    $('tool-audit-entries').append(p);
  }
}
async function persist({ settingsOnly = false } = {}) {
  if (!state.loaded || state.clearing) return false;
  const typed = $('message-input').value;
  const draft = state.pendingDraft ? state.pendingDraft.text + (typed ? `\n\n${typed}` : '') : typed;
  const draftAttachments = state.pendingDraft?.attachments || state.attachments;
  if (!settingsOnly && (state.transcript.length || state.audit.length || state.searchCount || draft || draftAttachments.length)) {
    const chat = { id: state.chatId, title: (state.transcript[0]?.text || state.transcript[0]?.attachments?.[0]?.name || draft || draftAttachments[0]?.name || (state.searchCount ? 'Search activity' : 'Tool activity')).slice(0, 55), history: state.history, transcript: state.transcript, audit: state.audit, endpoint: state.conversationEndpoint, protocol: state.conversationProtocol, sessionId: state.searchSessionId, searchCount: state.searchCount, draft, draftAttachments };
    const index = state.conversations.findIndex(item => item.id === chat.id);
    if (index < 0) state.conversations.push(chat); else state.conversations[index] = chat;
  } else if (!settingsOnly) {
    state.conversations = state.conversations.filter(chat => chat.id !== state.chatId);
  }
  try {
    await store.save({ version: 1, settings: { protocol: state.protocol, kiloEnabled: $('kilo-enabled').checked, modelsProtocol: state.modelsProtocol, endpoint: $('endpoint').value, key: $('api-key').value, model: $('model-select').value, models: state.models, system: $('system-prompt').value, artefactMode: state.artefactMode, search: $('parallel-search').checked, notion: $('notion-enabled').checked, composioWorkerURL: $('composio-worker-url').value.trim(), composioEnabled: $('composio-enabled').checked }, conversations: state.conversations, activeId: state.chatId });
    $('storage-status').textContent = 'Saved';
    renderSavedChats();
    return true;
  } catch (error) { $('storage-status').textContent = error.message; return false; }
}
function openConversation(chat) {
  attachmentEpoch++;
  state.pendingDraft = null;
  state.chatId = chat?.id || crypto.randomUUID();
  state.history = chat?.history || [];
  state.transcript = chat?.transcript || [];
  state.audit = chat?.audit || [];
  // Never replay a previously interrupted action (including legacy pending approvals).
  for (const item of state.audit) if (['approval', 'running'].includes(item.status)) { item.status = 'unknown'; item.error = 'Interrupted turn. Check the connected app before retrying.'; }
  state.conversationEndpoint = chat?.endpoint || null;
  state.conversationProtocol = chat ? normalizeProtocol(chat.protocol) : null;
  state.searchSessionId = chat?.sessionId || crypto.randomUUID();
  state.searchCount = conversationSearchCount(chat);
  updateSearchSettings();
  $('messages').replaceChildren();
  const savedFiles = new Map(state.history.flatMap(turn => (Array.isArray(turn.parts) ? turn.parts : []).filter(part => part?.prismAttachment).map(part => [part.prismAttachment.id, part.prismAttachment])));
  for (const turn of state.transcript) {
    const attachments = Array.isArray(turn.attachments) ? turn.attachments.map(file => savedFiles.get(file.id) || file) : [];
    const node = appendMessage(turn.role === 'You' ? 'user' : 'model', turn.displayText || turn.text, { model: turn.role, warning: turn.warning || '', attachments });
    if (Array.isArray(turn.searches)) renderSearches(node, turn.searches);
  }
  $('message-input').value = chat?.draft || '';
  $('welcome').hidden = !!state.transcript.length;
  $('chat-title').textContent = chat?.title || 'New conversation';
  let attachmentError = '';
  try { state.attachments = validateAttachments(chat?.draftAttachments ?? []); }
  catch (error) { state.attachments = []; attachmentError = `Saved draft attachments could not be restored: ${error.message}`; }
  renderDraftAttachments(); attachmentMessage(attachmentError || (state.attachments.length ? 'Saved local attachments restored. Shared only when you send.' : ''));
  renderAudit(); renderSavedChats(); resizeInput(); notice();
}
async function refreshNotion() {
  if (!notion.status().connected) return;
  state.notionBusy = true;
  state.notionTools = [];
  $('notion-status').textContent = 'Discovering Notion tools…';
  updateControls();
  try {
    state.notionTools = await notion.listTools({});
    $('notion-status').textContent = `Connected · ${state.notionTools.length} tools`;
  } catch (error) {
    $('notion-enabled').checked = false;
    $('notion-status').textContent = error.message;
  } finally { state.notionBusy = false; updateControls(); }
}
$('connect-notion').addEventListener('click', async () => {
  if (state.busy || state.notionBusy) return;
  state.notionBusy = true; updateControls();
  $('notion-status').textContent = 'Opening Notion sign-in…';
  try {
    if (!await persist()) throw new Error('Save your work before signing in: browser storage is unavailable.');
    await notion.connect();
  } catch (error) { $('notion-status').textContent = error.message; }
  finally { state.notionBusy = false; updateControls(); }
});
$('disconnect-notion').addEventListener('click', async () => {
  if (!confirm('Forget Notion credentials on this browser? To revoke remote account access, also disconnect in Notion. Previously returned data stays in saved chats.')) return;
  try {
    await notion.disconnect();
    state.notionTools = [];
    $('notion-enabled').checked = false;
    $('notion-status').textContent = 'Disconnected locally. Manage or revoke app access in Notion.';
    channel?.postMessage('disconnect');
    await persist(); updateControls();
  } catch (error) { $('notion-status').textContent = error.message; }
});
$('refresh-notion').addEventListener('click', refreshNotion);

function forgetComposioCredentials() {
  if (composio) composio.disconnect();
  else {
    for (const [kind, keys] of [['localStorage', ['prism.composio.worker.client', 'prism.composio.worker.tokens']], ['sessionStorage', ['prism.composio.worker.pending']]]) {
      for (const key of keys) globalThis[kind].removeItem(key);
    }
  }
  state.composioTools = [];
  $('composio-enabled').checked = false;
}
async function refreshComposio() {
  if (!composio?.status().connected || state.composioBusy) return;
  state.composioBusy = true;
  state.composioTools = [];
  $('composio-status').textContent = 'Discovering Composio tools…';
  updateControls();
  try {
    state.composioTools = await composio.listTools({});
    $('composio-status').textContent = `Connected · ${state.composioTools.length} tools · via your Worker`;
  } catch (error) {
    $('composio-enabled').checked = false;
    $('composio-status').textContent = error.message;
  } finally { state.composioBusy = false; updateControls(); }
}
function sharedWorkerEdited(source) {
  // One explicit transport choice, mirrored across Connection and Tools.
  const value = $(source).value;
  $('composio-worker-url').value = value;
  $('kilo-worker-url').value = value;
  state.models = state.models.filter(model => !isKiloModel(model));
  populateModels();
  status(state.models.length ? `${state.models.length} model${state.models.length === 1 ? '' : 's'} available` : '', state.models.length ? 'success' : '');
  updateKiloStatus();
  state.composioTools = [];
  $('composio-enabled').checked = false;
  let sameWorker = false;
  try { sameWorker = !!composio && normalizeWorkerURL($('composio-worker-url').value) === composioWorkerURL; } catch { /* Wait for a valid, explicitly trusted URL. */ }
  $('composio-status').textContent = sameWorker ? 'Worker unchanged. Refresh tools to re-enable model access.' : 'URL changed. Connect to trust this Worker; no credentials have been sent to it.';
  updateControls();
  void persist();
}
$('composio-worker-url').addEventListener('input', () => sharedWorkerEdited('composio-worker-url'));
$('kilo-worker-url').addEventListener('input', () => sharedWorkerEdited('kilo-worker-url'));
$('connect-composio').addEventListener('click', async () => {
  if (state.busy || state.composioBusy || state.notionBusy) return;
  state.composioBusy = true; updateControls();
  try {
    const url = normalizeWorkerURL($('composio-worker-url').value);
    if (composioWorkerURL !== url || !composio) {
      forgetComposioCredentials();
      channel?.postMessage('disconnect-composio');
      composio = createComposioClient(url);
      composioWorkerURL = url;
    }
    $('composio-worker-url').value = url;
    $('kilo-worker-url').value = url;
    if (!await persist()) throw new Error('Browser storage is unavailable. No sign-in request was sent.');
    $('composio-status').textContent = 'Opening official Composio sign-in…';
    await composio.connect();
  } catch (error) { $('composio-status').textContent = error.message; }
  finally { state.composioBusy = false; updateControls(); }
});
$('disconnect-composio').addEventListener('click', async () => {
  if (state.busy || state.composioBusy || !confirm('Forget Composio credentials on this browser? Revoke remote access separately in Composio. Previously returned tool data stays in saved chats.')) return;
  try {
    forgetComposioCredentials();
    $('composio-status').textContent = 'Disconnected locally. Manage or revoke account access in Composio.';
    channel?.postMessage('disconnect-composio');
    await persist(); updateControls();
  } catch (error) { $('composio-status').textContent = error.message; }
});
$('refresh-composio').addEventListener('click', refreshComposio);
$('delete-chat').addEventListener('click', async () => {
  if (!confirm('Delete this saved conversation from this browser? This cannot be undone.')) return;
  state.conversations = state.conversations.filter(chat => chat.id !== state.chatId);
  openConversation();
  await persist();
});
$('clear-data').addEventListener('click', async () => {
  if (!confirm('Clear all Prism chats, settings and saved credentials on this browser? Download your chats first. Remote Notion and Composio access is not revoked.')) return;
  state.clearing = true;
  try {
    await notion.disconnect();
    forgetComposioCredentials();
    await store.clear();
    channel?.postMessage('clear');
    location.reload();
  } catch (error) { state.clearing = false; $('storage-status').textContent = error.message; }
});
channel?.addEventListener('message', event => {
  if (event.data === 'clear' || event.data === 'disconnect' || event.data === 'disconnect-composio') {
    state.clearing = true;
    state.controller?.abort('Cleared in another tab');
    location.reload();
  }
});
$('export-all').addEventListener('click', async () => {
  await persist();
  // No configured API keys or OAuth credentials are included; chats may contain private data.
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, conversations: state.conversations }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'prism-conversations.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const id of ['endpoint', 'api-key', 'system-prompt', 'message-input']) $(id).addEventListener('input', () => { void persist(); });
for (const id of ['model-select', 'parallel-search', 'notion-enabled', 'composio-enabled']) $(id).addEventListener('change', () => { void persist(); });

async function initializeWorkspace() {
  updateControls();
  let legacyCleanupFailed = false;
  let settingsMigration = null;
  // Remove credentials for retired integrations without touching saved chats.
  for (const [kind, keys] of [['localStorage', ['prism.composio.client', 'prism.composio.tokens']], ['sessionStorage', ['prism.composio.pending']]]) {
    try { for (const key of keys) globalThis[kind].removeItem(key); }
    catch { legacyCleanupFailed = true; }
  }
  try {
    const saved = await store.load();
    if (saved?.settings) {
      const retired = ['searchProvider', 'braveKey', 'braveFreshness', 'composio'];
      if (retired.some(key => Object.hasOwn(saved.settings, key))) {
        for (const key of retired) delete saved.settings[key];
        await store.save(saved);
      }
    }
    if (saved?.version === 1 && saved.settings && Array.isArray(saved.conversations)) {
      const settings = saved.settings;
      state.protocol = normalizeProtocol(settings.protocol);
      $('kilo-enabled').checked = settings.kiloEnabled === true;
      updateProtocolUI();
      $('endpoint').value = typeof settings.endpoint === 'string' ? settings.endpoint : defaultEndpoint();
      $('api-key').value = typeof settings.key === 'string' ? settings.key : '';
      $('system-prompt').value = typeof settings.system === 'string' ? settings.system : '';
      // Preserve old On/Off choices; explicit new modes win over the legacy flag.
      state.artefactMode = normalizeArtefactMode(settings.artefactMode, settings.artefacts);
      if (settings.protocol !== state.protocol || settings.artefactMode !== state.artefactMode || Object.hasOwn(settings, 'artefacts')) {
        settingsMigration = { ...saved, settings: { ...settings, protocol: state.protocol, artefactMode: state.artefactMode } };
        delete settingsMigration.settings.artefacts;
      }
      updateArtefactMode();
      $('parallel-search').checked = settings.search === true;
      $('notion-enabled').checked = settings.notion === true;
      $('composio-worker-url').value = typeof settings.composioWorkerURL === 'string' ? settings.composioWorkerURL : '';
      $('kilo-worker-url').value = $('composio-worker-url').value;
      $('composio-enabled').checked = settings.composioEnabled === true;
      invalidateConnection();
      const cacheProtocol = normalizeProtocol(settings.modelsProtocol ?? settings.protocol);
      state.models = (Array.isArray(settings.models) ? settings.models : []).flatMap(model => {
        // Kilo caches are independent of the configured API format and never supply routes.
        if (model?.source === 'kilo') {
          const safe = $('kilo-enabled').checked && configuredKiloEndpoint() ? normalizeKiloModel(model) : null;
          return safe ? [safe] : [];
        }
        if (cacheProtocol !== state.protocol || (model?.source && model.source !== 'api')) return [];
        const name = model?.name;
        const validName = state.protocol === 'openai'
          ? typeof name === 'string' && name.length > 0 && name.length <= 512 && name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name)
          : typeof name === 'string' && /^models\/[a-zA-Z0-9._-]+$/.test(name);
        return validName && (!model.displayName || typeof model.displayName === 'string') ? [{ name, displayName: model.displayName }] : [];
      });
      populateModels(settings.model);
      updateKiloStatus();
      if (state.models.length) status(`${state.models.length} model${state.models.length === 1 ? '' : 's'} available`, 'success');
      state.conversations = saved.conversations.filter(chat => typeof chat?.id === 'string' && typeof chat.title === 'string' && Array.isArray(chat.history) && Array.isArray(chat.transcript) && chat.transcript.every(turn => typeof turn?.role === 'string' && typeof turn.text === 'string') && (!chat.audit || Array.isArray(chat.audit)));
      openConversation(state.conversations.find(chat => chat.id === saved.activeId));
    }
    $('storage-status').textContent = legacyCleanupFailed ? 'Some old credentials could not be cleared. Check browser site-storage permissions.' : 'Saved';
  } catch (error) { $('storage-status').textContent = error.message; }
  state.loaded = true;
  state.busy = false;
  updateSearchSettings();
  updateModel(); resizeInput();
  if (settingsMigration) {
    // Migrate settings only: do not rewrite saved titles, drafts or transcripts.
    try { await store.save(settingsMigration); }
    catch (error) { $('storage-status').textContent = error.message; }
  }
  if ($('composio-worker-url').value.trim()) {
    try {
      composioWorkerURL = normalizeWorkerURL($('composio-worker-url').value);
      composio = createComposioClient(composioWorkerURL);
      $('composio-worker-url').value = composioWorkerURL;
      $('kilo-worker-url').value = composioWorkerURL;
    } catch (error) { $('composio-status').textContent = error.message; $('composio-enabled').checked = false; }
  }
  // Dispatch by the pending authorization's exact state, never by a remote URL.
  const useComposio = composio && (composio.ownsLoginCallback() || (!notion.ownsLoginCallback() && (composio.hasPendingLogin() || !notion.hasPendingLogin())));
  const loginClient = useComposio ? composio : notion;
  const loginName = useComposio ? 'composio' : 'notion';
  let failedLogin = null;
  state.notionBusy = true; state.composioBusy = true; updateControls();
  try {
    const finished = await loginClient.finishLogin();
    const callback = new URL(location.href);
    const authNames = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss'];
    const fragment = new URLSearchParams(callback.hash.slice(1));
    if (!finished && authNames.some(name => callback.searchParams.has(name) || fragment.has(name))) {
      // A changed/missing Worker can make its saved pending state unreadable.
      // Never leave a code in the URL or fall through to another issuer's exchange.
      history.replaceState(null, '', `${callback.origin}${callback.pathname}`);
      throw new Error('No matching login for this page and Worker. Reconnect to start a new authorization.');
    }
    if (finished) { $(`${loginName}-status`).textContent = `${useComposio ? 'Composio' : 'Notion'} login complete.`; setSettingsOpen(true, 'tools'); }
  } catch (error) {
    failedLogin = loginName;
    $(`${loginName}-status`).textContent = error.message;
    $(`${loginName}-enabled`).checked = false;
    setSettingsOpen(true, 'tools');
  } finally { state.notionBusy = false; state.composioBusy = false; updateControls(); }
  for (const [name, client, refresh] of [['notion', notion, refreshNotion], ['composio', composio, refreshComposio]]) {
    if (failedLogin === name) continue;
    const auth = client?.status();
    if (auth?.connected) await refresh();
    else {
      $(`${name}-enabled`).checked = false;
      if (auth?.error) $(`${name}-status`).textContent = auth.error;
    }
  }
  updateControls();
}
await initializeWorkspace();
