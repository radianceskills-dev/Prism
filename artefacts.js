import { renderMarkdown } from './markdown.js';
import { requestCatboxUpload } from './catbox.js';

// Trusted hosts report readiness/height and mediate real user-clicked web links.
// Model HTML is never parsed or executed in the application document.
const frames = new Map();
let observing = false;
function releaseFrame(source, entry) {
  entry.uploadController?.abort();
  frames.delete(source);
}
function observeFrames() {
  if (observing) return;
  observing = true;
  new MutationObserver(() => {
    for (const [source, entry] of frames) if (!entry.frame.isConnected) releaseFrame(source, entry);
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('message', event => {
    const entry = frames.get(event.source);
    const data = event.data;
    if (!entry || !entry.frame.isConnected || !data || data.token !== entry.token) return;
    if (data.type === 'prism-artefact-ready' && !entry.initialized) {
      entry.initialized = true;
      event.source.postMessage({ type: 'prism-artefact-init', token: entry.token, html: entry.html }, '*');
    } else if (data.type === 'prism-artefact-resize' && entry.initialized && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0) {
      // No application-imposed height cap. Source and token validation prevent
      // unrelated windows from manipulating the chat layout.
      entry.frame.style.height = `${Math.ceil(data.height)}px`;
    } else if (data.type === 'prism-artefact-catbox-cancel' && entry.uploadController && data.id === entry.uploadRequestId) {
      entry.uploadController.abort();
    } else if (data.type === 'prism-artefact-catbox-request' && entry.initialized && typeof data.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.id)) {
      const reply = result => {
        if (entry.frame.isConnected && frames.get(event.source) === entry) event.source.postMessage({ type: 'prism-artefact-catbox-result', token: entry.token, id: data.id, ...result }, '*');
      };
      if (!navigator.userActivation?.isActive) { reply({ error: 'Open the upload dialog directly from a real button click.' }); return; }
      if (entry.uploadController) { reply({ error: 'An upload dialog is already open.' }); return; }
      const controller = new AbortController();
      entry.uploadController = controller;
      entry.uploadRequestId = data.id;
      requestCatboxUpload({ signal: controller.signal }).then(url => reply({ url })).catch(error => reply({ error: typeof error?.message === 'string' ? error.message.slice(0, 500) : 'The upload dialog was closed.' })).finally(() => {
        if (entry.uploadController === controller) {
          delete entry.uploadController;
          delete entry.uploadRequestId;
        }
      });
    } else if (data.type === 'prism-artefact-open-link' && entry.initialized && navigator.userActivation?.isActive && typeof data.url === 'string') {
      try {
        const url = new URL(data.url);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
          // Neither sandbox receives popup privileges. Only a real user gesture
          // relayed by the trusted bootstrap can open a detached external tab.
          window.open(url.href, '_blank', 'noopener,noreferrer');
        }
      } catch { /* Invalid or unsafe destinations stay inert. */ }
    }
  });
}

