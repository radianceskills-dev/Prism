# Contributing to Prism

Thank you for contributing. By submitting a contribution you represent that you have the right to contribute it and agree to license your original contribution under this project's MIT license. Preserve third-party attribution and do not submit proprietary code or private data.

## Local development

1. Clone recursively: `git clone --recurse-submodules https://github.com/radianceskills-dev/Prism.git`.
2. Use Node.js 22.12+ for the full app/Worker development setup. `npm start` and `npm run build` need no installed npm packages; use `npm ci --ignore-scripts` for tests.
3. Run `npm test`, `npm --prefix composio-worker test`, and `npm run build`.
4. For browser tests, install Microsoft Edge, keep `npm start` running in another terminal, then run `npm run test:browser`. The Playwright configuration uses Edge's `msedge` channel. Tests use synthetic credentials and mocked providers; do not introduce real service credentials into fixtures.
5. The Worker has its own repository. Submit Worker changes there, then propose an intentional submodule-pin update here. Its unit tests use Node's built-in test runner; Wrangler is needed only for Worker packaging/deployment work.

## Pull requests

Explain the behavior change, privacy/security impact and verification. Include focused tests and keep the app's fixed static-export allowlist, provider credential isolation, OAuth state/PKCE checks, artefact sandbox/CSP and explicit opt-in tool controls intact. Update notices when adding, updating or modifying bundled dependencies.

Do not commit `dist`, dependencies, environment files, logs, traces, unreviewed screenshots, browser storage, exports, API keys or OAuth tokens. These are local outputs, not source. The only documentation-image exception is deliberately reviewed, synthetic imagery in `docs/assets` as described below. Review `git diff --cached` and `git status` before committing; `.gitignore` is a guardrail, not a secret scanner. Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md) rather than in a public PR.

The CI workflow checks installation, app/Worker unit tests and the static build. Browser checks require Edge and remain an additional local verification step. Tests do not establish real-account provider permissions, quotas or billing behavior.

## Versions and releases

Prism follows Semantic Versioning, starting with stable **1.0.0**. Record user-visible changes under `Unreleased` in the [changelog](./CHANGELOG.md). Keep compatible feature work in minor releases, fixes in patch releases and incompatible changes in major releases. The [release policy and maintainer checklist](./docs/releases.md) cover version/tag alignment, CI, safe static ZIPs, checksums and deployment of the exact tagged commit. The Worker keeps its own independent release history.

## Documentation visuals

The README uses original project artwork and reviewed synthetic product screenshots in `docs/assets`. To recreate the screenshots after installing test dependencies and Edge, run `node scripts/create-readme-assets.mjs` from the repository root. The helper starts a temporary loopback-only server, uses a fresh nonpersistent browser context, mocks provider/CDN responses and makes no real provider requests. It also checks that the demo's sandboxed checklist responds to interaction. Do not substitute real keys, chats, connected accounts or personal browser profiles. Inspect every image before staging it; private screenshots, traces and exports remain excluded.

Keep the landing page concise and preserve setup, limits, permissions and trust boundaries in the [full guide](./docs/guide.md). Use real CI/license badges, accessible image descriptions and GitHub-compatible Markdown/HTML. README assets and documentation tooling are intentionally not part of the static-app export.
