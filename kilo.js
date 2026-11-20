// Optional, anonymous discovery through the user's shared Cloudflare Worker.
// Kilo's upstream does not currently grant direct-browser CORS access.
import { normalizeWorkerURL } from './composio.js';

export function kiloEndpoint(workerURL) {
  let base;
  try { base = normalizeWorkerURL(workerURL); }
  catch { throw new Error('Paste your shared Cloudflare Worker URL in the Kilo card, then reload models. Deploy or update the existing Worker to enable Kilo.'); }
  if (new URL(base).hostname === '[::1]') throw new Error('Use localhost or 127.0.0.1 for the shared Worker preview URL.');
  return `${base}/kilo/v1`;
}

// Fixed upstream used only by the Worker, never a browser fallback.
export const KILO_ENDPOINT = 'https://ai-gateway.kilo.ai/api/v1';
const PREFIX = 'kilo:';
const LABEL = 'Kilo · ';
const MAX_PAGES = 20;
const MAX_ROWS = 20000;
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
const validId = value => text(value, 512) && /^[a-z\d][a-z\d._:/-]*$/i.test(value) && !value.includes('//') && !value.startsWith(PREFIX) && !value.split('/').some(part => !part || part === '.' || part === '..');
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

/** Return an inert, allowlisted cached model. Never restore routing or credentials. */
export function normalizeKiloModel(value) {
  if (!record(value) || value.source !== 'kilo' || typeof value.name !== 'string' || !value.name.startsWith(PREFIX) || !validId(value.name.slice(PREFIX.length))) return null;
  if (!text(value.displayName, 1024) || !value.displayName.startsWith(LABEL) || !text(value.displayName.slice(LABEL.length), 1024 - LABEL.length)) return null;
  const model = { name: value.name, displayName: value.displayName, source: 'kilo' };
  for (const key of ['contextWindow', 'outputTokenLimit']) if (positiveInteger(value[key])) model[key] = value[key];
  if (text(value.description, 2000)) model.description = value.description;
  for (const key of ['isFree', 'isStealth', 'mayTrainOnYourPrompts', 'supportsTools']) if (typeof value[key] === 'boolean') model[key] = value[key];
  return model;
}

/** Recognize only already-normalized records, not lookalike provider IDs. */
export function isKiloModel(model) {
  const normalized = normalizeKiloModel(model);
  return normalized !== null && Object.keys(model).length === Object.keys(normalized).length && Object.keys(model).every(key => own(normalized, key) && model[key] === normalized[key]);
}

export function kiloModelId(model) {
  if (!isKiloModel(model)) throw new Error('Select a valid canonical Kilo model.');
  return model.name.slice(PREFIX.length);
}

