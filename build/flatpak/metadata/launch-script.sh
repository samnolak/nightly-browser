#!/bin/bash
export TMPDIR="$XDG_CACHE_HOME/tmp"

exec /app/nightly/nightly --name io.github.samnolak.nightly "$@"
