# Changelog

Notable changes to Prism are recorded here. Prism uses [Semantic Versioning](https://semver.org/); tags and release assets are published on [GitHub Releases](https://github.com/radianceskills-dev/Prism/releases). See the [release policy](./docs/releases.md) for compatibility and deployment details.

## [Unreleased]

No changes recorded yet.

## [1.0.0] - 2026-11-24

Prism's first stable public release. This establishes the existing, usable application as the 1.0.0 baseline; it is not a preview release or a rewrite.

### Included

- A static, browser-based AI workspace with saved conversations, drafts, settings, and conversation import/export.
- Gemini and OpenAI-compatible Chat Completions connections, including compatible local endpoints that allow browser CORS.
- Direct image, PDF and UTF-8 text/code attachments for compatible providers and models.
- Markdown rendering and interactive HTML artefacts with a separate sandbox, content security policy and permissions restrictions.
- Optional Parallel web search and direct Notion MCP tools; optional Kilo/Composio integration through a separately deployed, user-owned Cloudflare Worker.
- A fixed-allowlist static build, hosting headers, MIT license, preserved third-party notices, documentation and automated app/Worker/browser tests.
- A hosted app at [prism-webchat.netlify.app](https://prism-webchat.netlify.app/).

### Important boundaries

- Bring your own provider configuration and credentials. No service credentials or optional Worker deployment are included in the static distribution.
- Browser storage is not encrypted. Providers and enabled integrations receive relevant content; enabled Notion/Composio tools can change connected apps without per-call approval.
- The app loads the floating Tailwind browser runtime from jsDelivr with page privileges. The sandbox reduces risk but is not an absolute confidentiality boundary.
- Automated provider/OAuth/tool tests use mocks. Real-account provider support, OAuth policies, permissions, quotas and billing remain service-dependent; in particular, real-account Notion authorization, refresh and authenticated actions have not been live verified.

Read the [privacy and trust guidance](./README.md#privacy--trust), [full guide](./docs/guide.md) and [security policy](./SECURITY.md) before connecting sensitive accounts or data.

[Unreleased]: https://github.com/radianceskills-dev/Prism/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/radianceskills-dev/Prism/releases/tag/v1.0.0
