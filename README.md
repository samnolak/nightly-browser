<!--
   - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/.
   -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/nightly-wordmark-light.svg">
  <img src="./docs/assets/nightly-wordmark-dark.svg" alt="Nightly Browser" height="64">
</picture>

# Nightly Browser

Nightly Browser is a privacy-focused desktop web browser with vertical tabs,
workspaces, split view and a calm, Arc-like interface. It is a fork of
[Zen Browser](https://github.com/zen-browser/desktop), which is built on
[Mozilla Firefox](https://www.mozilla.org/firefox/).

- **No telemetry, no phoning home**: the browser does not report usage data and does not contact Zen's or Mozilla's telemetry services.
- **Updates from GitHub**: signed builds and updates are published on [GitHub Releases](https://github.com/samnolak/nightly-browser/releases).
- **All desktop platforms**: macOS (Apple silicon and Intel), Windows (x64 and ARM64) and Linux (x64 and ARM64).

Two channels are available: **Nightly Browser** (stable) and **Nightly Browser Beta**.

## Download

Get the latest build for your platform from the
[Releases page](https://github.com/samnolak/nightly-browser/releases).

## Building from source

Requirements: Git, Node.js (LTS) with npm, Python 3, Rust (cargo), and the
[Firefox build prerequisites](https://firefox-source-docs.mozilla.org/setup/index.html)
for your platform.

```sh
git clone https://github.com/samnolak/nightly-browser.git
cd nightly-browser
npm ci
npm run init                      # download Firefox, apply patches, bootstrap toolchains
npx surfer config brand release   # or "twilight" for Nightly Browser Beta
npm run build
npm start                         # run the build
npm run package                   # optional: create an installer/archive
```

Branding assets in `configs/branding/` are generated from the owner's cleaned,
transparent `nightly-artwork.png` by `scripts/nightly_branding.py`:
`uv run --with pillow --with resvg-py python3 scripts/nightly_branding.py`.
Both channels use the same artwork; private-browsing and feature icons remain
distinct. macOS icons preserve the artwork's aspect ratio on a 1024px canvas
with an approximately 824px tile and 100px margins. On macOS, `iconutil`
produces the complete 16–1024px ICNS representation set. PNG, Windows ICO/MSIX,
document, installer, about-page and Linux assets are generated together.
User-visible strings inherited from Zen are rebranded with
`python3 scripts/nightly_rebrand.py`.

## Reporting issues

Please report bugs and ideas on the
[issue tracker](https://github.com/samnolak/nightly-browser/issues).

## License and credits

Nightly Browser is licensed under the [Mozilla Public License 2.0](./LICENSE).
It is based on the work of the [Zen Browser](https://github.com/zen-browser/desktop)
project and on Mozilla Firefox. "Zen Browser" and "Firefox" are trademarks of
their respective owners; Nightly Browser is not affiliated with or endorsed by
them. The wordmark uses the [Outfit](https://github.com/Outfitio/Outfit-Fonts)
typeface (SIL Open Font License 1.1).
