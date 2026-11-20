# Security policy

## Report privately

Please report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/radianceskills-dev/Prism/security/advisories/new). Do not publish an exploit that exposes another user's data or put API keys, OAuth tokens, browser storage, conversation exports or private files in an issue/PR. If private reporting is temporarily unavailable, open a non-sensitive issue asking for a private contact without disclosing the vulnerability.

Include the affected commit/version, browser/OS, minimal reproduction using synthetic credentials/data, impact and a proposed mitigation if available. There is no guaranteed response time or paid bug bounty.

## Scope and trust boundaries

The current default branch is the supported development version. Prism runs in the browser; it is not an encrypted credential vault. IndexedDB/browser storage and same-origin scripts can access locally stored data. Do not deploy it on an origin shared with untrusted applications.

The Tailwind browser runtime currently loads as a floating major version from jsDelivr without SRI and has the app's page privileges. Review this supply-chain trust before entering sensitive data; high-assurance deployments should pin/self-host reviewed code or precompile CSS. See the README for external network dependencies and the current privacy caveats.

Providers and enabled tool integrations can receive prompts, attachments and tool results; automatic tools can change connected apps without per-call approval. Use only a Worker you control. Origin-based CORS is not server-side authentication or abuse protection. Model-generated artefacts are untrusted; retain their sandbox, distinct CSP and permissions restrictions.

The independently maintained [shared Worker](https://github.com/radianceskills-dev/prism-composio-worker) has a separate repository and license. Please identify which component is affected when reporting an issue. Do not test against other people's Workers/accounts or send live private data to reproduce a bug.
