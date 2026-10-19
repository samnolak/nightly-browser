<!--
   - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/.
   -->

# Branch Structure

The repository is structured as follows:

```
dev (main branch)
 | |
 | \--->-- stable (release branch)
 |   ^
 ^   |
 |   \-<- Hotfix (hotfixes directly from stable)
 |
 \-<- (features branches)
```

The `dev` branch is the main branch of the repository, and it is the default branch for the repository. The `twilight` branch is the feature branch, and it is branched off from the `dev` branch. The `stable` branch is the release branch, and it is branched off from the `dev` branch.

The `stable` branch may have hotfixes directly from the `stable` branch, and the `twilight` branch may have feature branches branched off from the `twilight` branch. This is done so that we can apply hotfixes like security patches directly to the `stable` branch without having to merge the changes from the `twilight` branch.

# Local Development Setup

Before you set up your local development environment, **read our [Building Guidelines](https://docs.zen-browser.app/guides/building)**. Skipping them can lead to avoidable build errors.

## Native browser-test startup

Browser-chrome Mochitests install `mochikit` and dispatch `mochitest-load` before
loading `browser-test.js`. The harness then opens `browser-harness.xhtml`, reads
the test manifest, and waits for the harness and browser windows to receive focus
before `Tester.start()` logs `Start BrowserChrome Test Results`. A run with zero
checks and no start marker needs bootstrap diagnostics, not changes to test cases.

Startup category modules are ES modules: import dependencies such as
`XPCOMUtils` explicitly rather than relying on browser-window globals.
`ZenOpenInApp` follows this rule. Category-listener errors are caught independently,
so their presence alone does not identify the cause of a stalled test harness.

On macOS, unpackaged builds grant content-process read access to the engine source
and object directories. Canonical source symlinks outside those directories can
require the test-only `security.sandbox.content.mac.testing_read_path1` preference,
set to the canonical `src` directory for that run. A parent-process file-existence
check does not establish that a sandboxed content actor can load the same file.
Do not disable the sandbox or the affected browser feature to hide a load error.

# Code Of Conduct

Please read our [Code of Conduct](../CODE_OF_CONDUCT.md) before contributing.
