// Local-only file records. Never interpret filenames or text content as HTML.
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_HISTORY_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'xml', 'log', 'ini', 'cfg', 'conf', 'toml', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'r', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift', 'vue', 'svelte', 'rst', 'tex'];
const TEXT_TYPES = new Set(['application/json', 'application/ld+json', 'application/x-ndjson', 'application/javascript', 'application/x-javascript', 'application/typescript', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/toml', 'application/sql']);
const BLOCKED_EXT = /\.(?:svg|svgz|zip|gz|tar|rar|7z|bz2|xz|docx?|xlsx?|pptx?|odt|ods|odp|rtf|exe|dll|wasm|bin)$/i;
export const ATTACHMENT_ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/*', ...TEXT_TYPES, ...TEXT_EXTENSIONS.map(ext => `.${ext}`)].join(',');
const encoder = new TextEncoder();
const fail = message => { throw new Error(message); };
const unsupported = () => fail('Unsupported attachment. Choose JPEG, PNG, WebP, PDF, or a UTF-8 text/code file. SVG, archives, Office files and other binary formats are not supported.');

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) fail('Attachment filename must be 1–255 characters without control characters.');
  if (BLOCKED_EXT.test(name)) unsupported();
  return name;
}
function classify(name, mime) {
  if (typeof mime !== 'string') unsupported();
  mime = mime.toLowerCase();
  if (IMAGE_TYPES.has(mime)) return { kind: 'image', mimeType: mime };
  if (mime === 'application/pdf') return { kind: 'pdf', mimeType: mime };
  if (mime.startsWith('image/') || /svg/i.test(mime)) unsupported();
  const ext = name.split('.').at(-1).toLowerCase();
  if ((!mime || mime === 'application/octet-stream') && /\.(jpe?g|png|webp|pdf)$/i.test(name)) {
    const mimeType = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' })[ext];
    return { kind: mimeType === 'application/pdf' ? 'pdf' : 'image', mimeType };
  }
  if (mime.startsWith('text/') || TEXT_TYPES.has(mime) || ((!mime || mime === 'application/octet-stream') && TEXT_EXTENSIONS.includes(ext))) return { kind: 'text', mimeType: 'text/plain' };
  unsupported();
}
function checkSize(size, kind) {
  if (!Number.isSafeInteger(size) || size <= 0) fail('Empty attachments are not supported. Choose a non-empty file.');
  if (size > MAX_ATTACHMENT_BYTES) fail('Each attachment must be 4 MiB or smaller. Choose a smaller file.');
  if (kind === 'text' && size > MAX_TEXT_ATTACHMENT_BYTES) fail('Text/code attachments must be 512 KiB or smaller. Choose a smaller file.');
}
function checkSignature(bytes, mime) {
  const starts = values => values.every((value, index) => bytes[index] === value);
  const ascii = (offset, value) => [...value].every((ch, index) => bytes[offset + index] === ch.charCodeAt(0));
  const valid = mime === 'image/jpeg' ? starts([255, 216, 255])
    : mime === 'image/png' ? starts([137, 80, 78, 71, 13, 10, 26, 10])
      : mime === 'image/webp' ? bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')
        : mime === 'application/pdf' && ascii(0, '%PDF-');
  if (!valid) fail('Attachment bytes do not match the declared JPEG, PNG, WebP or PDF type. Re-export the file in a supported format.');
}
function checkText(text) {
  if (typeof text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) fail('Text attachments must contain valid UTF-8 text, without binary NUL or control bytes.');
  // TextEncoder replaces lone surrogates; reject them rather than changing bytes.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail('Text attachment contains invalid Unicode. Save it as UTF-8.'); }
    else if (code >= 0xdc00 && code <= 0xdfff) fail('Text attachment contains invalid Unicode. Save it as UTF-8.');
  }
  return encoder.encode(text).byteLength;
}
function base64Prefix(data, size) {
  // Validate canonical encoding without decoding/copying an entire 4 MiB payload.
  if (typeof data !== 'string' || data.length !== 4 * Math.ceil(size / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('Attachment has invalid canonical base64 data or a mismatched payload size.');
  const padding = size % 3 === 0 ? 0 : 3 - size % 3;
  if ((data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) !== padding) fail('Attachment base64 padding does not match its size.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (padding && (alphabet.indexOf(data[data.length - padding - 1]) & (padding === 2 ? 15 : 3))) fail('Attachment base64 is not canonical.');
  const prefix = atob(data.slice(0, Math.min(data.length, 24)));
  return Uint8Array.from(prefix, char => char.charCodeAt(0));
}
function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('Invalid attachment record.');
  const { id, name, mimeType, size, kind, data, text } = record;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('Invalid attachment ID.');
  checkName(name);
  if (!['image', 'pdf', 'text'].includes(kind)) fail('Unsupported attachment kind.');
  checkSize(size, kind);
  if (kind === 'text') {
    if (mimeType !== 'text/plain' || data !== undefined || typeof text !== 'string' || text.length > MAX_TEXT_ATTACHMENT_BYTES || checkText(text) !== size) fail('Text attachment payload, MIME type or byte size is invalid.');
    return { id, name, mimeType, size, kind, text };
  }
  if (text !== undefined || (kind === 'image' ? !IMAGE_TYPES.has(mimeType) : mimeType !== 'application/pdf')) fail('Unsupported attachment MIME type or payload.');
  checkSignature(base64Prefix(data, size), mimeType);
  return { id, name, mimeType, size, kind, data };
}
export function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) fail('Attachments must be an array.');
  if (attachments.length > MAX_ATTACHMENTS) fail('Attach at most 4 files per message.');
  let total = 0;
  const ids = new Set();
  return attachments.map(attachment => {
    const record = validateRecord(attachment);
    if (ids.has(record.id)) fail('Duplicate attachment IDs in one message.');
    ids.add(record.id);
    total += record.size;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) fail('Attachments in one message must total 8 MiB or less. Choose smaller files.');
    return record;
  });
}
export async function readAttachment(file) {
  if (!file || typeof file.arrayBuffer !== 'function') fail('Choose a local file to attach.');
  const name = checkName(file.name);
  const { kind, mimeType } = classify(name, file.type);
  const size = file.size;
  checkSize(size, kind); // Reject cheap metadata failures before reading bytes.
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== size) fail('Attachment size changed while reading. Choose the file again.');
  const id = globalThis.crypto?.randomUUID?.() || `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  if (kind === 'text') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('Text attachment is not valid UTF-8. Save it as UTF-8 and try again.'); }
    return validateAttachments([{ id, name, mimeType, size, kind, text }])[0];
  }
  checkSignature(bytes, mimeType);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  const data = btoa(chunks.join(''));
  return { id, name, mimeType, size, kind, data };
}
export function attachmentsToParts(attachments) {
  return validateAttachments(attachments).map(prismAttachment => ({ prismAttachment }));
}
export function attachmentDataURL(record) {
  const safe = validateAttachments([record])[0];
  if (safe.kind === 'text') fail('Only validated images and PDFs have attachment data URLs.');
  return `data:${safe.mimeType};base64,${safe.data}`;
}
export function formatAttachmentSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('Invalid attachment byte size.');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${+(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
