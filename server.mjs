import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Local preview serves only the public application. API calls run in the browser.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['/notion.js', ['notion.js', 'text/javascript; charset=utf-8']],
  ['/mcp-client.js', ['mcp-client.js', 'text/javascript; charset=utf-8']],
  ['/composio.js', ['composio.js', 'text/javascript; charset=utf-8']],
  ['/storage.js', ['storage.js', 'text/javascript; charset=utf-8']],
  ['/attachments.js', ['attachments.js', 'text/javascript; charset=utf-8']],
  ['/kilo.js', ['kilo.js', 'text/javascript; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['/artefacts.js', ['artefacts.js', 'text/javascript; charset=utf-8']],
  ['/catbox.js', ['catbox.js', 'text/javascript; charset=utf-8']],
  ['/artefact-frame.html', ['artefact-frame.html', 'text/html; charset=utf-8']],
  ['/vendor-marked.js', ['vendor-marked.js', 'text/javascript; charset=utf-8']],
  ['/vendor-dompurify.js', ['vendor-dompurify.js', 'text/javascript; charset=utf-8']],
  ['/LICENSE-marked.txt', ['LICENSE-marked.txt', 'text/plain; charset=utf-8']],
  ['/LICENSE-dompurify.txt', ['LICENSE-dompurify.txt', 'text/plain; charset=utf-8']],
  ['/LICENSE-dompurify-MPL.txt', ['LICENSE-dompurify-MPL.txt', 'text/plain; charset=utf-8']],
  ['/LICENSE', ['LICENSE', 'text/plain; charset=utf-8']],
  ['/THIRD_PARTY_NOTICES.md', ['THIRD_PARTY_NOTICES.md', 'text/plain; charset=utf-8']],
  ['/parallel.mjs', ['parallel.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

export const APP_CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
export const ARTEFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src about:; child-src about:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const ARTEFACT_PERMISSIONS = 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), fullscreen=()';

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', APP_CSP);
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400); res.end('Bad request'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    if (pathname === '/artefact-frame.html') {
      res.setHeader('Content-Security-Policy', ARTEFACT_CSP);
      res.setHeader('Permissions-Policy', ARTEFACT_PERMISSIONS);
    }
    const asset = assets.get(pathname);
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const data = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(500); res.end('Unable to read application asset'); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exit(1);
  }
  const server = createServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another port and try again.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`\n  Prism is ready at http://127.0.0.1:${port}\n  Press Ctrl+C to stop.\n`));
}
