#!/usr/bin/env bash
# Creates or updates the GitHub release for a build and uploads its assets.
#   release channel:  tag = displayVersion, normal release marked latest (so
#                     /releases/latest always points at the newest stable build)
#   twilight channel: tag "twilight", a pre-release rebuilt in place; the tag is
#                     moved to the built commit.
# The tag names match the MAR URLs surfer writes into update.xml.
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, RELEASE_BRANCH, TAG, TITLE,
#      NOTES_FILE. Arguments: asset files.

set -euo pipefail

: "${RELEASE_BRANCH:?}" "${TAG:?}" "${TITLE:?}" "${NOTES_FILE:?}"

if [ "$#" -eq 0 ]; then
  echo "Error: no release assets given" >&2
  exit 1
fi

if [ "$RELEASE_BRANCH" = "release" ]; then
  flags=(--latest)
else
  flags=(--prerelease --latest=false)
fi

if gh release view "$TAG" > /dev/null 2>&1; then
  echo "Updating existing release $TAG"
  if [ "$RELEASE_BRANCH" != "release" ]; then
    gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/$TAG" -f sha="$GITHUB_SHA" -F force=true > /dev/null
  fi
  gh release edit "$TAG" --title "$TITLE" --notes-file "$NOTES_FILE" "${flags[@]}"
  gh release upload "$TAG" "$@" --clobber
else
  echo "Creating release $TAG"
  gh release create "$TAG" "$@" --target "$GITHUB_SHA" --title "$TITLE" --notes-file "$NOTES_FILE" "${flags[@]}"
fi

gh release view "$TAG" --json url,isPrerelease,assets --jq '"\(.url) prerelease=\(.isPrerelease) assets=\(.assets | length)"'
