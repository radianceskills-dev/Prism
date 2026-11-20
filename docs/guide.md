# Prism user and developer guide

[← Back to the project overview](../README.md)

This guide covers configuration, limits, tool permissions, deployment and development. Run shell commands from the repository root.

A static chat workspace with **direct local image/file attachments**, **Gemini and OpenAI-compatible API formats**, **Parallel web search**, **Notion workspace tools** and optional **Kilo Free Models and Composio MCP via one user-owned Cloudflare Worker**. Choose the wire format for your provider in Settings; tool use requires model/provider function-calling support. HTML, CSS and browser ES modules, with Tailwind loaded from jsDelivr. Prism itself needs no application backend; the optional shared Kilo/Composio transport is deployed separately by its user.

## Get the source and run

```sh
git clone --recurse-submodules https://github.com/radianceskills-dev/Prism.git
cd Prism
npm start
```

Node.js 20+ is needed only for preview, build and tests (Node.js 22.12+ for Worker development). No npm dependencies are needed just to run the preview or build the app. For an existing checkout, run `git submodule update --init --recursive` to fetch the separately maintained [shared Worker](https://github.com/radianceskills-dev/prism-composio-worker). Source ZIP downloads from GitHub do not include submodule contents; the static app still runs and builds, but the cross-repository Worker browser test requires a recursive clone.

Open **http://127.0.0.1:3000**. [Start-Prism.cmd](../Start-Prism.cmd) also starts the preview on Windows. The server binds to loopback and serves only allowlisted public assets. To use a different port, set `$env:PORT=3001` before starting.

## Configure

Open **Settings** in the top bar. The sidebar contains New conversation, conversation history and the three-position **Interactive UI** switch.

- **Connection:** the first card groups the **Gemini / OpenAI-compatible** format choices, API endpoint and API key. The optional **Kilo Free Models** card sits directly beneath it. The **Choose Your Model** card has an icon-only **Reload models** button and displays the available-model count beside its heading. Connection failures remain visible in that card. The format is explicit, not guessed from the hostname. Switching formats clears the configured provider’s key and cached models to avoid sending a previous credential with a different protocol; independent Kilo models remain available when enabled. Custom base URLs stay unchanged, while the built-in default URL switches to match the format.
- **Tools:** independent Parallel, Notion and Composio controls. Composio adds a real **Deploy to Cloudflare** link and a user-owned Worker URL; other integrations remain direct browser MCP clients.
- **Instructions:** optional custom system prompt. Interactive UI mode lives in the sidebar, not Settings.
- **Data:** export chats or clear chats/settings/credentials.

API format, endpoint, API key, models, tool preferences, instructions, drafts and conversations persist in the browser. Older saved setups default to Gemini, without rewriting their saved conversations. Restored model lists are format-scoped caches; the reload icon refreshes discovery. Changing settings or restoring a setup never automatically sends model API requests. Enter sends a message; Shift+Enter inserts a newline. Failed/cancelled turns roll back model history and return the prompt to the composer. Tool activity remains visible separately. New conversation preserves previous chats.

### Kilo Free Models

In **Settings → Connection**, enable **Kilo Free Models**, paste your **shared Cloudflare Worker URL**, then click **Reload models**. Use the **same deployment and URL as Composio**; the fields in Connection and Tools stay synchronized. Deploy or update using the existing [Cloudflare template](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fradianceskills-dev%2Fprism-composio-worker)—an older Composio-only Worker returns 404 until updated. No Composio login or Kilo API key is needed for Kilo. The combined list keeps your configured provider’s models and adds qualifying Kilo **free** and **stealth** chat models, labelled **Kilo · …**. The toggle is **off by default**; enabling it saves a preference but makes no network request until you reload models. It also works without a configured Gemini key: configured-provider errors are shown separately while successful Kilo discovery remains usable, and vice versa.

Kilo’s official public API currently returns no browser CORS permission headers (verified with a live anonymous catalog GET and chat OPTIONS, **no inference prompts**), so Prism does **not** call it directly or fall back to a public proxy. Instead, the browser calls your Worker at `GET /kilo/v1/models` and `POST /kilo/v1/chat/completions`. Its fixed upstream is `https://ai-gateway.kilo.ai/api/v1`; chat is OpenAI-compatible with the original remote model ID. Both hops send **no Authorization header, configured API key, OAuth tokens, cookies or referrer**. The API card’s endpoint, format and key are never substituted into Kilo requests. The Worker independently checks the requested model against a fresh free/stealth catalog before inference and forwards only nonstreaming Prism-compatible chat options. There is no fallback to a paid or configured model on failure. Free eligibility uses catalog flags, explicit zero pricing and exact free/stealth markers; explicitly paid, unknown-price or non-chat entries are excluded. Availability, model support and anonymous limits are controlled by Kilo, not Prism. See Kilo’s [anonymous access documentation](https://kilo.ai/docs/gateway/authentication#anonymous-access) and [model catalog documentation](https://kilo.ai/docs/gateway/models-and-providers).

Selections have separate source identities even when model IDs collide. The toggle and combined model cache persist locally; restoring them sends no model requests. Editing your API settings invalidates only that provider’s models. Editing the shared Worker URL from either card invalidates Kilo models and disables Composio tool access until explicitly reconnected/refreshed; it never sends OAuth credentials to a new Worker. Restoring Kilo models requires an enabled toggle and valid shared Worker URL. Turning Kilo off immediately removes its cached models and selects an available configured model instead, without clearing your API key. Reload models to discover Kilo again after re-enabling it. Existing conversations are not deleted; continuing after switching between Kilo and another endpoint/format asks for confirmation before sharing the entire history.

**Privacy and quotas:** keyless does not mean private. Sending with a Kilo model shares conversation text, attachments and enabled tool results with **your Worker**, Kilo and its upstream provider. Trust only a Worker you control. Anonymous Kilo limits are per IP and may be shared by Cloudflare egress/users; your Cloudflare request, bandwidth, CPU and memory limits also apply. The 20 MiB Kilo request cap is a safety ceiling, not a guarantee that every Cloudflare plan or provider supports a request that large; use smaller files if runtime limits are reached. The Worker is public transport, not authenticated or rate-limited by Prism; optional `ALLOWED_ORIGINS` limits cooperating browsers, not arbitrary callers. Configure platform abuse protection and monitor your account. Some free providers log prompts/outputs or use them for training; avoid personal or confidential data. **“Stealth” is a model label, not a privacy guarantee.** Tool, image and PDF support depends on the selected model. Prism preserves its existing attachment limits, Interactive UI guidance, `prism_help`, tool controls and cancellation/rollback behavior.

### Direct images and files

Use the paperclip beside the composer, drop files into the composer, or paste an image/file from the clipboard. Review the local previews, remove unwanted files, and send with or without a text prompt. The picker does not upload anything or require a public URL. Sending includes the current conversation and its attachments in the request to your configured model provider; changing endpoints may share that history with a different provider after confirmation.

Supported formats:

- **JPEG, PNG and WebP images:** native Gemini inline image data or OpenAI Chat Completions image data URLs. SVG and animated GIF are not supported.
- **PDF:** native Gemini inline PDF or OpenAI Chat Completions `file.file_data` with an embedded PDF data URL.
- **UTF-8 text/code:** plain text, Markdown, CSV/TSV, JSON, YAML, HTML, CSS, JavaScript/TypeScript, Python and other common source/configuration formats. Files are decoded as UTF-8 and sent as quoted, untrusted text; code and HTML previews are literal text and never executed. Binary/invalid UTF-8 files, Office documents and archives are rejected with an explanation rather than silently omitted.

Limits: **4 files per message**, **4 MiB per file**, **512 KiB per text/code file**, **8 MiB total per message**, **12 MiB of attachment data across conversation history**, and **20 MiB for the complete serialized request**. These are local safety limits, not a promise of provider acceptance: model context windows and provider upload/vision/PDF limits may be lower. Model discovery cannot reliably advertise file support, so choose a compatible model; unsupported-file/model errors preserve your prompt and files without automatically retrying. Start a new conversation or use smaller files when history reaches the limit. There is no Files API upload, remote attachment fetch, attachment CDN, or attachment server/proxy.

Draft files and sent file payloads persist in browser IndexedDB, **unencrypted**. Pending sends are retained as recoverable drafts, never automatically replayed after reload. Failed/stopped sends restore their files and preserve any newly typed draft text. New conversation keeps prior drafts/files isolated in saved conversations. Selected files are not exposed to interactive artefact frames or automatically forwarded to search/MCP tools; file contents are untrusted input, not permission for external actions. Existing sandbox and tool-security boundaries remain unchanged.

**Export all chats** JSON includes complete attachment payloads (including unsent drafts), so treat downloads as private. The per-conversation Markdown export includes filenames/size metadata only, not the binary or text-file contents. Sent files have download buttons in the conversation. Remove a draft attachment, delete its conversation, or clear browser data to remove its local copy; this does not delete copies already received by the provider or exported elsewhere. Public Catbox upload dialogs inside artefacts remain a separate, explicit user action.

### API formats

| Format | Default base URL | Discovery | Chat | Authentication |
| --- | --- | --- | --- | --- |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `GET /models` with Gemini pagination | `POST /models/{model}:generateContent` | `x-goog-api-key` |
| OpenAI-compatible | `https://api.openai.com/v1` | `GET /models` | `POST /chat/completions` | `Authorization: Bearer …` when a key is provided |

Use a **base URL**, not the full chat route. Custom HTTPS endpoints and HTTP loopback URLs using `localhost` or `127.0.0.1` are supported; for example, a compatible local server can use `http://localhost:1234/v1`. HTTP IPv6 literals such as `http://[::1]:1234/v1` are rejected with instructions to use a supported loopback hostname, because browser CSP source entries do not support IPv6 literals. The policy is not broadened to allow arbitrary plain-HTTP hosts. Gemini requires an API key. In OpenAI mode the key may be blank if the server supports unauthenticated requests (common for local servers); providers requiring authentication will return an API error. The selected server must allow direct browser requests with CORS. Configured API connections have no model-provider proxy. The optional user-owned Worker relays only fixed Composio MCP/OAuth routes and the separately isolated, anonymous Kilo free/stealth routes; it is not an arbitrary provider proxy.

OpenAI mode uses **Chat Completions**, not the Responses API, Assistants API, Azure-specific deployment/API-version routes or provider SDKs. Model IDs are preserved, including namespaced IDs such as `organization/model:variant`. OpenAI-compatible model lists do not reliably advertise chat/tool capabilities: choose a model that supports text chat and, when tools are enabled, function calling. Gemini discovery excludes known non-chat families. Both formats use non-streaming responses, the same safe renderer, Interactive UI guidance, Parallel budget and automatic Notion tool handling. OpenAI reasoning metadata needed for tool continuations is retained in model history but not displayed as the answer.

OpenAI-compatible text replies may omit `message.tool_calls` or set it to `null` or `[]`; Prism treats these as no requested tools. This includes the nullable field emitted by CLIProxyAPI's [Gemini non-streaming response adapter](https://github.com/router-for-me/CLIProxyAPI/blob/db7f177d6b0e51eb237daed718de4d25e7a893f5/internal/translator/gemini/openai/chat-completions/gemini_openai_response.go#L519-L569). A `finish_reason` of `tool_calls` without actual calls is still rejected. Malformed batches, duplicate call IDs and unsupported legacy `function_call` replies are rejected before any tools from that batch run; earlier completed tool actions are not undone. Errors describe the structural problem without echoing private arguments. For network diagnostics, `OPTIONS 204` is only a browser CORS preflight: inspect the **POST** completion response's `choices[0].finish_reason` and `choices[0].message.tool_calls`, not its request Payload. Never share authorization headers or API keys.

Existing conversation text and tool history are converted to the selected wire format without replaying tools. Continuing a chat after changing its endpoint **or API format** asks for confirmation before sending the entire conversation to the selected provider. Cancel and start a New conversation to avoid sharing earlier messages. Switching models within the same endpoint and format does not ask again.

Assistant replies render Markdown, including headings, emphasis, nested lists, blockquotes, tables, task lists and code. User messages remain literal text; copy/export preserves the original source, and restored assistant replies are rendered again. The parser and sanitizer are bundled locally. Outside explicit artefact wrappers, model-supplied HTML is escaped. Explicit Markdown images (including reference and linked images) can load absolute credential-free HTTPS/CDN URLs, are lazily loaded, fit the message width, and send no referrer; unsafe image URLs remain literal text. These images contact the image host directly, so only use hosts and image URLs you trust. Only absolute credential-free HTTP(S) links are clickable, and they open separately with `noopener noreferrer`. Generated markup is sanitized with an explicit allowlist before insertion. Exports omit configured API keys and OAuth credentials, but can include private conversation/tool results; archival JSON also includes retained provider reasoning metadata. Export all chats is archival JSON; there is no import UI.

## Interactive HTML artefacts

Use the physical three-position **Interactive UI** switch at the bottom of the sidebar (open the conversation drawer on mobile):

- **Off:** the model is explicitly told that interactive UI is unavailable and any generated UI will appear as plain, non-running source code. Prism also enforces this locally: artefact wrappers in new and saved replies display as inert HTML code, without creating preview iframes.
- **On** (default): the model receives the complete interactive UI capability definition, including the wrapper format, supported HTML/CSS/JavaScript, images, links and isolation limits.
- **Enforced:** the same definition plus **“Use interactive UI by default at the end of each answer.”** The interactive portion follows any Markdown explanation, while explicit requests for plain text or source code are honored. This is model guidance, not a guarantee that every response contains a preview.

The mode is saved across reloads and conversations. Older On/Off preferences migrate automatically. **View model guidance** in the sidebar shows the exact active built-in instruction; your custom system prompt is retained in every mode. Arrow keys and Home/End operate the accessible switch; animations respect reduced-motion preferences. Switching modes is disabled while a reply is in progress. Switching into Off stops existing previews; switching back starts them again from their original source. On ↔ Enforced changes guidance without restarting running previews. Copy/export, conversation history, drafts and tool activity stay unchanged.

In On or Enforced, ask for an interactive page, chart or mini app. Prism tells the model it can return a self-contained HTML document inside an explicit wrapper, outside code fences (this is a response format, not a separate API function tool):

````html
<artefact title="Counter">
<!doctype html>
<html>
<head><style>body { padding: 24px; font-family: system-ui; }</style></head>
<body>
  <button id="count">0</button>
  <script>
    document.querySelector('#count').onclick = event => {
      event.currentTarget.textContent = Number(event.currentTarget.textContent) + 1;
    };
  </script>
</body>
</html>
</artefact>
````

- Each wrapper renders seamlessly inline, without an outer card, border, title bar or Preview/Source controls. A faint **Download HTML** icon sits just beneath the lower-right edge, outside the generated canvas so it never covers chart data or controls. It becomes clearer on hover/keyboard focus and has a larger touch target on touch devices. Multiple previews and ordinary Markdown can coexist in a reply.
- In On or Enforced mode, previews run automatically, including when reopening saved replies. Downloading preserves the exact original HTML without restarting the running UI. Runtime state inside a preview is not saved; its original source is.
- The iframe grows and shrinks with content, including interactive changes and mobile width changes. **There is no application-imposed height cap.** Prefer content-driven layouts: `100vh`/viewport-dependent root sizing can create resize feedback. Browser rendering and resource limits still apply.
- Fenced/inline code examples, incomplete or nested wrappers, and user messages do not execute. Ordinary HTML outside wrappers remains escaped. Copy/export/model history retain the complete original message; HTML download contains only the wrapper's unchanged document source.
- Inline CSS/JavaScript and embedded data work. **Public HTTPS/CDN images are allowed**, including `<img>`, `srcset` and CSS backgrounds. Use direct image URLs whose hosts permit embedding; authentication, expired URLs, hotlink protection, browser blocking and provider outages can still prevent an image from loading. Image requests go directly from the browser to those hosts, exposing normal network metadata and anything included in the image URL. Plain HTTP images, external scripts/libraries/fonts, fetch requests and frame navigation remain blocked.
- **Clicked external HTTP(S) links open a separate tab/window**, never replacing the chat or preview. This also applies to links without a target, `_self` links, dynamically added links, keyboard activation and middle-clicks. New pages have no `window.opener` or referrer. Use ordinary anchors with absolute web URLs; credential-bearing URLs and non-web schemes stay inert. Local `#fragment` anchors keep their in-preview behavior. Popup blockers/browser preferences determine the final tab/window behavior; scripted clicks and `window.open` from model code do not gain popup permission.

### Isolation and limitations

Generated code runs in a nested **opaque-origin sandbox** (`allow-scripts` only), never in the Prism document and never with `allow-same-origin`. It cannot read Prism's DOM, API keys, OAuth tokens, browser storage or tools. The trusted outer host authenticates resize messages and a private, bootstrap-established link channel, and allows only `about:` child frames; the inner document has an inherited restrictive CSP. Neither sandbox receives popup privileges: trusted user-clicked links are validated and opened by Prism only while browser user activation is present. Artifact CSS stays inside the frame. Camera, microphone, clipboard and other sensitive permissions are denied.

**This is not a complete network firewall or CPU/memory limit for arbitrary JavaScript.** Browser APIs such as WebRTC ICE/STUN can attempt outbound DNS/network traffic despite fetch/resource CSP restrictions. Do not place secrets in generated documents, and treat generated code as executable code. Very large documents or infinite loops can still hurt browser responsiveness. Downloaded HTML opened outside Prism no longer has the preview's sandbox or inherited CSP.

## prism_help: public file-link hints

`prism_help` is an always-available, local, read-only model tool in both API formats, including when Parallel/Notion are off or all 20 searches have been used. It accepts `{}` or `{ "topic": "cdn_links" }`. Calling it does not perform network requests, upload anything, change the Interactive UI setting, consume searches, or access Notion. Model/provider function-calling support is therefore required even when the optional integrations are disabled.

The first hint explains how to ask the user to turn Interactive UI On (or Enforced) and build a JavaScript container for a user-controlled Catbox public file link. It includes the public-sharing warning and a working `<artefact>` example that invokes `window.prism.uploadToCatbox()` **with no arguments, synchronously from a real button click**. This helper exists only inside Prism previews, not in downloaded standalone HTML. It opens a trusted, top-level modal; model code cannot choose a file, supply file bytes/URLs, select a destination, or approve publication.

- The user must choose a file in the trusted dialog, check an initially unchecked public-sharing consent, then explicitly choose **Upload file publicly**. Choosing a file alone never uploads it. Changing the file or pasted URL resets consent. The limit is one file of 200 MB or less. Only anonymous multipart `reqtype=fileupload` and the selected `fileToUpload` go to the fixed [Catbox API](https://catbox.moe/tools.php), without cookies, authorization, userhash, referrer, redirects or a proxy.
- **Public, no selected expiry, potentially indefinite retention:** the [current Catbox FAQ](https://catbox.moe/faq.php) says anonymous files may be removed after two years without access, while account uploads are permanent. Do not upload secrets or private files; Catbox does not strip EXIF/other metadata. Prism cannot delete or undo an anonymous upload. Commercial CDN/hotlinking use requires Catbox's prior approval; this is not a guaranteed permanent or commercial CDN service.
- Browser CORS is not bypassed. A read-only, readable API check must succeed before Prism sends a file. If the check fails, **no upload POST is sent**: use the official website link, upload there yourself, then paste its public file URL into the dialog and explicitly choose **Use link** after consent. Pasted URLs are validated locally and never fetched. Only credential-free `https://files.catbox.moe/` file links are accepted.
- Even after a successful check, any failure, unreadable response or cancellation **after the upload starts** means the file may already be public. Prism never retries it automatically; the warning remains visible until acknowledged. Cancellation stops the local request, not a copy already received by Catbox. Closing/disabling the originating preview revokes its dialog and any result delivery; if an upload had started, its trusted uncertainty warning still requires acknowledgment.
- The helper returns only the validated public URL to the originating interactive UI, not file contents. **That UI's untrusted scripts can read and re-share the URL.** No model message is sent and the link is not automatically stored in chat; the user can paste it into the composer if they want to share it with the model. The opaque sandbox, blocked general fetch, isolated credentials and existing external-link restrictions remain unchanged.

## Parallel: public-web search

Enable **Settings → Tools → Parallel search**. No API key is needed for the anonymous endpoint `https://search.parallel.ai/mcp`. Its availability, freshness, quotas and free-tier policy are provider-controlled.

Each conversation has a maximum of **20 `parallel_search` attempts across all messages**, using 1–3 queries per invocation. There is no separate three-search-per-turn cap. Usage is saved before dispatch and shown in Tools settings; failed, malformed and cancelled attempts still count, even if the model turn is rolled back. Reloading or reopening a saved chat does not reset usage; New conversation starts a fresh budget. Older chats derive usage from recorded search activity/history. Once the limit is reached, chatting, Notion and Composio tools remain available without new public-web searches. Browser storage must be available to save a search reservation. Generated objectives, queries, model name and a random conversation ID are sent to Parallel, never the configured model API key. Queries can contain conversation details. Results return to the selected model provider and may be saved in conversation history. Disabling search prevents new requests, not reuse of existing history.

Search activity appears beside the answer. Source links and citations are generated by the model, not independently verified. Indexed search results are not guaranteed to be live page fetches. Parallel requests have a 40-second deadline.

Reference: [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp.md).

## Notion: workspace tools

1. Open **Settings → Tools → Connect Notion**.
2. Sign into Notion and approve workspace access.
3. Return to Prism. Tools are discovered automatically.
4. Enable **Allow model to use Notion tools automatically**. Refresh tools can repeat discovery.

Notion searches and works with workspace content; it is **not a general public-web search engine**. Parallel remains the web-search integration.

The browser connects directly to `https://mcp.notion.com/mcp` using public-client OAuth registration, Authorization Code + PKCE S256, and refresh tokens. No shared client secret or Notion integration token is embedded. Redirects return to the exact page origin/path; use HTTPS in production or HTTP loopback in development. The callback validates one-time state, verifier, exact issuer and redirect binding, expires after ten minutes, and is removed from the URL before token exchange. The client starts with MCP2025-03-26 and accepts supported2025 protocol revisions.

**When Notion tools are enabled, valid model-requested calls run automatically without per-call approval prompts**, including reads and changes to workspace content. Results are sent to the selected model provider. Disable the Notion checkbox to prevent new model-requested actions, or disconnect the integration. Discovery using `tools/list` happens on connection/refresh without executing a workspace action. Notion has **no per-turn, per-conversation or per-batch call-count limit**. Discovery and the model wrapper have no 64-tool catalog cap; validated tools remain available across the returned catalog. The 20-search conversation budget applies only to Parallel, not Notion workspace searches or actions. Stop and the two-minute model/tool turn deadline still apply, as do provider-side quotas and request timeouts. Failed/interrupted actions are never automatically retried.

Tool descriptions and results are untrusted. Tool names are restricted to discovered names. Arguments, results, pagination, schema size and response size are bounded. No action is automatically retried. Stop/timeout/disconnect cannot undo an action already accepted by Notion; check the workspace before trying again. Pending/running activity restored after interruption becomes unknown and is never replayed.

**Disconnect** removes this browser's Notion client/tokens/pending login. It does not revoke remote access or erase data already saved in conversations. Revoke access in Notion separately. Clear data removes Prism's workspace and credentials and notifies other open tabs.

### Security and validation limits

Notion's [official client guide](https://developers.notion.com/guides/mcp/build-mcp-client.md) recommends server-side token exchange/storage. Prism intentionally uses browser storage to remain static; this departs from that recommendation. Tokens and keys are not encrypted against same-origin scripts, browser extensions or device access. Do not use this as a hardened multi-tenant security boundary.

Live research confirmed CORS headers on successful public registration201, OAuth metadata200, unauthenticated MCP401 and invalid-client token401 responses from Prism's localhost origin. MCP/OAuth preflights also passed. **Real-account authorization-code exchange, refresh and authenticated Notion actions have not been live verified.** End-to-end automated OAuth/action tests use mocks. Successful live login still depends on Notion policies and workspace permissions.

Notion tokens use `prism.notion.*` storage keys. Retired Brave settings and legacy `prism.composio.{client,tokens,pending}` credentials are removed during startup migration without deleting chats. **New Worker-bound Composio credentials are separate and are not removed by that migration.** Removal is local, not remote revocation. Old tool results remain in saved chats; start a new conversation to exclude them from model context. Retired integrations are not automatically replayed.

## Composio: bring your own Cloudflare Worker

1. Open **Settings → Tools → Composio MCP → Deploy to Cloudflare**, or [deploy the public template](https://deploy.workers.cloudflare.com/?url=https://github.com/radianceskills-dev/prism-composio-worker).
2. Sign in to Cloudflare and deploy with the defaults. **No database, KV, Durable Objects, environment variables, API keys or shared client secret are required.** Cloudflare account approval and platform quotas still apply.
3. Paste the deployed Worker URL into **Your Worker URL** and click **Connect Composio**. Use only a Worker you control: it sees relayed OAuth credentials and tool content. Typing or restoring a URL alone never initiates registration or authorization.
4. Complete the official Composio sign-in/consent flow. Prism registers a public OAuth client through the Worker, uses PKCE S256 and validates one-time state, the exact redirect and Worker binding. The callback expires after ten minutes and is removed from the page URL before token exchange. If Composio includes an issuer response parameter it must match exactly; unlike Notion, its advertised public OAuth contract does not require that parameter.
5. Tools are discovered on return. Enable **Allow model to use Composio tools automatically** when you intend to share connected-app access. **Refresh tools** repeats discovery. Composio exposes its consumer discovery/execution/connection tools dynamically; Prism does not replace them with a fixed toolkit catalog.

The real public source is [radianceskills-dev/prism-composio-worker](https://github.com/radianceskills-dev/prism-composio-worker); the local [Worker template and protocol/security documentation](https://github.com/radianceskills-dev/prism-composio-worker#readme) are maintained separately from the static app build. Authentication uses the existing browser MCP architecture through [the shared OAuth/MCP client](../mcp-client.js), also used by Notion. Parallel search and Notion retain their own transports, credentials and tool namespaces. Both model API formats support Composio via the same canonical tool loop.

### Transport and OAuth identity

The Worker is a **fixed-destination transport**, not a new OAuth issuer/resource or an arbitrary URL proxy. MCP GET/POST/DELETE relay only to `https://connect.composio.dev/mcp`; registration and token POSTs relay only to the two fixed official login endpoints. The browser navigates directly to the official authorization page. Resource remains `https://connect.composio.dev/mcp`, issuer remains `https://connect.composio.dev`; metadata/challenges are preserved, not rewritten to pretend the Worker owns those identities. Generic OAuth clients must explicitly separate transport and identity; simply substituting the Worker into all OAuth URLs is not supported.

The Worker answers preflights locally, forwards bearer/consumer authentication and MCP session/protocol headers, exposes authentication challenges/session headers, and passes SSE response bodies through directly without buffering. No retries, cookie forwarding, shared credentials, database or server sessions. Composio POST bodies are limited to 2 MiB (separate Kilo chat routes allow the app’s 20 MiB request limit); redirects, arbitrary paths/query targets and unknown request headers are rejected or omitted. Prism sends requests with credentials omitted. CORS behavior varies by Composio endpoint; this is a consistent optional relay, **not a claim that every upstream response lacks CORS**.

### Permissions, storage and limits

Enabled Composio calls execute automatically without per-call prompts and can read or change connected apps. Tool descriptions/results are untrusted data, never authorization for unrelated actions. Results go to the model provider and can remain in saved chats. Calls have no artificial per-turn, per-batch or conversation count cap; the 20-search budget applies only to Parallel. Stop and the two-minute turn deadline still apply. Failed/interrupted actions are not automatically retried, and cancellation cannot undo an already accepted action. Check the connected app before another attempt.

Saved public-client data/tokens/pending login use `prism.composio.worker.{client,tokens,pending}`, bound to the exact normalized Worker origin. Changing the URL disables model access and never transfers the old credential to the edited URL. Connect establishes trust in the new Worker; binding mismatches require local disconnect before reconnecting. Disconnect and Clear data delete browser credentials, not remote account grants or previously saved tool results. Revoke grants separately in Composio. Tokens and pending authorization values are excluded from conversation exports and tool history; browser storage is **not encrypted** against same-origin scripts, extensions or device access. The Worker URL is a setting, not an exported chat field.

By default the Worker permits browser HTTPS origins and HTTP loopback so deployment needs no manual configuration. Optional exact `ALLOWED_ORIGINS` restricts cooperating browsers. **Origin is not authentication**: non-browser callers can forge or omit it, and a public relay can consume your Cloudflare request/bandwidth allowance. Upstream Composio authenticates each request; the Worker holds no owner credential. Without an additional secret or stateful infrastructure, deployment alone cannot guarantee private use or eliminate quota abuse. Monitor platform quotas/billing; review the template's documented safeguards and limits.

Automated OAuth, refresh, authenticated MCP, SSE and model-tool tests use mocks. Public metadata was inspected; **real-account Composio login, authenticated tool actions and an actual Cloudflare deployment have not been live verified**. The Wrangler dry-run validates packaging, not account-specific permissions or consent/redirect policy. See [Composio's official consumer documentation](https://docs.composio.dev/docs/composio-connect.md) for the upstream contract.

## Build and deploy

```powershell
npm run build
```

Publish **only the contents of the generated `dist/` directory**. The build contains 23 public assets (including the isolated artefact host, locally bundled Markdown libraries, the project license and third-party notices) plus hosting headers; no development dependencies, tests, preview scripts or secrets. Node is not required on the static host.

- Netlify/Cloudflare Pages: build command `npm run build`, output `dist`, or upload directly. No functions/environment variables.
- GitHub Pages: publish `dist` contents. Relative imports work under subpaths such as `/prism/`.
- Other hosts: serve `.js` and `.mjs` as JavaScript. The exact OAuth redirect path must serve the same page with OAuth query parameters.

Use HTTPS except for loopback development. `file://` is unsupported. [_headers](../_headers) provides CSP, no-referrer and related headers for compatible hosts; GitHub Pages needs equivalent hosting configuration where available. The app and artefact host also carry meta CSP fallbacks. **Keep their CSP rules separate:** the app policy must not be merged into the host response (it would block execution or embedding). The wildcard rule contains only common headers; app document rules and the exact artefact-host rule have distinct policies. For subpath deployments, adjust those exact hosting-rule paths to the deployment prefix. Check the deployed response headers if your provider adds a site-wide CSP. No SPA rewrite is needed. Avoid sharing an origin with untrusted apps: storage is origin-wide. The optional preview server does not proxy provider traffic.

The build deliberately refuses unexpected files in its output directory instead of deleting arbitrary content. When upgrading an older manual deployment, remove retired provider assets from that deployment before rebuilding/uploading.

## Tests

```powershell
npm ci --ignore-scripts
npm test
npm --prefix composio-worker test
# In a second terminal, keep `npm start` running for browser tests.
npm run test:browser
```

Browser tests use Playwright with installed Microsoft Edge. Tests cover local picker/drop/paste attachment flows, removal, native image/PDF/text payloads, validation/size limits, file-only turns, cancellation/draft recovery, attachment persistence/exports, opt-in Kilo free/stealth merging, shared-Worker setup and credential isolation, Gemini/OpenAI-compatible discovery, authentication, wire payloads, tool continuations, preserved reasoning metadata, protocol switching and migration, Parallel, Notion OAuth/refresh/issuer checks, Composio Worker URL trust/binding, public registration/PKCE/refresh, canonical OAuth identities, sessions/SSE and mixed-provider dispatch, automatic tool execution and disabling, cancellation, token isolation, storage migration, conversation persistence, safe Markdown rendering, seamless interactive artefact execution and exact icon-only HTML downloads, HTTPS/CDN images in Markdown and artefacts, detached safe external links, uncapped height growth/shrink, sandbox and CSP isolation, saved Interactive UI guidance toggles and request payloads, settings layout and static subpath deployment. Provider responses are mocked; real permissions, billing, model function support and account-specific compatibility require account testing.

## Source

- [index.html](../index.html), [styles.css](../styles.css): interface.
- [app.js](../app.js): UI and workspace migration/persistence.
- [markdown.js](../markdown.js): safe Markdown rendering with locally vendored Marked and DOMPurify; upstream licenses are bundled.
- [artefacts.js](../artefacts.js), [artefact-frame.html](../artefact-frame.html): assistant wrappers, preview controls and nested isolated runtime with auto-height reporting.
- [api.js](../api.js): model requests, artefact capability instructions and cancellable tool loop.
- [kilo.js](../kilo.js): opt-in anonymous Kilo discovery through the shared Worker, free/stealth filtering and allowlisted source identities.
- [mcp-client.js](../mcp-client.js): shared bounded browser OAuth/PKCE and MCP sessions/JSON/SSE implementation.
- [notion.js](../notion.js): fixed direct Notion transport/identity configuration.
- [composio.js](../composio.js): validated, Worker-bound Composio transport with canonical OAuth identity.
- [Shared Worker source and deployment guide](https://github.com/radianceskills-dev/prism-composio-worker): independently deployed stateless relay, pinned as the `composio-worker` Git submodule; excluded from the static app bundle.
- [parallel.mjs](../parallel.mjs): anonymous web-search MCP client.
- [attachments.js](../attachments.js): bounded local file reading, canonical attachment validation, safe preview data and provider-independent message parts.
- [storage.js](../storage.js): IndexedDB persistence.
- [server.mjs](../server.mjs), [build.mjs](../build.mjs): optional local tooling.
- [tests](../tests/): unit and browser tests.

## License and third-party software

Prism's original code is available under the [MIT License](../LICENSE), copyright 2026 Prism contributors. Bundled and external dependencies keep their own licenses; see [third-party notices](../THIRD_PARTY_NOTICES.md). Vendored Marked and DOMPurify license texts are retained in this repository and static exports. The shared Worker is independently MIT-licensed in its own repository.

## Security and privacy

Please read the [security policy](../SECURITY.md) before reporting a vulnerability. Do not post API keys, OAuth tokens, exported conversations or private attachments in public issues. Browser data stays in this browser unless you send it, export it or a third-party script/origin can access it; this is not an encrypted vault or a guarantee of confidentiality. Data sent to model providers, enabled tools, Catbox or a user-owned Worker is subject to those services' policies and quotas.

The app currently trusts Tailwind's browser runtime from jsDelivr (`@tailwindcss/browser@4`, a floating major version without SRI). That external script executes in Prism's origin and can access page data/storage; it is not made private by the local-first architecture. For high-assurance/private deployments, review and self-host/pin that dependency or replace it with prebuilt CSS before entering secrets. This release preserves the existing runtime behavior; it does not claim the CDN is isolated.

The source repository intentionally excludes generated builds, private/local screenshots and test artifacts, logs, browser test outputs, environment files and installed dependencies. Reviewed synthetic documentation imagery in `docs/assets` is an intentional exception. [Contributing](../CONTRIBUTING.md) describes development and safe pull requests.
