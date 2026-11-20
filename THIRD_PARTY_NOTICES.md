# Third-party notices

Prism's original code is MIT-licensed; see [LICENSE](./LICENSE). That license does not replace the licenses of third-party components or grant access to external services.

## Redistributed browser libraries

### Marked 17.0.1

- File: `vendor-marked.js`, unchanged published ES module.
- Project: https://github.com/markedjs/marked
- Exact source artifact: https://cdn.jsdelivr.net/npm/marked@17.0.1/lib/marked.esm.js
- License: MIT; copyright and full permission text retained in [LICENSE-marked.txt](./LICENSE-marked.txt) and the vendor header.
- Artifact SHA-256: `2887a081222c63fea522daee4863d3dae8d7eae70d9f5fa3b84e02fa5b96a892`.

### DOMPurify 3.4.18

- File: `vendor-dompurify.js`, unchanged upstream ES module.
- Project: https://github.com/cure53/DOMPurify
- Exact source artifact: https://raw.githubusercontent.com/cure53/DOMPurify/3.4.18/dist/purify.es.mjs
- Dual license: **Apache-2.0 OR MPL-2.0**, at the recipient's option. Copyright Cure53 and other contributors; original notices remain in the vendor header.
- Full texts: [Apache-2.0](./LICENSE-dompurify.txt) and [MPL-2.0](./LICENSE-dompurify-MPL.txt). The upstream tagged source linked above is available for the unchanged MPL-covered file. No local modifications have been made.
- Artifact SHA-256: `1a06b721ad8b46d6174b21f22ea70290aaf3e5a81d65af3b7178113953f7c9b1`.

### Babel helpers / regenerator-runtime embedded in DOMPurify

The upstream DOMPurify build contains Babel helpers and a regenerator-runtime notice. These embedded components are MIT-licensed. Source/license: https://github.com/babel/babel/blob/v7.29.14/packages/babel-helpers/LICENSE . The following text is retained for those helpers:

```text
MIT License

Copyright (c) 2014-present Sebastian McKenzie and other contributors
Copyright (c) 2014-present, Facebook, Inc. (ONLY ./src/helpers/regenerator* files)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Externally loaded runtime

**Tailwind CSS browser runtime** (`@tailwindcss/browser@4`) is loaded from https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4 . Tailwind CSS is MIT-licensed, copyright Tailwind Labs, Inc.; upstream source and license: https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE . The runtime is fetched from the CDN rather than redistributed in this repository. The URL floats within major version 4 and is not integrity-pinned. It executes with this page's privileges; see the README's security/privacy caveat.

Tailwind's upstream MIT notice:

```text
MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Development-only dependencies

`@playwright/test`, `playwright` and `playwright-core` are Apache-2.0-licensed Microsoft projects: https://github.com/microsoft/playwright . Exact versions, package sources and license identifiers are recorded in `package-lock.json`; npm installs retain package-provided license/notice files. They are not included in the static export. Node.js, Microsoft Edge and GitHub Actions are separately obtained development/CI tools with their own terms.

## Separately maintained Worker and external services

The `composio-worker` submodule points to https://github.com/radianceskills-dev/prism-composio-worker and retains its own MIT license and history. Wrangler and its dependencies belong to that repository's development setup, not Prism's static distribution.

Model providers, Kilo, Parallel, Notion, Composio, Cloudflare, Catbox and jsDelivr are external services, not components relicensed by Prism. Their names identify integrations, not sponsorship or endorsement; their own terms, privacy policies and quotas apply. A Prism license does not grant service accounts, credentials, models, hosted inference or rights to user-provided content.
