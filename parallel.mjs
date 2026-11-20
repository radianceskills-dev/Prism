// Anonymous, fixed-endpoint Streamable HTTP MCP client. No credentials or arbitrary tools.
const ENDPOINT = 'https://search.parallel.ai/mcp';
const PROTOCOL = '2025-03-26';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', PROTOCOL, '2025-06-18']);
const RESPONSE_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 256 * 1024;

export class ParallelError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ParallelError';
    this.status = status;
  }
}

export function validateSearchInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ParallelError('Search input must be a JSON object.', 400);
  }
  const allowed = new Set(['objective', 'search_queries', 'session_id', 'model_name']);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new ParallelError('Only objective, search_queries, session_id and model_name are accepted.', 400);
  }
  if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 10000) {
    throw new ParallelError('objective must be a nonempty string of at most 10000 characters.', 400);
  }
  if (!Array.isArray(input.search_queries) || !input.search_queries.length || input.search_queries.length > 10 ||
      input.search_queries.some(query => typeof query !== 'string' || !query.trim() || query.length > 1000)) {
    throw new ParallelError('search_queries must contain 1–10 nonempty strings of at most 1000 characters each.', 400);
  }
  const result = { objective: input.objective, search_queries: [...input.search_queries] };
  for (const key of ['session_id', 'model_name']) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== 'string' || input[key].length > 100) {
        throw new ParallelError(`${key} must be a string of at most 100 characters.`, 400);
      }
      result[key] = input[key];
    }
  }
  return result;
}

// Race even test/custom fetch implementations and stalled readers against cancellation.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    // Always observe the pending operation, even if cancellation won just before this call.
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function parseJSON(text) {
  try { return JSON.parse(text); }
  catch { throw new ParallelError('Parallel returned malformed JSON.'); }
}

function rpcResult(message, id) {
  if (!message || message.jsonrpc !== '2.0' || message.id !== id) {
    throw new ParallelError('Parallel returned an invalid MCP response.');
  }
  if (message.error) {
    const detail = typeof message.error.message === 'string' ? message.error.message.slice(0, 1000) : 'Unknown protocol error';
    throw new ParallelError(`Parallel MCP error: ${detail}`);
  }
  if (!Object.hasOwn(message, 'result')) throw new ParallelError('Parallel MCP response has no result.');
  return message.result;
}

async function readRPC(response, id, signal) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['application/json', 'text/event-stream'].includes(type)) {
    void response.body?.cancel().catch(() => {});
    throw new ParallelError('Parallel returned an unsupported response type.');
  }
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
    void response.body?.cancel().catch(() => {});
    throw new ParallelError('Parallel response exceeds the size limit.');
  }
  if (!response.body) throw new ParallelError('Parallel returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = '';
  const eventResult = event => {
    const data = event.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return undefined; // SSE keepalive/comments are not RPC messages.
    const message = parseJSON(data);
    if (message?.id !== id) return undefined; // Ignore notifications/unrelated responses.
    return { value: rpcResult(message, id) };
  };
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (value) {
        bytes += value.byteLength;
        if (bytes > RESPONSE_LIMIT) throw new ParallelError('Parallel response exceeds the size limit.');
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      if (type === 'text/event-stream') {
        let separator;
        while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const result = eventResult(event);
          if (result) return result.value;
        }
        if (done && buffer) {
          const result = eventResult(buffer);
          if (result) return result.value;
        }
      }
      if (done) break;
    }
    if (type === 'application/json') return rpcResult(parseJSON(buffer), id);
    throw new ParallelError('Parallel stream ended without the requested MCP result.');
  } finally {
    // Do not wait for the remote peer to finish an SSE connection after its result.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function parallelSearch(input, { signal, fetchImpl = globalThis.fetch, timeoutMs = 40000 } = {}) {
  const args = validateSearchInput(input);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new ParallelError('Parallel search timed out. Please try again.', 504)), timeoutMs);
  let session;
  let protocol = PROTOCOL;
  const post = async (body, notification = false) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (body.method !== 'initialize') headers['MCP-Protocol-Version'] = protocol;
    if (session) headers['Mcp-Session-Id'] = session;
    controller.signal.throwIfAborted();
    const response = await abortable(fetchImpl(ENDPOINT, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
    }), controller.signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const hint = response.status === 429 ? ' Anonymous search is rate limited; try again later.' : '';
      throw new ParallelError(`Parallel search returned HTTP ${response.status}.${hint}`, response.status === 429 ? 429 : 502);
    }
    if (body.method === 'initialize') {
      session = response.headers.get('mcp-session-id');
      if (session && !/^[\x21-\x7E]{1,512}$/.test(session)) {
        void response.body?.cancel().catch(() => {});
        throw new ParallelError('Parallel returned an invalid MCP session header.');
      }
    }
    if (notification) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    return readRPC(response, body.id, controller.signal);
  };
  try {
    const initialized = await post({ id: 1, method: 'initialize', params: {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'prism-keyless-search', version: '1.0.0' },
    } });
    if (!SUPPORTED_PROTOCOLS.has(initialized?.protocolVersion)) throw new ParallelError('Parallel negotiated an unsupported MCP protocol version.');
    protocol = initialized.protocolVersion;
    await post({ method: 'notifications/initialized' }, true);
    const result = await post({ id: 2, method: 'tools/call', params: { name: 'web_search', arguments: args } });
    if (!result || !Array.isArray(result.content)) throw new ParallelError('Parallel returned an invalid search result.');
    const text = result.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n\n');
    if (result.isError) throw new ParallelError(`Parallel search failed: ${text.slice(0, 1000) || 'The search tool reported an error.'}`);
    if (!text) throw new ParallelError('Parallel returned no search text.');
    if (new TextEncoder().encode(text).byteLength > TEXT_LIMIT) throw new ParallelError('Parallel search text exceeds the size limit.');
    // Excerpts remain untrusted raw text: never interpret, execute or render as HTML.
    return { text };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof ParallelError) throw error;
    throw new ParallelError('Unable to reach Parallel search directly from this browser. Check your connection. Parallel must allow CORS for this site; browser extensions may also block requests.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