// Do not coerce null, booleans, empty strings, negatives, unknown sentinels or
// underflowing decimals ("1e-999") into a zero price.
function zeroRate(value) {
  return typeof value === 'number' ? Number.isFinite(value) && value === 0 && !Object.is(value, -0)
    : typeof value === 'string' && /^0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(value);
}
function billing(row) {
  if (own(row, 'isFree') && typeof row.isFree !== 'boolean') return { blocked: true };
  if (row.isFree === false) return { blocked: true };
  if (!own(row, 'pricing')) return { zero: false };
  if (!record(row.pricing)) return { blocked: true };
  // discount is a percentage, not a billable rate. Other advertised prices
  // must all be explicitly zero, including request/image/cache charges.
  const rates = Object.entries(row.pricing).filter(([key]) => key !== 'discount');
  if (rates.some(([, value]) => !zeroRate(value))) return { blocked: true };
  return { zero: own(row.pricing, 'prompt') && own(row.pricing, 'completion') && zeroRate(row.pricing.prompt) && zeroRate(row.pricing.completion) };
}
function chatCapable(row) {
  const chatTypes = ['chat', 'chat.completion', 'chat-completion', 'chat_completion', 'chat-completions', 'text', 'text-generation', 'text_generation', 'conversational', 'completion', 'completions', 'language', 'language-model', 'llm'];
  for (const key of ['type', 'task', 'pipeline_tag']) {
    if (own(row, key) && (typeof row[key] !== 'string' || !chatTypes.includes(row[key].toLowerCase()))) return false;
  }
  const architecture = row.architecture;
  for (const modalities of [architecture?.output_modalities, row.output_modalities]) {
    if (modalities !== undefined && (!Array.isArray(modalities) || !modalities.includes('text'))) return false;
  }
  if (typeof architecture?.modality === 'string' && architecture.modality.includes('->') && !architecture.modality.split('->').at(-1).split('+').includes('text')) return false;
  return true;
}
function catalogModel(row) {
  if (!record(row) || !validId(row.id) || !chatCapable(row)) return null;
  const price = billing(row);
  if (price.blocked) return null;
  const remoteName = text(row.name, 512) ? row.name : row.id;
  const stealth = /(?:^|[^a-z\d])stealth(?:$|[^a-z\d])/i.test(`${row.id} ${remoteName}`);
  const free = row.isFree === true || price.zero === true || /(?:^|[.:_-])free(?:$|[.:_-])/i.test(row.id.split('/').at(-1));
  if (!free && !stealth) return null;
  const contextWindow = [row.context_window, row.context_length, row.contextWindow, row.max_model_len, row.top_provider?.context_length].find(positiveInteger);
  const outputTokenLimit = [row.max_completion_tokens, row.top_provider?.max_completion_tokens].find(positiveInteger);
  return normalizeKiloModel({ name: PREFIX + row.id, displayName: LABEL + remoteName, source: 'kilo', contextWindow, outputTokenLimit,
    description: row.description, isFree: free, isStealth: stealth, mayTrainOnYourPrompts: row.mayTrainOnYourPrompts,
    supportsTools: Array.isArray(row.supported_parameters) ? row.supported_parameters.includes('tools') : undefined });
}

function cancelled(signal, error) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    const failure = new Error('Kilo model discovery was cancelled.');
    failure.name = 'AbortError';
    throw failure;
  }
}
function paginationError() { return new Error('Kilo returned invalid or excessive model pagination.'); }

/** A trusted Worker URL is required. No keys, cookies or authorization accepted. */
export async function fetchKiloModels({ workerURL, signal, fetchImpl = fetch } = {}) {
  const endpoint = kiloEndpoint(workerURL);
  const models = new Map(), seen = new Set();
  let cursor, count = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    cancelled(signal);
    const url = new URL(`${endpoint}/models`);
    if (cursor) url.searchParams.set('after', cursor);
    let response;
    try {
      response = await fetchImpl(url.href, { method: 'GET', headers: { Accept: 'application/json' }, signal,
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrer: '', referrerPolicy: 'no-referrer' });
    } catch (error) {
      cancelled(signal, error);
      throw new Error('Could not reach Kilo through your shared Worker. Check its URL, deployment and allowed origins. Redirects are not followed.');
    }
    cancelled(signal);
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : 'unknown';
      throw new Error(`Kilo model discovery failed (HTTP ${status}).${status === 429 ? ' Anonymous access has shared per-IP limits; try again later.' : status === 404 ? ' Update your existing Cloudflare Worker deployment to enable Kilo routes.' : ' Check your Worker deployment and try again later.'}`);
    }
    let data;
    try { data = await response.json(); }
    catch (error) {
      cancelled(signal, error);
      throw new Error('Kilo model discovery returned a non-JSON response.');
    }
    cancelled(signal);
    if (!record(data) || !Array.isArray(data.data) || data.error) throw new Error('Kilo model discovery returned an unexpected model-list schema.');
    count += data.data.length;
    if (count > MAX_ROWS) throw new Error('Kilo model discovery exceeded the catalog size limit.');
    for (const row of data.data) {
      const model = catalogModel(row);
      if (model && !models.has(model.name)) models.set(model.name, model);
    }
    // Only OpenAI-style bounded cursors are supported. Never follow server URLs.
    if ([data.next, data.next_url, data.nextPageToken, data.next_cursor, data.links?.next, data.pagination?.next].some(value => value !== undefined && value !== null && value !== '')) throw paginationError();
    if (data.has_more === undefined || data.has_more === false) return [...models.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name));
    const next = own(data, 'last_id') ? data.last_id : data.data.at(-1)?.id;
    if (data.has_more !== true || !validId(next) || seen.has(next) || data.data.length === 0) throw paginationError();
    seen.add(next);
    cursor = next;
  }
  throw paginationError();
}
