export const CATBOX_API_URL = 'https://catbox.moe/user/api.php';
export const CATBOX_SITE_URL = 'https://catbox.moe/';
export const CATBOX_MAX_FILE_BYTES = 200000000;
const MAX_RESPONSE_BYTES = 2048;
const CANCELLED = 'Catbox sharing cancelled. No file was sent by this dialog.';
const UNCERTAIN = 'The upload may already have published a public file on Catbox. Cancelling locally or closing this dialog cannot remove it. This dialog will not retry the upload.';
const INVALID_URL = 'Use a public file URL such as https://files.catbox.moe/abc123.png, without credentials, a port, query parameters or a fragment.';
let dialogActive = false;

export function validateCatboxURL(value) {
  if (typeof value !== 'string') throw new Error(INVALID_URL);
  const text = value.trim();
  // Check the original spelling too: URL() otherwise normalizes ports and dot paths.
  if (!/^https:\/\/files\.catbox\.moe\/[a-z0-9_-][a-z0-9._-]{0,254}$/i.test(text)) throw new Error(INVALID_URL);
  let url;
  try { url = new URL(text); } catch { throw new Error(INVALID_URL); }
  if (url.protocol !== 'https:' || url.hostname !== 'files.catbox.moe' || url.username || url.password || url.port || url.search || url.hash) throw new Error(INVALID_URL);
  return url.href;
}

