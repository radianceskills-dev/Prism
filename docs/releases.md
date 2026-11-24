# Versions and releases

Prism **1.0.0** is the first stable public baseline. Stable means ready for regular use within the documented limits, not bug-free, feature-complete or independently security-certified.

- [Latest release and downloads](https://github.com/radianceskills-dev/Prism/releases/latest)
- [Changelog](../CHANGELOG.md)
- [Hosted app](https://prism-webchat.netlify.app/)
- [Development and contribution guide](../CONTRIBUTING.md)

## Version numbers

Use `MAJOR.MINOR.PATCH` in the root package metadata and a matching `vMAJOR.MINOR.PATCH` Git tag. Keep the root version in `package.json` and both root-package version fields in `package-lock.json` aligned. The package remains `private`; a GitHub release does not publish an npm package.

| Change | Example after 1.0.0 |
| --- | --- |
| Backward-compatible bug/security fix, or maintenance-only release | `1.0.1` |
| Backward-compatible feature or improvement | `1.1.0` |
| Incompatible change to a documented user-facing contract | `2.0.0` |

Compatibility includes saved/imported conversation formats and documented provider/configuration interfaces. An incompatible data format without migration, removal of a documented integration, or configuration changes requiring manual migration should be treated as breaking. An automatic migration that preserves existing data can accompany a compatible release. Do not silently reset users' conversations or credentials.

Visual refinements and new optional features do not automatically require a major version. Third-party services' availability, CORS behavior, APIs, permissions and quotas are outside Prism's control; document those dependencies and any required action honestly. Security fixes can still require a breaking release when preserving compatibility would be unsafe.

The Composio Worker is a separate repository with independent versions. Prism records its exact submodule commit. Releasing Prism does not release, deploy or upgrade anyone's Worker.

## What a release contains

Each release has an immutable annotated Git tag, release notes, and a `Prism-vX.Y.Z-static.zip` asset with a corresponding `.sha256` checksum file. Never move an already published tag or replace a published asset with different bytes; publish a new version instead.

The static ZIP contains exactly the 23 public app assets plus `_headers`, at the archive root. It includes the MIT license and third-party notices. It excludes source tooling, tests, docs imagery, dependencies, Worker code, credentials and local data. Its contents must match a fresh `npm run build` from the release commit.

Serve the extracted files over HTTP(S) or upload them to a static host; do not open `index.html` through `file://`. A host must apply the supplied `_headers` rules or equivalent, especially the separate artefact-frame policy. There is no application backend in the ZIP. Configure a compatible provider and your own key in Settings. Optional integrations need their separate setup.

GitHub's automatic **Source code** archives are different: they contain repository sources but omit the Worker submodule's contents. For full development, use a recursive Git clone of the tag:

```sh
git clone --branch v1.0.0 --recurse-submodules https://github.com/radianceskills-dev/Prism.git
```

## Maintainer checklist

1. Work from a clean, current `main` checkout with the intended Worker submodule pin. Review all changes; do not add unrelated local files.
2. Choose the version and align the root package/lockfile versions. Move completed changes from `Unreleased` into a dated changelog entry. Add highlights, setup requirements, migration steps if any, and known limitations to the release notes.
3. Use Node.js 22.12+ for the complete verification setup. Run:

   ```sh
   npm ci --ignore-scripts
   npm test
   npm --prefix composio-worker test
   npm run build
   ```

   With Edge installed, keep `npm start` running in a separate terminal and run `npm run test:browser`. Tests use synthetic credentials/mocked providers; passing them does not verify real accounts, quotas or billing.
4. Inspect the build's exact allowlist (`BUILD_FILES` in `build.mjs`). Archive only those ordinary files from `dist`, at the ZIP root. Do not archive the repository, `artifacts`, browser profiles or environment files. Reopen the ZIP and verify its filenames and every entry's bytes against the build. Generate the ZIP's SHA-256 checksum (for example with `sha256sum` or PowerShell `Get-FileHash`).
5. Commit and push the reviewed release preparation to `main`. Require the **Verify Prism** CI run to pass for that exact commit. Create and push an annotated `vX.Y.Z` tag at the same commit.
6. Publish the matching GitHub Release with reviewed notes, the static ZIP and checksum. Do not claim future features or undisclosed real-account verification. Do not publish a release if the tag/version/build checks disagree.
7. From that exact tagged, clean checkout, run `npm run build` and deploy only `dist` to the existing production site:

   ```sh
   netlify deploy --site prism-webchat --dir dist --prod --no-build --message "Prism vX.Y.Z"
   ```

   An explicit site prevents accidental deployment to an unrelated linked project. GitHub publication does not itself update Netlify: deployments are manual unless a separate CI integration is intentionally configured. Keep optional Workers separate.
8. Verify the public release's tag, assets and checksum. Verify HTTPS, app/artefact security headers, desktop/mobile layout, a synthetic provider/chat/interactive-preview session, persistence, and exclusion of private/source paths on the actual hosted site. Confirm the site has not injected extra executable scripts. Record the release commit, Netlify deploy ID and immutable deploy URL in the release notes.

The package version alone does not prove which build a host is serving. The Git tag identifies the source baseline; the immutable Netlify deploy URL and release asset checksum identify the published deployment and ZIP. Build identity does not pin third-party CDN responses: the existing floating Tailwind runtime remains a documented external dependency.

## Support

Security fixes target the latest stable release and current `main`; older releases are not maintained as separate support branches. See the [security policy](../SECURITY.md) for private reporting and trust boundaries. Feature work belongs under `Unreleased` until the next release is ready.
