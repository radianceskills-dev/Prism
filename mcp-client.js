// Browser-only hosted MCP transport. Fixed provider configuration; no discovery or SDK.
export function createHostedMCPClient(config, options = {}) {
  const {
    name: label, mcp: MCP, authorize: AUTHORIZE, token: TOKEN, register: REGISTER,
    issuer: ISSUER, keys: KEYS, scope: SCOPE, resource: RESOURCE = MCP,
    workerURL, optionalIssuer = false, legacyKeys = [], otherPendingKeys = [],
  } = config;
  const PROTOCOL = '2025-03-26';
  const PROTOCOLS = new Set(['2024-11-05', PROTOCOL, '2025-06-18', '2025-11-25']);
  const RESPONSE_LIMIT = 1024 * 1024;
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const validName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
  const credential = value => typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);
  class HostedMCPError extends Error {
    constructor(message, status = 0) { super(message); this.name = `${label}Error`; this.status = status; }
  }
  function error(message, status = 0) { return new HostedMCPError(message, status); }
  function cancelError() { return new DOMException(`${label} request cancelled.`, 'AbortError'); }
  function parse(text) { try { return JSON.parse(text); } catch { throw error(`${label} returned invalid JSON.`); } }
  function cancelBody(response) { void response.body?.cancel().catch(() => {}); }
  function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  function boundedJSON(value, limit = 65536) {
    let nodes = 0;
    const inspect = (item, depth) => {
      if (++nodes > 20000 || depth > 32) throw error(`${label} data exceeds the complexity limit.`);
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (!Array.isArray(item) && !plain(item)) throw error(`${label} data must be JSON serializable.`);
      if (Object.getOwnPropertySymbols(item).length) throw error(`${label} data must be JSON serializable.`);
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!Object.hasOwn(descriptor, 'value')) throw error(`${label} data must be JSON serializable.`);
        inspect(descriptor.value, depth + 1);
      }
    };
    inspect(value, 0);
    let text;
    try { text = JSON.stringify(value); } catch { throw error(`${label} data must be JSON serializable.`); }
    if (new TextEncoder().encode(text).byteLength > limit) throw error(`${label} data exceeds the size limit.`);
    return text;
  }
  async function readResponse(response, signal, rpcId) {
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json' && !(rpcId !== undefined && type === 'text/event-stream')) {
      cancelBody(response); throw error(`${label} returned an unsupported response type.`);
    }
    if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
      cancelBody(response); throw error(`${label} response exceeds the size limit.`);
    }
    if (!response.body) throw error(`${label} returned an empty response.`);
    const rpc = message => {
      if (!plain(message) || message.jsonrpc !== '2.0' || message.id !== rpcId) throw error(`${label} returned an invalid MCP response.`);
      if (Object.hasOwn(message, 'error')) throw error(`${label} reported an MCP error. No operation was retried.`);
      if (!Object.hasOwn(message, 'result')) throw error(`${label} MCP response has no result.`);
      return message.result;
    };
    const event = text => {
      const data = text.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) return null;
      const message = parse(data);
      if (message?.id !== rpcId) return null;
      return { value: rpc(message) };
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, buffer = '';
    try {
      while (true) {
        const { value, done } = await abortable(reader.read(), signal);
        if (value) {
          bytes += value.byteLength;
          if (bytes > RESPONSE_LIMIT) throw error(`${label} response exceeds the size limit.`);
          buffer += decoder.decode(value, { stream: true });
        }
        if (done) buffer += decoder.decode();
        if (type === 'text/event-stream') {
          let separator;
          while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
            const result = event(buffer.slice(0, separator.index));
            buffer = buffer.slice(separator.index + separator[0].length);
            if (result) return result.value;
          }
          if (done && buffer) { const result = event(buffer); if (result) return result.value; }
        }
        if (done) break;
      }
      if (type === 'text/event-stream') throw error(`${label} stream ended without its MCP result.`);
      const value = parse(buffer);
      return rpcId === undefined ? value : rpc(value);
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  const dependency = name => {
    try { return Object.hasOwn(options, name) ? options[name] : globalThis[name]; }
    catch { throw error(`${label} requires available browser ${name}.`); }
  };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw error(`Invalid ${label} request timeout.`);
  const secrets = new Set();
  const controllers = new Set();
  let epoch = 0, sequence = 0, session, protocol = PROTOCOL, initialized = false;
  let refreshFlight, initializeFlight, connecting = false;
  let allowed = new Set();
  const migrated = new Set();
  const storage = (kind, action, key, value) => {
    try {
      const store = dependency(kind);
      if (!store || typeof store[action] !== 'function') throw new Error();
      if (legacyKeys.length && !migrated.has(kind)) {
        for (const legacy of legacyKeys) store.removeItem(legacy);
        migrated.add(kind);
      }
      return store[action](KEYS[key], value);
    } catch { throw error(`${label} requires writable ${kind}. Enable browser site storage and try again.`); }
  };
  const load = (kind, key) => {
    const raw = storage(kind, 'getItem', key);
    if (raw == null) return null;
    let value;
    try { value = JSON.parse(raw); if (!plain(value)) throw new Error(); }
    catch { throw error(`Saved ${label} data is invalid. Disconnect to clear it, then connect again.`); }
    if (workerURL && value.workerURL !== workerURL) throw error(`Saved ${label} worker binding does not match. Disconnect to clear it before connecting another Worker.`);
    if (workerURL) for (const name of ['clientId', 'accessToken', 'refreshToken', 'verifier']) if (credential(value[name])) secrets.add(value[name]);
    return value;
  };
  const save = (kind, key, value) => storage(kind, 'setItem', key, JSON.stringify(workerURL ? { ...value, workerURL } : value));
  const forget = (kind, key) => storage(kind, 'removeItem', key);
  const remember = value => { if (credential(value)) secrets.add(value); };
  const tokens = () => {
    const value = load('localStorage', 'tokens');
    if (value && (!credential(value.accessToken) || (value.refreshToken != null && !credential(value.refreshToken)) || !Number.isFinite(value.expiresAt))) throw error(`Saved ${label} credentials are invalid. Disconnect and reconnect.`);
    if (value) { remember(value.accessToken); remember(value.refreshToken); }
    return value;
  };
  const clearMCP = () => { initialized = false; session = undefined; protocol = PROTOCOL; allowed = new Set(); };
  const callbackURI = () => {
    let url;
    try { url = new URL(dependency('location').href); } catch { throw error(`${label} needs a valid browser page URL.`); }
    if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw error(`${label} login requires HTTPS or HTTP loopback.`);
    return `${url.origin}${url.pathname}`;
  };
  const operate = async (signal, task) => {
    const controller = new AbortController();
    const current = epoch;
    const abort = () => controller.abort(cancelError());
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(error(`${label} request timed out. No operation was retried.`, 504)), timeoutMs);
    const check = () => { controller.signal.throwIfAborted(); if (epoch !== current) throw cancelError(); };
    try { check(); const result = await task(controller.signal, check); check(); return result; }
    catch (failure) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (failure instanceof HostedMCPError) throw failure;
      if (failure?.name === 'AbortError') throw cancelError();
      throw error(`Unable to reach ${label}. Check your connection and browser CORS support. No operation was retried.`);
    } finally { clearTimeout(timer); controllers.delete(controller); signal?.removeEventListener('abort', abort); }
  };
  const request = async (url, init, signal) => {
    // Never trust discovered metadata, redirects, or caller-supplied endpoints.
    if (![MCP, TOKEN, REGISTER].includes(url)) throw error(`Unsupported ${label} endpoint.`);
    signal.throwIfAborted();
    // Validate every saved Worker binding before sending any remote request.
    if (workerURL) { load('localStorage', 'client'); load('localStorage', 'tokens'); load('sessionStorage', 'pending'); }
    let received;
    const pending = Promise.resolve(fetchImpl(url, { ...init, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal })).then(response => {
      received = response;
      if (signal.aborted) cancelBody(response);
      return response;
    });
    try {
      const response = await abortable(pending, signal);
      if (signal.aborted) { cancelBody(response); signal.throwIfAborted(); }
      return response;
    } catch (failure) { if (received) cancelBody(received); throw failure; }
  };
  const oauth = async (url, body, signal) => {
    const response = await request(url, { method: 'POST', headers: { 'Content-Type': url === REGISTER ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: url === REGISTER ? JSON.stringify(body) : new URLSearchParams(body).toString() }, signal);
    if (!response.ok) { cancelBody(response); throw error(`${label} authorization returned HTTP ${response.status}. Reconnect if authorization has expired.`, response.status); }
    return readResponse(response, signal);
  };
  const storeTokens = (result, previous, check) => {
    if (!plain(result) || !credential(result.access_token) || typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 31536000 || (result.refresh_token !== undefined && !credential(result.refresh_token))) throw error(`${label} returned invalid authorization credentials. Reconnect.`);
    const value = { accessToken: result.access_token, refreshToken: result.refresh_token ?? previous?.refreshToken ?? null, expiresAt: Date.now() + result.expires_in * 1000 };
    remember(value.accessToken); remember(value.refreshToken);
    check(); save('localStorage', 'tokens', value);
    return value;
  };
  const accessToken = async signal => {
    const saved = tokens();
    if (!saved) throw error(`Connect ${label} before using its tools.`, 401);
    if (saved.expiresAt > Date.now() + 30000) return saved.accessToken;
    if (!saved.refreshToken) { forget('localStorage', 'tokens'); clearMCP(); throw error(`${label} authorization expired. Connect again.`, 401); }
    if (!refreshFlight) {
      refreshFlight = operate(undefined, async (refreshSignal, check) => {
        const client = load('localStorage', 'client');
        if (!credential(client?.clientId)) throw error(`${label} login registration is missing. Connect again.`, 401);
        if (workerURL && client.redirectUri !== callbackURI()) throw error(`${label} login redirect is invalid. Connect again.`, 401);
        try {
          const result = await oauth(TOKEN, { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: client.clientId, resource: RESOURCE }, refreshSignal);
          return storeTokens(result, saved, check).accessToken;
        } catch (failure) {
          if (failure.status === 400 || failure.status === 401) { check(); forget('localStorage', 'tokens'); clearMCP(); }
          throw failure;
        }
      }).then(value => { refreshFlight = undefined; return value; }, failure => { refreshFlight = undefined; throw failure; });
    }
    return abortable(refreshFlight, signal);
  };
  const post = async (method, params, signal, notification = false) => {
    const token = await accessToken(signal);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = protocol;
    if (session) headers['Mcp-Session-Id'] = session;
    const id = notification ? undefined : ++sequence;
    const response = await request(MCP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) }, signal);
    if (!response.ok) {
      cancelBody(response);
      if (response.status === 401) {
        if (tokens()?.accessToken === token) forget('localStorage', 'tokens');
        clearMCP();
        throw error(`${label} authorization was rejected. Reconnect; the operation was not retried.`, 401);
      }
      throw error(`${label} returned HTTP ${response.status}. No operation was retried.`, response.status);
    }
    if (method === 'initialize') {
      session = response.headers.get('mcp-session-id') || undefined;
      if (session && !/^[\x21-\x7e]{1,512}$/.test(session)) { cancelBody(response); throw error(`${label} returned an invalid MCP session header.`); }
    }
    if (notification) { cancelBody(response); return; }
    return readResponse(response, signal, id);
  };
  const initialize = async signal => {
    if (initialized) return;
    if (!initializeFlight) {
      initializeFlight = (async () => {
        const result = await post('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'prism', version: '1.0.0' } }, signal);
        if (!PROTOCOLS.has(result?.protocolVersion)) throw error(`${label} negotiated an unsupported MCP protocol version.`);
        protocol = result.protocolVersion;
        await post('notifications/initialized', undefined, signal, true);
        signal.throwIfAborted(); initialized = true;
      })().then(() => { initializeFlight = undefined; }, failure => { initializeFlight = undefined; clearMCP(); throw failure; });
    }
    await abortable(initializeFlight, signal);
  };
  const redacted = value => {
    // Remote tool output is untrusted, including errors that might echo a bearer token.
    const scrub = item => {
      if (typeof item === 'string') { for (const secret of secrets) item = item.split(secret).join('[REDACTED]'); return item; }
      if (Array.isArray(item)) return item.map(scrub);
      if (plain(item)) return Object.fromEntries(Object.entries(item).map(([key, val]) => [scrub(key), scrub(val)]));
      return item;
    };
    return scrub(value);
  };
  const hasPendingLogin = () => {
    try { return !!load('sessionStorage', 'pending'); } catch { return false; }
  };
  const ownsLoginCallback = () => {
    try {
      const pending = load('sessionStorage', 'pending');
      const url = new URL(dependency('location').href);
      return !!pending && url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === pending.state;
    } catch { return false; }
  };
  const ownedByOther = url => {
    try {
      if (storage('sessionStorage', 'getItem', 'pending') !== null || url.searchParams.getAll('state').length !== 1) return false;
      return otherPendingKeys.some(key => {
        try {
          const other = JSON.parse(dependency('sessionStorage').getItem(key));
          return typeof other?.state === 'string' && other.state === url.searchParams.get('state');
        } catch { return false; }
      });
    } catch { return false; }
  };
  const disconnect = () => {
    epoch++;
    for (const controller of controllers) controller.abort(cancelError());
    clearMCP();
    let failure;
    for (const [kind, key] of [['sessionStorage', 'pending'], ['localStorage', 'tokens'], ['localStorage', 'client']]) {
      try { forget(kind, key); } catch (cause) { failure ??= cause; }
    }
    if (failure) throw failure;
  };
  return {
    hasPendingLogin, ownsLoginCallback, isLoginCallback: ownsLoginCallback,
    clearSavedCredentials: disconnect,
    status() {
      try { const saved = tokens(); return { connected: !!(saved && (saved.expiresAt > Date.now() || saved.refreshToken)) }; }
      catch (failure) { return { connected: false, error: failure instanceof HostedMCPError ? failure.message : `Unable to read saved ${label} credentials. Check browser site storage.` }; }
    },
    async connect() {
      if (connecting) throw error(`${label} login is already starting.`);
      connecting = true;
      try {
        return await operate(undefined, async (signal, check) => {
          const redirectUri = callbackURI();
          // Reject another Worker's pending authorization before replacing any state.
          if (workerURL) load('sessionStorage', 'pending');
          // Probe write access before creating an external registration or redirecting.
          forget('sessionStorage', 'pending');
          const savedTokens = tokens();
          if (savedTokens) save('localStorage', 'tokens', savedTokens);
          else forget('localStorage', 'tokens');
          let client = load('localStorage', 'client');
          if (!credential(client?.clientId) || client.redirectUri !== redirectUri) {
            const result = await oauth(REGISTER, { client_name: 'Prism', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, signal);
            if (!credential(result?.client_id) || (workerURL ? Object.hasOwn(result, 'client_secret') : result.client_secret) || (result.token_endpoint_auth_method !== undefined && result.token_endpoint_auth_method !== 'none') || (result.redirect_uris !== undefined && (!Array.isArray(result.redirect_uris) || result.redirect_uris.length !== 1 || result.redirect_uris[0] !== redirectUri))) throw error(`${label} returned an invalid public-client registration.`);
            client = { clientId: result.client_id, redirectUri }; check(); save('localStorage', 'client', client);
          }
          const crypto = dependency('crypto');
          const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
          const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
          const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
          check(); save('sessionStorage', 'pending', { state, verifier, redirectUri, clientId: client.clientId, createdAt: Date.now(), ...(workerURL ? { issuer: ISSUER, resource: RESOURCE } : {}) });
          const destination = new URL(AUTHORIZE);
          destination.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE }).toString();
          check(); dependency('location').assign(destination.href);
        });
      } finally { connecting = false; }
    },
    async finishLogin() {
      const url = new URL(dependency('location').href);
      const fragment = new URLSearchParams(url.hash.slice(1));
      const authNames = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss'];
      if (!authNames.some(name => url.searchParams.has(name) || fragment.has(name))) return false;
      if (ownedByOther(url)) return false;
      // Remove sensitive callback values before ANY remote request, even malformed callbacks.
      try { dependency('history').replaceState(null, '', `${url.origin}${url.pathname}`); }
      catch { throw error('Unable to clear the OAuth callback URL. No authorization code was sent.'); }
      let pending;
      try { pending = load('sessionStorage', 'pending'); }
      finally { forget('sessionStorage', 'pending'); } // One-shot, including rejected callbacks and failed token exchange.
      if (!pending || authNames.some(name => fragment.has(name)) || authNames.some(name => url.searchParams.getAll(name).length > 1)) throw error(`Invalid or already handled ${label} login callback. Connect again.`);
      const state = url.searchParams.get('state');
      let match = typeof state === 'string' && typeof pending.state === 'string' && state.length === pending.state.length;
      if (match) { let difference = 0; for (let i = 0; i < state.length; i++) difference |= state.charCodeAt(i) ^ pending.state.charCodeAt(i); match = difference === 0; }
      const client = load('localStorage', 'client');
      if (!match || !/^[A-Za-z0-9_-]{43}$/.test(pending.state) || !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier) || !Number.isFinite(pending.createdAt) || pending.createdAt > Date.now() || Date.now() - pending.createdAt > 600000 || pending.redirectUri !== callbackURI() || client?.redirectUri !== pending.redirectUri || client?.clientId !== pending.clientId || !credential(pending.clientId) || (url.searchParams.has('iss') ? url.searchParams.get('iss') !== ISSUER : !optionalIssuer) || (workerURL && (pending.issuer !== ISSUER || pending.resource !== RESOURCE))) throw error(`${label} login state, redirect, or expiry is invalid. Connect again.`);
      if (url.searchParams.has('error')) throw error(`${label} authorization was declined or failed. Connect again.`);
      const code = url.searchParams.get('code');
      if (!credential(code)) throw error(`${label} login callback has no valid authorization code.`);
      remember(code); remember(pending.verifier);
      await operate(undefined, async (signal, check) => {
        const result = await oauth(TOKEN, { grant_type: 'authorization_code', code, client_id: pending.clientId, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, resource: RESOURCE }, signal);
        storeTokens(result, null, check); clearMCP();
      });
      return true;
    },
    disconnect,
    async listTools({ signal } = {}) {
      allowed = new Set();
      return operate(signal, async (active, check) => {
        await initialize(active);
        const result = [], names = new Set(), cursors = new Set();
        let cursor;
        for (let page = 0; page < 10; page++) {
          const data = await post('tools/list', cursor ? { cursor } : {}, active);
          if (!plain(data) || !Array.isArray(data.tools)) throw error(`${label} returned an invalid tool list.`);
          for (const tool of data.tools) {
            if (!plain(tool) || !validName(tool.name) || names.has(tool.name) || (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 10000)) || !plain(tool.inputSchema) || tool.inputSchema.type !== 'object' || (tool.inputSchema.properties !== undefined && !plain(tool.inputSchema.properties))) throw error(`${label} returned an invalid or duplicate tool definition.`);
            boundedJSON(tool.inputSchema, 32768);
            names.add(tool.name);
            result.push(redacted({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));
          }
          if (data.nextCursor === undefined || data.nextCursor === null) { check(); allowed = names; return result; }
          if (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 4096 || cursors.has(data.nextCursor)) throw error(`${label} returned an invalid or repeated tools cursor.`);
          cursors.add(data.nextCursor); cursor = data.nextCursor;
        }
        throw error(`${label} tool pagination exceeds the 10-page limit.`);
      });
    },
    async callTool(name, args, { signal } = {}) {
      if (!validName(name) || !allowed.has(name)) throw error(`Discover and approve an available ${label} tool before calling it.`);
      if (!plain(args)) throw error(`${label} tool arguments must be a JSON object.`);
      const argumentsCopy = JSON.parse(boundedJSON(args));
      return operate(signal, async (active, check) => {
        await initialize(active);
        const data = await post('tools/call', { name, arguments: argumentsCopy }, active);
        if (!plain(data) || !Array.isArray(data.content) || (data.isError !== undefined && typeof data.isError !== 'boolean') || data.content.some(item => !plain(item) || !['text', 'image', 'audio', 'resource', 'resource_link'].includes(item.type) || (item.type === 'text' && typeof item.text !== 'string'))) throw error(`${label} returned an invalid tool result.`);
        const result = { content: data.content };
        if (data.isError !== undefined) result.isError = data.isError;
        if (data.structuredContent !== undefined) { if (!plain(data.structuredContent)) throw error(`${label} returned invalid structured tool content.`); result.structuredContent = data.structuredContent; }
        boundedJSON(result, 524288); check();
        return redacted(result);
      });
    },
  };
}
