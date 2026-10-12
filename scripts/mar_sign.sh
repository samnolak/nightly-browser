#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# MAR signing helper.
#   -g  generate a new RSA-4096 key pair + self-signed certificate (one-time;
#       the private key must then be stored ONLY in the NIGHTLY_* secrets)
#   -i  embed build/signing/public_key.der into the updater before building
#   -s  sign every release MAR in place and refresh its update.xml manifests
#
# Signing (-s) reads, from the environment (GitHub Actions secrets):
#   NIGHTLY_SIGNING_CERT_PEM_BASE64         base64 of the PEM certificate
#   NIGHTLY_SIGNING_PRIVATE_KEY_PEM_BASE64  base64 of the PEM private key
#   NIGHTLY_MAR_SIGNING_PASSWORD            password for the throwaway NSS db
#   SIGNMAR                                 path to the signmar binary
# Key material is written under build/signing (gitignored) and always removed
# on exit. Firefox verifies MAR signatures as RSA PKCS#1 v1.5 with SHA-384.

set -euo pipefail

CERT_PATH_DIR=build/signing
UPDATER_CERT_DIR="engine/toolkit/mozapps/update/updater"
NSS_CONFIG_DIR="$CERT_PATH_DIR/nss_config"

generate_certs() {
  local tmp
  tmp=$(mktemp -d)
  (
    umask 077
    openssl genrsa -out "$tmp/private_key.pem" 4096
    openssl req -new -x509 -sha384 \
      -key "$tmp/private_key.pem" \
      -out "$tmp/cert.pem" \
      -subj "/CN=Nightly Browser MAR Signing/O=Nightly Browser" \
      -days 36500
    openssl x509 -in "$tmp/cert.pem" -outform DER -out "$tmp/public_key.der"

    mkdir -p "$CERT_PATH_DIR/env"
    mv "$tmp/private_key.pem" "$CERT_PATH_DIR/private_key.pem"
    mv "$tmp/cert.pem" "$CERT_PATH_DIR/cert.pem"
    base64 < "$CERT_PATH_DIR/cert.pem" | tr -d '\n' > "$CERT_PATH_DIR/env/NIGHTLY_SIGNING_CERT_PEM_BASE64"
    base64 < "$CERT_PATH_DIR/private_key.pem" | tr -d '\n' > "$CERT_PATH_DIR/env/NIGHTLY_SIGNING_PRIVATE_KEY_PEM_BASE64"
  )
  mv "$tmp/public_key.der" "$CERT_PATH_DIR/public_key.der"
  chmod 644 "$CERT_PATH_DIR/public_key.der"
  rm -rf "$tmp"

  # public_key.der must parse as a plain certificate: it is the only file
  # that is committed and embedded in the updater.
  openssl x509 -in "$CERT_PATH_DIR/public_key.der" -inform DER -noout -subject -fingerprint -sha256
  echo "Secrets were written to $CERT_PATH_DIR/env (gitignored). Upload them with" >&2
  echo "  gh secret set NAME < $CERT_PATH_DIR/env/NAME" >&2
  echo "then move the key material out of the repository." >&2
}

import_cert() {
  if [ ! -f "$CERT_PATH_DIR/public_key.der" ]; then
    echo "Error: $CERT_PATH_DIR/public_key.der not found." >&2
    exit 1
  fi
  # release_* is used by the "release" channel, dep* by every other channel
  # (twilight); see toolkit/mozapps/update/updater/moz.build.
  local files=(
    "$UPDATER_CERT_DIR/release_primary.der"
    "$UPDATER_CERT_DIR/release_secondary.der"
    "$UPDATER_CERT_DIR/dep1.der"
    "$UPDATER_CERT_DIR/dep2.der"
    "$UPDATER_CERT_DIR/xpcshellCertificate.der"
  )
  local file
  for file in "${files[@]}"; do
    if [ ! -f "$file" ]; then
      echo "Error: $file not found. Make sure the updater certificates exist." >&2
      exit 1
    fi
    echo "Copying $CERT_PATH_DIR/public_key.der to $file"
    cp "$CERT_PATH_DIR/public_key.der" "$file"
  done
  echo "Done. Rebuild the updater to embed the new certificate."
}

cleanup_certs() {
  rm -rf "$NSS_CONFIG_DIR" "$CERT_PATH_DIR/env"
  rm -f "$CERT_PATH_DIR/private_key.p12" "$CERT_PATH_DIR/private_key.pem" "$CERT_PATH_DIR/cert.pem"
}