/** Split explicit wrappers, leaving code examples and incomplete wrappers inert. */
export function splitArtefacts(value) {
  const text = String(value ?? '');
  const parts = [];
  let start = 0, position = 0;
  while (position < text.length) {
    const atLineStart = position === 0 || text[position - 1] === '\n';
    if (atLineStart) {
      const lineEnd = text.indexOf('\n', position);
      const end = lineEnd < 0 ? text.length : lineEnd;
      const line = text.slice(position, end).replace(/\r$/, '');
      const fencePattern = /^(?: {0,3}>[ \t]?)* {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/;
      const fence = fencePattern.exec(line);
      if (fence) {
        const marker = fence[1][0], length = fence[1].length;
        position = end < text.length ? end + 1 : end;
        while (position < text.length) {
          const next = text.indexOf('\n', position);
          const boundary = next < 0 ? text.length : next;
          const candidate = text.slice(position, boundary).replace(/\r$/, '');
          position = boundary < text.length ? boundary + 1 : boundary;
          const closingFence = fencePattern.exec(candidate);
          if (closingFence && closingFence[1][0] === marker && closingFence[1].length >= length && !candidate.slice(closingFence[0].length).trim()) break;
        }
        continue;
      }
      if (/^(?: {0,3}>[ \t]?)*(?: {4}|\t)/.test(line)) { position = end < text.length ? end + 1 : end; continue; }
    }
    if (text[position] === '\\') { position += 2; continue; }
    if (text[position] === '`') {
      const run = /^`+/.exec(text.slice(position))[0];
      let closing = position + run.length;
      while ((closing = text.indexOf(run, closing)) >= 0) {
        if (text[closing - 1] !== '`' && text[closing + run.length] !== '`') break;
        closing += run.length;
      }
      position = closing < 0 ? position + run.length : closing + run.length;
      continue;
    }
    if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4);
      position = end < 0 ? text.length : end + 3;
      continue;
    }
    // A wrapper mentioned inside ordinary raw HTML script/style/pre examples
    // must not turn those otherwise inert examples into executable content.
    const raw = /^<(script|style|pre|textarea|xmp)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/i.exec(text.slice(position));
    if (raw) {
      const closing = new RegExp(`</${raw[1]}\\s*>`, 'ig');
      closing.lastIndex = position + raw[0].length;
      const end = closing.exec(text);
      position = end ? closing.lastIndex : text.length;
      continue;
    }
    const opening = /^<artefact\b(?:[^<>"']|"[^"]*"|'[^']*')*>/i.exec(text.slice(position));
    if (!opening || /\/\s*>$/.test(opening[0])) {
      // Ordinary raw tags remain Markdown text. Skip their whole opening tag,
      // including quoted attributes, so embedded examples cannot opt into JS.
      const ordinary = /^<\/?[a-z][\w:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/i.exec(text.slice(position));
      position += ordinary ? ordinary[0].length : 1;
      continue;
    }
    const closing = /<\/artefact\s*>/ig;
    closing.lastIndex = position + opening[0].length;
    const end = closing.exec(text);
    if (!end) break;
    // Nested wrappers are malformed: leave the entire outer block as text,
    // rather than accidentally executing an inner example as a separate card.
    if (/<artefact\b/i.test(text.slice(position + opening[0].length, end.index))) {
      const tags = /<\/?artefact\b(?:[^<>"']|"[^"]*"|'[^']*')*>/ig;
      tags.lastIndex = position;
      let depth = 0, tag;
      while ((tag = tags.exec(text))) {
        depth += /^<\//.test(tag[0]) ? -1 : /\/\s*>$/.test(tag[0]) ? 0 : 1;
        if (depth === 0) break;
      }
      position = tag ? tags.lastIndex : text.length;
      continue;
    }
    const title = /\stitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(opening[0]);
    if (position > start) parts.push({ type: 'markdown', text: text.slice(start, position) });
    parts.push({ type: 'artefact', title: (title?.[1] || title?.[2] || 'HTML artefact').slice(0, 160), html: text.slice(position + opening[0].length, end.index) });
    position = closing.lastIndex;
    start = position;
  }
  if (start < text.length) parts.push({ type: 'markdown', text: text.slice(start) });
  return parts;
}

function createArtefact({ title, html }) {
  // This is only a layout container, not a visible card around the model UI.
  const card = document.createElement('section');
  card.className = 'artefact-card';
  card.setAttribute('aria-label', title);
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'artefact-download';
  download.setAttribute('aria-label', 'Download HTML');
  download.title = 'Download HTML';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4');
  svg.append(path);
  download.append(svg);

  observeFrames();
  const frame = document.createElement('iframe');
  frame.className = 'artefact-frame';
  frame.title = title;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('credentialless', '');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; fullscreen 'none'");
  const token = crypto.randomUUID();
  const url = new URL('./artefact-frame.html', import.meta.url);
  url.hash = token;
  frame.src = url.href;
  frame.style.height = '1px';
  // Keep the icon outside the generated canvas so it never covers chart data
  // or intercepts controls inside the opaque sandbox.
  card.append(frame, download);
  const register = () => {
    if (frame.isConnected && frame.contentWindow && !frames.has(frame.contentWindow)) frames.set(frame.contentWindow, { frame, token, html, initialized: false });
  };
  register();
  frame.addEventListener('load', () => {
    register();
    if (frame.isConnected) frame.contentWindow?.postMessage({ type: 'prism-artefact-ping', token }, '*');
  });
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'artefact'}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return card;
}

/** Assistant-only rich rendering; stored/copy/export text remains untouched. */
export function renderAssistantContent(container, text, { enabled = true } = {}) {
  for (const [source, entry] of frames) if (container.contains(entry.frame)) releaseFrame(source, entry);
  const parts = splitArtefacts(text);
  if (!parts.some(part => part.type === 'artefact')) return renderMarkdown(container, text);
  container.classList.remove('markdown-content');
  container.replaceChildren();
  for (const part of parts) {
    if (part.type === 'artefact') {
      if (enabled) container.append(createArtefact(part));
      else {
        // Never parse generated HTML in Off mode, even if it ignores guidance.
        const block = document.createElement('div');
        block.className = 'message-content artefact-prose markdown-content artefact-source';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-html';
        code.textContent = part.html;
        pre.append(code);
        block.append(pre);
        container.append(block);
      }
    } else if (part.text.trim()) {
      const block = document.createElement('div');
      block.className = 'message-content artefact-prose';
      renderMarkdown(block, part.text);
      container.append(block);
    }
  }
}
