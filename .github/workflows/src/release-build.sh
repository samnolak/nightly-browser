#!/usr/bin/env bash
# Release build driver shared by the Linux, Windows and macOS release workflows.
# Optional API keys come from the NIGHTLY_*_API_KEY secrets and are written to
# ~/.nightly-keys only for the duration of the build (see configs/common/mozconfig).

set -e

KEYS_DIR="$HOME/.nightly-keys"
remove_keys() {
  rm -rf "$KEYS_DIR"
}
trap remove_keys EXIT

if command -v apt-get &> /dev/null; then
  sudo apt-get install -y python3-launchpadlib
  sudo apt-get update
  sudo apt-get install -y xvfb libnvidia-egl-wayland1 mesa-utils libgl1-mesa-dri
fi

if ! test "$ZEN_CROSS_COMPILING" && test "$(uname -s)" = "Linux"; then
  if test -d "$HOME/.mozbuild/clang/bin"; then
    export CC="$HOME/.mozbuild/clang/bin/clang"
    export CXX="$HOME/.mozbuild/clang/bin/clang++"
  else
    export CC=clang
    export CXX=clang++
  fi
fi

# Keys are written without tracing so they never reach the job log.
(
  umask 077
  mkdir -p "$KEYS_DIR"
  if test -n "$NIGHTLY_SAFEBROWSING_API_KEY"; then
    printf '%s' "$NIGHTLY_SAFEBROWSING_API_KEY" > "$KEYS_DIR/safebrowsing.dat"
  fi
  if test -n "$NIGHTLY_MOZILLA_API_KEY"; then
    printf '%s' "$NIGHTLY_MOZILLA_API_KEY" > "$KEYS_DIR/mozilla.dat"
  fi
  if test -n "$NIGHTLY_GOOGLE_LOCATION_SERVICE_API_KEY"; then
    printf '%s' "$NIGHTLY_GOOGLE_LOCATION_SERVICE_API_KEY" > "$KEYS_DIR/google_location_service.dat"
  fi
)
unset NIGHTLY_SAFEBROWSING_API_KEY NIGHTLY_MOZILLA_API_KEY NIGHTLY_GOOGLE_LOCATION_SERVICE_API_KEY

# shellcheck source=/dev/null
. "$HOME/.cargo/env"

# Embed the Nightly MAR verification certificate into the updater.
bash ./scripts/mar_sign.sh -i

ulimit -n 4096

set -x
export ZEN_RELEASE=1
if command -v Xvfb &> /dev/null && ! test "$ZEN_CROSS_COMPILING"; then
  Xvfb :2 -nolisten tcp -noreset -screen 0 1024x768x24 &
  export LLVM_PROFDATA="$HOME/.mozbuild/clang/bin/llvm-profdata"
  export DISPLAY=:2
fi
npm run build
