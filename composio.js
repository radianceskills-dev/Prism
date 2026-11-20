// Browser-only Composio public OAuth through a user-trusted Worker.
// Merely constructing the client never contacts the Worker or sends credentials.
import { createHostedMCPClient } from './mcp-client.js';

/** Normalize a pasted Worker origin or /mcp endpoint to its origin (no trailing slash).
 * HTTPS custom ports are accepted; HTTP is restricted to explicit loopback hosts.
 * This is syntax validation, not proof of Worker ownership or a DNS/IP firewall.
 */
export function normalizeWorkerURL(value) {
  const invalid = () => { throw new Error('Enter a valid HTTPS Worker origin or /mcp URL (HTTP loopback is allowed for previews).'); };
  if (typeof value !== 'string') return invalid();
  const text = value.trim();
  // Reject escapes before URL parsing can canonicalize dot paths, hosts or separators.
  const shape = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?(?:\/mcp|\/)?$/i.exec(text);
  if (!text || /[\s\\%?#]/.test(text) || !shape) return invalid();
  let url;
  try { url = new URL(text); } catch { return invalid(); }
  if (url.username || url.password || !['', '/', '/mcp'].includes(url.pathname)) return invalid();
  const host = url.hostname.toLowerCase();
  if (shape[1].toLowerCase() !== host) return invalid(); // No alternate/encoded numeric host syntax.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return invalid();
  if (!loopback) {
    // All bare IPv4/IPv6 literals are rejected, not just known private ranges.
    // Reject single-label, special-use and local-resolution hostnames as well.
    if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.') || host.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)) return invalid();
    if (host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) return invalid();
  }
  return url.origin;
}

export function createComposioClient(workerURL, options = {}) {
  const base = normalizeWorkerURL(workerURL);
  return createHostedMCPClient({
    name: 'Composio',
    workerURL: base,
    mcp: `${base}/mcp`,
    register: `${base}/oauth/register`,
    token: `${base}/oauth/token`,
    authorize: 'https://connect.composio.dev/oauth/authorize',
    issuer: 'https://connect.composio.dev',
    // OAuth audience is always Composio, never the user-selected transport origin.
    resource: 'https://connect.composio.dev/mcp',
    scope: 'openid profile email offline_access',
    // Composio does not advertise authorization_response_iss_parameter_supported.
    // When supplied, iss must still be exact and unique; state and saved issuer bind it.
    optionalIssuer: true,
    legacyKeys: ['prism.composio.client', 'prism.composio.tokens', 'prism.composio.pending'],
    otherPendingKeys: ['prism.notion.pending'],
    keys: { client: 'prism.composio.worker.client', tokens: 'prism.composio.worker.tokens', pending: 'prism.composio.worker.pending' },
  }, options);
}