async function responseText(response, signal) {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Unconfirmed upload response.');
  }
  if (!response.body?.getReader) throw new Error('Unconfirmed upload response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0, text = '';
  try {
    for (;;) {
      if (signal.aborted) throw new Error('Upload cancelled locally.');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('Unconfirmed upload response.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Called by the trusted app, never by model markup. Opening this dialog cannot upload.
export function requestCatboxUpload({ signal } = {}) {
  if (typeof document === 'undefined' || !document.body) return Promise.reject(new Error('Catbox sharing requires the browser upload dialog.'));
  if (dialogActive) return Promise.reject(new Error('A Catbox sharing dialog is already open. Finish or cancel it first.'));
  if (signal?.aborted) return Promise.reject(new Error(CANCELLED));
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  if (typeof dialog.showModal !== 'function') return Promise.reject(new Error('This browser cannot open the Catbox sharing dialog. Use the official Catbox website instead.'));
  dialogActive = true;

  return new Promise((resolve, reject) => {
    let settled = false, busy = false, postStarted = false, uploadLocked = false, gateFailed = false, revoked = false;
    let controller = null;
    const element = (tag, text) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const space = node => { node.style.margin = '14px 0'; return node; };
    const button = text => {
      const node = element('button', text);
      node.type = 'button';
      Object.assign(node.style, { padding: '9px 13px', border: '1px solid #c8bdd3', borderRadius: '8px', background: '#fff', color: '#33253e', font: 'inherit', cursor: 'pointer' });
      return node;
    };
    const inputStyle = node => Object.assign(node.style, { boxSizing: 'border-box', width: '100%', minWidth: '0', maxWidth: '100%', marginTop: '7px', padding: '9px', border: '1px solid #b9adca', borderRadius: '7px', background: '#fff', color: '#251b2e', font: 'inherit' });
    dialog.id = 'prism-catbox-dialog';
    dialog.dataset.prismCatbox = '';
    dialog.setAttribute('aria-labelledby', 'catbox-title');
    dialog.setAttribute('aria-describedby', 'catbox-warning catbox-sharing');
    Object.assign(dialog.style, { boxSizing: 'border-box', margin: 'auto', width: '560px', maxWidth: 'calc(100vw - 28px)', maxHeight: 'calc(100dvh - 28px)', overflow: 'auto', padding: '22px', border: '1px solid #d3c9df', borderRadius: '14px', background: '#fff', color: '#251b2e', boxShadow: '0 18px 70px #20112e45', font: '14px/1.5 system-ui, sans-serif' });

    const title = element('h2', 'Share a public file with Catbox');
    title.id = 'catbox-title';
    title.tabIndex = -1;
    title.style.margin = '0 0 12px';
    title.style.fontSize = '20px';
    const warning = space(element('p', 'PUBLIC FILES — Do not share secrets or private files. This flow has no expiry selector, and copies may persist indefinitely. Anonymous Catbox files may be deleted after two years of inactivity. File contents and EXIF metadata are not stripped.'));
    const sharing = space(element('p', 'Only the validated public URL, not the file bytes, is returned to the requesting interactive UI. Its scripts can read and re-share that URL. This dialog does not send a model message or save the link in your conversation.'));
    sharing.id = 'catbox-sharing';
    warning.id = 'catbox-warning';
    Object.assign(warning.style, { padding: '12px', border: '1px solid #d7a252', borderRadius: '8px', background: '#fff7e8', color: '#55370d' });

    const official = element('a', 'Open the official Catbox website ↗');
    official.id = 'catbox-official-site';
    official.href = CATBOX_SITE_URL;
    official.target = '_blank';
    official.rel = 'noopener noreferrer';
    official.referrerPolicy = 'no-referrer';
    official.style.color = '#61417f';
    official.style.fontWeight = '600';
    const fallback = space(element('p', 'You can always upload on the official website yourself, then paste its public file URL below. No file is sent merely by choosing one here.'));
    fallback.prepend(official, document.createElement('br'));

    const fileLabel = space(element('label', 'Choose one file (maximum 200 MB)'));
    fileLabel.htmlFor = 'catbox-file';
    fileLabel.style.display = 'block';
    const file = element('input');
    file.id = 'catbox-file';
    file.name = 'file';
    file.type = 'file';
    file.multiple = false;
    inputStyle(file);
    fileLabel.append(file);
    const selected = element('p', 'No file selected.');
    selected.id = 'catbox-selected-file';
    selected.style.overflowWrap = 'anywhere';
    selected.style.margin = '5px 0 12px';

    const manualLabel = space(element('label', 'Or paste an existing public Catbox file URL'));
    manualLabel.htmlFor = 'catbox-url';
    manualLabel.style.display = 'block';
    const manual = element('input');
    manual.id = 'catbox-url';
    manual.name = 'catbox-url';
    manual.type = 'url';
    manual.placeholder = 'https://files.catbox.moe/abc123.png';
    manual.autocomplete = 'off';
    manual.spellcheck = false;
    inputStyle(manual);
    manualLabel.append(manual);

    const consentLabel = space(element('label'));
    Object.assign(consentLabel.style, { display: 'flex', alignItems: 'flex-start', gap: '9px' });
    const consent = element('input');
    consent.id = 'catbox-consent';
    consent.type = 'checkbox';
    consent.checked = false;
    // The app's generic input rule is width:100%; a checkbox must not inherit it.
    Object.assign(consent.style, { boxSizing: 'border-box', width: '16px', minWidth: '16px', maxWidth: '16px', height: '16px', padding: '0', margin: '3px 0 0', flex: '0 0 16px', accentColor: '#684989' });
    const consentText = element('span', 'I understand this shares a public file or link with no chosen expiry, and I agree to return the public URL to the requesting interactive UI. I have permission to share it, and it contains no secrets or private information.');
    Object.assign(consentText.style, { minWidth: '0', flex: '1 1 0', overflowWrap: 'anywhere' });
    consentLabel.append(consent, consentText);

    const status = space(element('p', 'Nothing has been uploaded. Direct browser uploads require a readable Catbox API; otherwise use the official website and paste its link.'));
    status.id = 'catbox-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.overflowWrap = 'anywhere';
    const uncertainty = space(element('p', UNCERTAIN));
    uncertainty.id = 'catbox-uncertainty';
    uncertainty.setAttribute('role', 'alert');
    uncertainty.hidden = true;
    Object.assign(uncertainty.style, { padding: '12px', border: '1px solid #d7a252', borderRadius: '8px', background: '#fff7e8', color: '#55370d' });
    const actions = element('div');
    Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' });
    const cancel = button('Cancel');
    cancel.id = 'catbox-cancel';
    const use = button('Use link');
    use.id = 'catbox-use-link';
    const upload = button('Upload file publicly');
    upload.id = 'catbox-upload';
    Object.assign(upload.style, { background: '#684989', color: '#fff', borderColor: '#684989' });
    actions.append(cancel, use, upload);
    dialog.append(title, warning, sharing, fallback, fileLabel, selected, manualLabel, consentLabel, status, uncertainty, actions);

    const pickedFile = () => {
      const candidate = file.files?.length === 1 ? file.files[0] : null;
      return candidate instanceof File && Number.isSafeInteger(candidate.size) && candidate.size >= 0 && candidate.size <= CATBOX_MAX_FILE_BYTES ? candidate : null;
    };
    const controls = () => {
      file.disabled = busy || uploadLocked || gateFailed || revoked;
      manual.disabled = busy || revoked;
      consent.disabled = busy || revoked;
      upload.disabled = busy || uploadLocked || gateFailed || revoked || !consent.checked || !pickedFile();
      use.disabled = busy || revoked || !consent.checked || !manual.value.trim();
      for (const node of [file, manual, consent, upload, use]) node.style.opacity = node.disabled ? '0.55' : '1';
      dialog.setAttribute('aria-busy', String(busy));
    };
    const finish = (url, error) => {
      if (settled) return;
      settled = true;
      controller?.abort();
      signal?.removeEventListener('abort', externalAbort);
      if (dialog.open) dialog.close();
      dialog.remove();
      dialogActive = false;
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
      if (error) reject(error); else resolve(url);
    };
    const showUncertain = () => {
      uploadLocked = true;
      uncertainty.hidden = false;
      cancel.textContent = 'Close';
    };
    const requestCancel = () => {
      if (settled) return;
      if (busy && postStarted) {
        controller?.abort();
        busy = false;
        showUncertain();
        status.textContent = revoked ? 'The requesting preview was closed or disabled. Close this dialog after reading the warning.' : 'The local upload request was cancelled. Read the publication warning before closing.';
        controls();
        cancel.focus();
        return;
      }
      finish(null, new Error(postStarted ? UNCERTAIN : CANCELLED));
    };
    const externalAbort = () => {
      revoked = true;
      if (postStarted && !settled) {
        controller?.abort();
        busy = false;
        showUncertain();
        status.textContent = 'The requesting preview was closed or disabled. Close this dialog after reading the warning.';
        controls();
        cancel.focus();
      } else requestCancel();
    };

    file.addEventListener('change', () => {
      consent.checked = false;
      const candidate = file.files?.[0];
      selected.textContent = candidate ? `${candidate.name} (${candidate.size.toLocaleString()} bytes)` : 'No file selected.';
      if (candidate && !pickedFile()) status.textContent = 'Choose exactly one file of 200 MB or less. Nothing has been uploaded.';
      else if (!gateFailed && !postStarted) status.textContent = 'File selected locally only. Check the public-sharing consent, then explicitly choose Upload file publicly to send it.';
      controls();
    });
    manual.addEventListener('input', () => { consent.checked = false; controls(); });
    consent.addEventListener('change', controls);
    cancel.addEventListener('click', requestCancel);
    dialog.addEventListener('cancel', event => { event.preventDefault(); requestCancel(); });
    dialog.addEventListener('close', () => { if (!settled) finish(null, new Error(postStarted ? UNCERTAIN : CANCELLED)); });
    use.addEventListener('click', event => {
      if (!event.isTrusted || settled || busy || revoked || !consent.checked) return;
      try { finish(validateCatboxURL(manual.value)); }
      catch { status.textContent = INVALID_URL; manual.focus(); }
    });
    upload.addEventListener('click', async event => {
      if (!event.isTrusted || settled || busy || revoked || uploadLocked || gateFailed || !consent.checked) return;
      const chosen = pickedFile();
      if (!chosen) { status.textContent = 'Choose exactly one file of 200 MB or less. Nothing has been uploaded.'; return; }
      const attempt = new AbortController();
      controller = attempt;
      busy = true;
      status.textContent = 'Checking whether the browser can read the Catbox API. No file has been sent yet.';
      controls();
      try {
        // Read-only gate: never discover a known CORS failure by publishing a file.
        const probe = await fetch(CATBOX_API_URL, { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: attempt.signal });
        const readable = probe.ok && probe.type !== 'opaque' && probe.type !== 'opaqueredirect';
        await probe.body?.cancel().catch(() => {});
        if (!readable) throw new Error('Unreadable API.');
        if (attempt.signal.aborted || settled || revoked) return;
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', chosen);
        postStarted = true;
        uploadLocked = true;
        status.textContent = 'Uploading publicly to Catbox. Cancelling locally cannot remove a copy already received by Catbox.';
        const response = await fetch(CATBOX_API_URL, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', body: form, signal: attempt.signal });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('Unconfirmed upload response.'); }
        const url = validateCatboxURL(await responseText(response, attempt.signal));
        if (!attempt.signal.aborted && !settled && !revoked) finish(url);
      } catch {
        if (settled) return;
        if (postStarted) {
          showUncertain();
          status.textContent = revoked ? 'The requesting preview was closed or disabled. Close this dialog after reading the warning.' : 'The upload response could not be confirmed. Use a known Catbox file link below or close this dialog; do not assume the upload was undone.';
        } else {
          gateFailed = true;
          status.textContent = 'Direct browser uploads are unavailable because the Catbox API could not be read. No file was sent. Open the official Catbox website, upload there, then paste the public file URL below.';
        }
      } finally {
        if (!settled) { busy = false; controller = null; controls(); }
      }
    });

    try {
      controls();
      document.body.append(dialog);
      signal?.addEventListener('abort', externalAbort, { once: true });
      if (signal?.aborted) { externalAbort(); return; }
      dialog.showModal();
      title.focus({ preventScroll: true });
      dialog.scrollTop = 0;
    } catch {
      finish(null, new Error('The Catbox sharing dialog could not be opened. Use the official Catbox website instead.'));
    }
  });
}
