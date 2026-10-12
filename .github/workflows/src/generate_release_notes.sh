#!/usr/bin/env bash
# Writes release_notes.md for a Nightly Browser release.
# Env: RELEASE_BRANCH (release|twilight), VERSION, BUILD_DATE,
#      MACOS_NOTARIZED / WINDOWS_SIGNED ("true" when those optional secrets exist).

set -euo pipefail

: "${RELEASE_BRANCH:?}" "${VERSION:?}" "${BUILD_DATE:?}"

# Same rule as surfer: non-release channels build the Firefox candidate version.
FIREFOX_VERSION=$(node -p "
  const v = require('./surfer.json').version;
  (process.env.RELEASE_BRANCH !== 'release' && v.candidate && v.candidate !== v.version) ? v.candidate : v.version
")
ZEN_BASE=$(grep -v '^[[:space:]]*#' .zen-upstream | grep -m1 -oE '[0-9a-f]{40}')
APP_NAME=$(node -p "require('./surfer.json').brands[process.env.RELEASE_BRANCH].brandShortName")

if [ "$RELEASE_BRANCH" = "release" ]; then
  TITLE="Nightly Browser ${VERSION}"
else
  TITLE="Nightly Browser Beta ${VERSION} (${BUILD_DATE})"
fi

{
  echo "# ${TITLE}"
  echo
  if [ "$RELEASE_BRANCH" != "release" ]; then
    echo "> [!NOTE]"
    echo "> This is the Beta channel: the latest changes, rebuilt in place under the \`twilight\` tag. Expect rough edges."
    echo
  fi
  echo "Built on Firefox ${FIREFOX_VERSION} from Zen Browser upstream [\`${ZEN_BASE:0:12}\`](https://github.com/zen-browser/desktop/commit/${ZEN_BASE})."
  echo
  echo "| Platform | Download |"
  echo "| --- | --- |"
  echo "| macOS (Apple Silicon + Intel) | \`nightly.macos-universal.dmg\` |"
  echo "| Windows x64 | \`nightly.installer.exe\`, portable \`nightly.win-x86_64.zip\` |"
  echo "| Windows ARM64 | \`nightly.installer-arm64.exe\`, portable \`nightly.win-arm64.zip\` |"
  echo "| Linux x64 | \`nightly.linux-x86_64.tar.xz\`, \`nightly-x86_64.AppImage\` |"
  echo "| Linux ARM64 | \`nightly.linux-aarch64.tar.xz\`, \`nightly-aarch64.AppImage\` |"
  echo
  echo "Installed builds update themselves from signed \`.mar\` files attached to this release."
  echo "Verify downloads with \`sha256sum -c SHA256SUMS\`."
  if [ "${MACOS_NOTARIZED:-false}" != "true" ]; then
    echo
    echo "macOS: this build is not notarized. After copying the app to Applications run"
    echo "\`xattr -dr com.apple.quarantine \"/Applications/${APP_NAME}.app\"\` once."
  fi
  if [ "${WINDOWS_SIGNED:-false}" != "true" ]; then
    echo
    echo "Windows: the installer is not Authenticode-signed, so SmartScreen will warn on first run."
  fi
} > release_notes.md

echo "Release notes generated: release_notes.md"
