#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# GitHub Pages hosting for the update manifests. The browser asks
#   https://samnolak.github.io/nightly-browser/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml
# (surfer.json updateHostname), which maps to updates/browser/... on the gh-pages
# branch. The MARs themselves are GitHub release assets.
#
#   init [owner/repo]      One-time setup by a repository admin (uses `gh`): create an
#                          orphan gh-pages branch through the GitHub API (no local push)
#                          and enable Pages from it. Run after the first push of main.
#   publish <dir>...       CI: copy <dir>/browser/** (surfer's dist/update output) to
#                          updates/browser/ on gh-pages and push, using the credentials
#                          actions/checkout stored for the current repository.

set -euo pipefail

INDEX_HTML='<!doctype html>
<meta charset="utf-8">
<title>Nightly Browser updates</title>
<p>This site serves update manifests for
<a href="https://github.com/samnolak/nightly-browser">Nightly Browser</a>.
Downloads are on the <a href="https://github.com/samnolak/nightly-browser/releases/latest">releases page</a>.</p>
'

init_pages() {
  local repo="${1:-samnolak/nightly-browser}"

  if gh api "repos/$repo/branches/gh-pages" > /dev/null 2>&1; then
    echo "gh-pages already exists in $repo"
  else
    local tree commit
    tree=$(jq -n --arg index "$INDEX_HTML" '{tree: [
        {path: "index.html", mode: "100644", type: "blob", content: $index},
        {path: ".nojekyll", mode: "100644", type: "blob", content: ""}
      ]}' | gh api -X POST "repos/$repo/git/trees" --input - --jq .sha)
    commit=$(jq -n --arg tree "$tree" '{message: "Initialize GitHub Pages for update manifests", tree: $tree, parents: []}' \
      | gh api -X POST "repos/$repo/git/commits" --input - --jq .sha)
    gh api -X POST "repos/$repo/git/refs" -f ref=refs/heads/gh-pages -f sha="$commit" > /dev/null
    echo "Created gh-pages ($commit) in $repo"
  fi

  if gh api "repos/$repo/pages" > /dev/null 2>&1; then
    echo "GitHub Pages is already enabled for $repo"
  else
    jq -n '{source: {branch: "gh-pages", path: "/"}}' | gh api -X POST "repos/$repo/pages" --input - > /dev/null
    echo "Enabled GitHub Pages for $repo from gh-pages"
  fi
  gh api "repos/$repo/pages" --jq '"Pages URL: \(.html_url)"'
}

# Check out the latest gh-pages (or a new orphan) in $1 and copy the manifests in.
prepare_pages_worktree() {
  local work="$1"
  shift
  if [ -d "$work" ]; then
    git worktree remove --force "$work"
  fi
  if git fetch --quiet --depth=1 origin gh-pages; then
    git worktree add --quiet --detach "$work" FETCH_HEAD
  else
    echo "gh-pages does not exist yet; creating it"
    git worktree add --quiet --detach "$work" HEAD
    git -C "$work" checkout --quiet --orphan "nightly-gh-pages-$$-$RANDOM"
    git -C "$work" rm -rf --quiet .
  fi

  mkdir -p "$work/updates/browser"
  local dir
  for dir in "$@"; do
    cp -R "$dir/browser/." "$work/updates/browser/"
  done
  [ -f "$work/index.html" ] || printf '%s' "$INDEX_HTML" > "$work/index.html"
  touch "$work/.nojekyll"
  git -C "$work" add -A
}

publish() {
  if [ "$#" -eq 0 ]; then
    echo "Usage: $0 publish <manifest dir>..." >&2
    exit 1
  fi
  local dir
  for dir in "$@"; do
    if [ ! -d "$dir/browser" ]; then
      echo "Error: $dir/browser not found" >&2
      exit 1
    fi
  done

  local work attempt
  work="$(mktemp -d)/gh-pages"
  for attempt in 1 2 3; do
    prepare_pages_worktree "$work" "$@"
    if git -C "$work" diff --cached --quiet; then
      echo "Update manifests are already up to date"
      git worktree remove --force "$work"
      return 0
    fi
    git -C "$work" commit --quiet -m "Publish update manifests${PUBLISH_LABEL:+ for $PUBLISH_LABEL}"
    # A concurrent publish makes this push non-fast-forward: start over from the
    # new gh-pages head.
    if git -C "$work" push --quiet origin HEAD:refs/heads/gh-pages; then
      git -C "$work" log -1 --stat --format='Published %h'
      git worktree remove --force "$work"
      return 0
    fi
    echo "Push attempt $attempt failed; retrying with the latest gh-pages" >&2
    sleep $((attempt * 10))
  done
  echo "Error: could not publish update manifests to gh-pages" >&2
  exit 1
}

case "${1:-}" in
  init)
    shift
    init_pages "$@"
    ;;
  publish)
    shift
    publish "$@"
    ;;
  *)
    echo "Usage: $0 init [owner/repo] | publish <manifest dir>..." >&2
    exit 1
    ;;
esac
