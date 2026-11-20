// Locally vendored upstream ESM distributions: marked 17.0.1 (MIT),
// DOMPurify 3.4.18 (Apache-2.0 OR MPL-2.0). See the adjacent LICENSE-*.txt.
import { Marked } from './vendor-marked.js';
import DOMPurify from './vendor-dompurify.js';

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

// No relative/protocol-relative, credential-bearing, script, data or mail links.
// Reject controls and backslashes rather than letting URL normalization hide them.
function safeLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f-\u009f\\]/.test(value) || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// A private parser instance avoids changing marked defaults elsewhere in the app.
const parser = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // Never put model-supplied HTML into a DOM parser, even a detached one.
    // Raw HTML remains literal; only explicit Markdown images may load HTTPS URLs.
    html({ text }) { return escapeHTML(text); },
    image({ href, title, raw, text }) {
      const url = safeLink(href);
      if (!url || !url.startsWith('https:')) return escapeHTML(raw || text || '[image omitted]');
      const tooltip = title ? ` title="${escapeHTML(title)}"` : '';
      return `<img src="${escapeHTML(url)}" alt="${escapeHTML(text || '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"${tooltip}>`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const url = safeLink(href);
      if (!url) return label;
      const tooltip = title ? ` title="${escapeHTML(title)}"` : '';
      return `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer"${tooltip}>${label}</a>`;
    },
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      const label = /^[\w#+.-]{1,40}$/.test(language) ? `<span class="code-language">${escapeHTML(language)}</span>` : '';
      return `<pre>${label}<code>${escapeHTML(text)}\n</code></pre>\n`;
    },
    checkbox({ checked }) {
      return `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
    },
  },
});

const sanitizerOptions = Object.freeze({
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'span', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'input'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'start', 'align', 'type', 'disabled', 'checked', 'src', 'alt', 'loading', 'decoding', 'referrerpolicy'],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
});

/** Safely replace a message container's children with Markdown. Source stays external. */
export function renderMarkdown(container, text) {
  const source = String(text ?? '');
  const fragment = DOMPurify.sanitize(parser.parse(source), sanitizerOptions);
  // Defense in depth: revalidate links after sanitizing and never trust attributes
  // to maintain the new-tab policy. All non-HTTP(S) links become inert text.
  for (const link of fragment.querySelectorAll('a')) {
    const href = safeLink(link.getAttribute('href'));
    if (!href) link.replaceWith(...link.childNodes);
    else {
      link.setAttribute('href', href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
  for (const image of fragment.querySelectorAll('img')) {
    const src = safeLink(image.getAttribute('src'));
    if (!src || !src.startsWith('https:')) image.replaceWith(container.ownerDocument.createTextNode(image.getAttribute('alt') || '[image omitted]'));
    else {
      image.setAttribute('src', src);
      image.setAttribute('loading', 'lazy');
      image.setAttribute('decoding', 'async');
      image.setAttribute('referrerpolicy', 'no-referrer');
    }
  }
  for (const input of fragment.querySelectorAll('input')) {
    input.type = 'checkbox';
    input.disabled = true;
    input.tabIndex = -1;
  }
  // A local scroll region prevents wide tables from widening mobile messages.
  for (const table of fragment.querySelectorAll('table')) {
    const wrapper = container.ownerDocument.createElement('div');
    wrapper.className = 'markdown-table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Scrollable table');
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  container.classList.add('markdown-content');
  container.replaceChildren(fragment);
}
