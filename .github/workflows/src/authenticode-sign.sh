#!/usr/bin/env bash
# Authenticode-sign one PE file in place with osslsigncode.
# Expects $RUNNER_TEMP/authenticode.pfx and $RUNNER_TEMP/authenticode.pass
# (written by the "Prepare Authenticode signing" step of windows-release-build.yml).
# Files that already carry a signature (e.g. the Microsoft CRT DLLs) are left alone.

set -euo pipefail

file="$1"
pfx="$RUNNER_TEMP/authenticode.pfx"
pass="$RUNNER_TEMP/authenticode.pass"
timestamp_url="http://timestamp.digicert.com"

sig_dir=$(mktemp -d)
if osslsigncode extract-signature -in "$file" -out "$sig_dir/sig" > /dev/null 2>&1; then
  rm -rf "$sig_dir"
  echo "Already signed, skipping: $file"
  exit 0
fi
rm -rf "$sig_dir"
rm -f "$file.signed"

echo "Signing $file"
osslsigncode sign \
  -pkcs12 "$pfx" \
  -readpass "$pass" \
  -h sha256 \
  -n "Nightly Browser" \
  -i "https://github.com/samnolak/nightly-browser" \
  -t "$timestamp_url" \
  -in "$file" \
  -out "$file.signed" > /dev/null
mv -f "$file.signed" "$file"
