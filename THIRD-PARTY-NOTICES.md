# Third-party notices

Homunculus Core is distributed under the MIT License (see [LICENSE](LICENSE)).
It builds on the third-party components listed below, each under its own terms.

This file exists because the MIT, ISC and BSD licenses require their copyright
notices to be preserved in redistributions — and the browser bundle produced by
`npm run build:web`, along with any desktop artifact from `npm run dist`, embeds
several of these packages directly.

---

## Not open source: the Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` is **proprietary software owned by Anthropic
PBC**, not covered by this project's MIT license:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
> outlined here: https://code.claude.com/docs/en/legal-and-compliance

It powers the Computer Core and every agent session. Installing it from npm and
using it requires accepting Anthropic's terms, and running it requires your own
Claude Pro/Max subscription token (`CLAUDE_CODE_OAUTH_TOKEN`).

Publishing this project's **source** does not redistribute the SDK — it is
fetched from npm by whoever installs it. Distributing a **built desktop
artifact** is a different matter: `electron-builder` bundles `node_modules` into
the package, which would embed the SDK. Check Anthropic's terms before attaching
built installers to a release.

---

## Runtime dependencies

| Package | License | Copyright |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | Proprietary — see above | © Anthropic PBC |
| `@homebridge/node-pty-prebuilt-multiarch` | MIT | Copyright (c) 2012-2015, Christopher Jeffrey |
| `@tabler/icons-webfont` | MIT | Copyright (c) 2020-2026 Paweł Kuna |
| `dotenv` | BSD-2-Clause | Copyright (c) 2015, Scott Motte |
| `globe.gl` | MIT | Copyright (c) 2019 Vasco Asturiano |
| `postgres` | Unlicense | Public domain |
| `systeminformation` | MIT | Copyright (c) 2014-2026 Sebastian Hildebrandt |
| `three` | MIT | Copyright © 2010-2026 three.js authors |
| `topojson-client` | ISC | Copyright 2012-2019 Michael Bostock |
| `tsx` | MIT | Copyright (c) Hiroki Osame |
| `world-atlas` | ISC | Copyright 2013-2019 Michael Bostock |
| `ws` | MIT | Copyright (c) 2011 Einar Otto Stangvik |

## Development and build dependencies

| Package | License | Copyright |
| --- | --- | --- |
| `@electron/rebuild` | MIT | Copyright (c) Contributors to the Electron project |
| `@testing-library/dom` | MIT | Copyright (c) 2017 Kent C. Dodds |
| `@testing-library/jest-dom` | MIT | Copyright (c) 2017 Kent C. Dodds |
| `@testing-library/react` | MIT | Copyright (c) 2017-Present Kent C. Dodds |
| `@types/*` | MIT | Copyright (c) Microsoft Corporation |
| `@vitejs/plugin-react` | MIT | Copyright (c) 2019-present, Yuxi (Evan) You and Vite contributors |
| `@vitest/coverage-v8` | MIT | Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors |
| `@xterm/xterm`, `@xterm/addon-fit` | MIT | Copyright (c) 2017-2019, The xterm.js authors |
| `concurrently` | MIT | Copyright (c) 2015 Kimmo Brunfeldt |
| `electron` | MIT | Copyright (c) Electron contributors |
| `electron-builder` | MIT | Copyright (c) 2015 Loopline Systems |
| `electron-vite` | MIT | Copyright (c) 2022, Alex Wei |
| `jsdom` | MIT | Copyright (c) 2010 Elijah Insua |
| `react`, `react-dom` | MIT | Copyright (c) Facebook, Inc. and its affiliates |
| `typescript` | Apache-2.0 | Copyright (c) Microsoft Corporation |
| `vite` | MIT | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors |
| `vitest` | MIT | Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors |

Electron itself bundles Chromium and Node.js, which carry their own licenses
(BSD-3-Clause and MIT respectively, among others). See the Electron project's
`LICENSES.chromium.html`, shipped inside any packaged desktop build.

## Data

`world-atlas` and `topojson-client` supply the OSINT globe's basemap, derived
from [Natural Earth](https://www.naturalearthdata.com/), which is in the public
domain.

---

## License texts

### MIT License

Applies to all packages marked MIT above, each with its own copyright holder as
listed.

```
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### ISC License

Applies to `topojson-client` and `world-atlas`.

```
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD 2-Clause License

Applies to `dotenv`.

```
Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Apache License 2.0

Applies to `typescript`. Full text: https://www.apache.org/licenses/LICENSE-2.0

### The Unlicense

Applies to `postgres`. Full text: https://unlicense.org/

---

*Generated from the dependency tree in `package.json`. If you add or remove a
dependency, update this file.*