create_nss_config_dir() {
  if [ -z "${NIGHTLY_SIGNING_CERT_PEM_BASE64:-}" ] || [ -z "${NIGHTLY_SIGNING_PRIVATE_KEY_PEM_BASE64:-}" ]; then
    echo "Error: NIGHTLY_SIGNING_CERT_PEM_BASE64 and NIGHTLY_SIGNING_PRIVATE_KEY_PEM_BASE64 must be set." >&2
    exit 1
  fi
  if [ -z "${NIGHTLY_MAR_SIGNING_PASSWORD:-}" ]; then
    echo "Error: NIGHTLY_MAR_SIGNING_PASSWORD must be set." >&2
    exit 1
  fi

  rm -rf "$NSS_CONFIG_DIR"
  (
    umask 077
    mkdir -p "$NSS_CONFIG_DIR"
    local password_file="$NSS_CONFIG_DIR/password.txt"
    printf '%s\n' "$NIGHTLY_MAR_SIGNING_PASSWORD" > "$password_file"
    printf '%s' "$NIGHTLY_SIGNING_CERT_PEM_BASE64" | base64 -d > "$CERT_PATH_DIR/cert.pem"
    printf '%s' "$NIGHTLY_SIGNING_PRIVATE_KEY_PEM_BASE64" | base64 -d > "$CERT_PATH_DIR/private_key.pem"

    if ! cmp -s <(openssl x509 -in "$CERT_PATH_DIR/cert.pem" -outform DER) "$CERT_PATH_DIR/public_key.der"; then
      echo "Error: the signing certificate does not match $CERT_PATH_DIR/public_key.der." >&2
      exit 1
    fi

    echo "Generating NSS config directory at $NSS_CONFIG_DIR"
    certutil -N -d "$NSS_CONFIG_DIR" -f "$password_file"

    echo "Wrapping key + cert into PKCS#12..."
    openssl pkcs12 -export \
      -inkey "$CERT_PATH_DIR/private_key.pem" \
      -in "$CERT_PATH_DIR/cert.pem" \
      -name "mar_sig" \
      -passout "file:$password_file" \
      -out "$CERT_PATH_DIR/private_key.p12"
    rm -f "$CERT_PATH_DIR/private_key.pem"

    echo "Importing PKCS#12 into NSS database..."
    pk12util \
      -i "$CERT_PATH_DIR/private_key.p12" \
      -d "$NSS_CONFIG_DIR" \
      -w "$password_file" \
      -k "$password_file"
    rm -f "$CERT_PATH_DIR/private_key.p12"
  )
}

# Each signed MAR lives in a directory named after the artifact (as produced by
# actions/download-artifact), next to the directory holding its update.xml files.
manifest_dir_for() {
  case "$(basename "$1")" in
    linux.mar) echo "linux_update_manifest_x86_64" ;;
    linux-aarch64.mar) echo "linux_update_manifest_aarch64" ;;
    windows.mar) echo "windows_update_manifest_x86_64" ;;
    windows-arm64.mar) echo "windows_update_manifest_arm64" ;;
    macos.mar) echo "macos_update_manifest" ;;
    *)
      echo "Unknown MAR file name: $1" >&2
      return 1
      ;;
  esac
}

update_manifests() {
  local mar="$1" manifest manifest_file size hash_value
  manifest=$(manifest_dir_for "$mar")
  size=$(wc -c < "$mar" | tr -d ' ')
  hash_value=$(sha512sum "$mar" | awk '{print $1}')
  local found=0
  while IFS= read -r -d '' manifest_file; do
    found=1
    # Signing changes the MAR, so hashValue and size in <patch> must follow.
    sed -i -E \
      -e "s/hashValue=\"[^\"]*\"/hashValue=\"$hash_value\"/" \
      -e "s/size=\"[^\"]*\"/size=\"$size\"/" \
      "$manifest_file"
    echo "Updated $manifest_file (size=$size)"
  done < <(find "$manifest" -type f -name update.xml -print0)
  if [ "$found" = 0 ]; then
    echo "Error: no update.xml found under $manifest for $mar" >&2
    exit 1
  fi
}

sign_mars() {
  if [ ! -f "${SIGNMAR:-}" ]; then
    echo "Error: signmar not found at '${SIGNMAR:-}'." >&2
    exit 1
  fi
  chmod +x "$SIGNMAR"

  trap cleanup_certs EXIT
  create_nss_config_dir

  local mar
  for mar in linux.mar/linux.mar linux-aarch64.mar/linux-aarch64.mar \
             windows.mar/windows.mar windows-arm64.mar/windows-arm64.mar \
             macos.mar/macos.mar; do
    if [ ! -f "$mar" ]; then
      echo "Error: $mar not found." >&2
      exit 1
    fi
    echo ""
    echo "Signing $mar..."
    # signmar reads the NSS database password from stdin when it is not a tty.
    "$SIGNMAR" -d "$NSS_CONFIG_DIR" -n "mar_sig" -s "$mar" "$mar.signed" < "$NSS_CONFIG_DIR/password.txt"
    "$SIGNMAR" -d "$NSS_CONFIG_DIR" -n "mar_sig" -v "$mar.signed" < "$NSS_CONFIG_DIR/password.txt"
    mv "$mar.signed" "$mar"
    echo "Signed $mar"
    update_manifests "$mar"
  done
}

case "${1:-}" in
  -g) generate_certs ;;
  -i) import_cert ;;
  -s) sign_mars ;;
  *)
    echo "Usage: $0 [-g] [-i] [-s]" >&2
    echo "  -g    Generate a new MAR signing key pair (one-time)" >&2
    echo "  -i    Embed build/signing/public_key.der into the updater" >&2
    echo "  -s    Sign the release MARs in place and update their manifests" >&2
    exit 1
    ;;
esac
