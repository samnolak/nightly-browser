#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Follow Zen Browser upstream without importing its history.
#
# .zen-upstream records the zen-browser/desktop commit this tree is based on.
# This script fetches that commit and the requested ref (shallow, into a scratch
# repository), rebrands both snapshots with scripts/nightly_rebrand.py, diffs
# them and applies the diff with `git apply --3way` on a new branch. Diffing
# rebranded snapshots keeps Zen -> Nightly string replacements from turning
# every nearby upstream change into a conflict. It then runs the rebrand on the
# result, records the new base in .zen-upstream, commits and opens a PR.
#
# Zen also bumps Firefox (surfer.json, patches, l10n), so following Zen replaces
# Zen's own Firefox sync tooling.
#
# Paths the fork maintains itself are not synced:
#   .github/, .zen-upstream, build/signing/  - fork CI, upstream marker, MAR cert
#   configs/branding/                         - only files Zen adds are taken
#   files deleted in this fork                - upstream edits are skipped
#
# Conflicts: conflicted files are committed with conflict markers, hunks that do
# not apply at all are left as *.rej files; the branch is pushed, a draft PR is
# opened and the script exits 1.
#
# Usage: scripts/sync_upstream_zen.sh [--ref <zen ref or sha>] [--branch <name>]
#                                      [--no-pr]
#   --ref     zen-browser/desktop branch, tag or commit (default: dev)
#   --branch  branch to create (default: zen-sync/<short sha>)
#   --no-pr   commit locally only; do not push or open a pull request

set -euo pipefail

ZEN_REPO_URL="https://github.com/zen-browser/desktop.git"
ZEN_WEB_URL="https://github.com/zen-browser/desktop"
IGNORED_PATHS=(.github .zen-upstream build/signing)
ADDITIONS_ONLY_PATHS=(configs/branding)

ref="dev"
branch=""
open_pr=1

die() {
  echo "Error: $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) ref="${2:?--ref needs a value}"; shift 2 ;;
    --branch) branch="${2:?--branch needs a value}"; shift 2 ;;
    --no-pr) open_pr=0; shift ;;
    -h|--help) sed -n '6,33p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"
git_dir=$(git rev-parse --absolute-git-dir)

[ -f scripts/nightly_rebrand.py ] || die "scripts/nightly_rebrand.py is missing"
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes"
base_branch=$(git symbolic-ref --quiet --short HEAD) || die "check out the branch to sync first"

base_sha=$(grep -v '^[[:space:]]*#' .zen-upstream | grep -m1 -oE '^[0-9a-f]{40}') \
  || die ".zen-upstream does not contain a commit sha"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Fetching zen-browser/desktop $base_sha (current base) and $ref..."
zen="$tmp/zen.git"
git init --quiet --bare "$zen"
git -C "$zen" fetch --quiet --depth=1 --no-tags "$ZEN_REPO_URL" "$base_sha"
git -C "$zen" fetch --quiet --depth=1 --no-tags "$ZEN_REPO_URL" "$ref"
new_sha=$(git -C "$zen" rev-parse FETCH_HEAD)

if [ "$new_sha" = "$base_sha" ]; then
  echo "Already at zen-browser/desktop@$new_sha; nothing to sync."
  exit 0
fi
short_old=${base_sha:0:7}
short_new=${new_sha:0:7}
branch=${branch:-zen-sync/$short_new}
if git show-ref --quiet --verify "refs/heads/$branch"; then
  die "branch $branch already exists"
fi

# Export a Zen commit, rebrand it like this tree and store it as a tree object in
# this repository (so `git apply --3way` finds the pre-image blobs). Prints the
# tree id.
snapshot() {
  local sha="$1" dir="$tmp/tree-$1" copied=0
  mkdir -p "$dir"
  git -C "$zen" archive "$sha" | tar -x -C "$dir"
  if [ ! -e "$dir/scripts/nightly_rebrand.py" ]; then
    mkdir -p "$dir/scripts"
    cp scripts/nightly_rebrand.py "$dir/scripts/nightly_rebrand.py"
    copied=1
  fi
  (cd "$dir" && PYTHONDONTWRITEBYTECODE=1 python3 scripts/nightly_rebrand.py) >&2
  if [ "$copied" = 1 ]; then
    rm -f "$dir/scripts/nightly_rebrand.py"
  fi
  GIT_INDEX_FILE="$tmp/index-$sha" git --git-dir="$git_dir" --work-tree="$dir" -C "$dir" add --all --force .
  GIT_INDEX_FILE="$tmp/index-$sha" git --git-dir="$git_dir" write-tree
}

echo "Rebranding upstream snapshots..."
old_tree=$(snapshot "$base_sha")
new_tree=$(snapshot "$new_sha")

pathspec=(.)
for p in "${IGNORED_PATHS[@]}" "${ADDITIONS_ONLY_PATHS[@]}"; do
  pathspec+=(":(exclude)$p")
done

# Upstream changes to files this fork deleted are skipped.
skipped_deleted=()
while IFS= read -r path; do
  if git cat-file -e "$old_tree:$path" 2> /dev/null && ! git cat-file -e "HEAD:$path" 2> /dev/null; then
    skipped_deleted+=("$path")
    pathspec+=(":(exclude,literal)$path")
  fi
done < <(git -c core.quotePath=false diff --name-only --no-renames "$old_tree" "$new_tree" -- "${pathspec[@]}")

skipped_owned=()
while IFS= read -r path; do
  skipped_owned+=("$path")
done < <(git -c core.quotePath=false diff --name-only --no-renames --diff-filter=a "$old_tree" "$new_tree" -- "${ADDITIONS_ONLY_PATHS[@]}")

changed=()
while IFS= read -r path; do
  changed+=("$path")
done < <(
  git -c core.quotePath=false diff --name-only --no-renames "$old_tree" "$new_tree" -- "${pathspec[@]}"
  git -c core.quotePath=false diff --name-only --no-renames --diff-filter=A "$old_tree" "$new_tree" -- "${ADDITIONS_ONLY_PATHS[@]}"
)

patch="$tmp/zen.patch"
git diff --binary --no-renames --full-index "$old_tree" "$new_tree" -- "${pathspec[@]}" > "$patch"
git diff --binary --no-renames --full-index --diff-filter=A "$old_tree" "$new_tree" -- "${ADDITIONS_ONLY_PATHS[@]}" >> "$patch"
echo "Upstream $short_old..$short_new changes ${#changed[@]} file(s) to apply."

git switch --quiet -c "$branch"

glob_escape() {
  printf '%s' "$1" | sed -e 's/[][*?\\]/\\&/g'
}

rejected=()
if [ -s "$patch" ] && ! git apply --3way --whitespace=nowarn "$patch"; then
  if [ -z "$(git ls-files --unmerged)" ] && git diff --cached --quiet; then
    # git apply is atomic: one file it cannot even 3-way merge (e.g. an upstream
    # addition of a path that already exists here) aborts everything. Apply file by
    # file so the rest still lands.
    echo "Whole-patch apply failed; applying file by file..."
    for path in "${changed[@]}"; do
      include=$(glob_escape "$path")
      if git apply --3way --whitespace=nowarn --include="$include" "$patch" 2> "$tmp/apply.log"; then
        continue
      fi
      if [ -n "$(git ls-files --unmerged -- "$path")" ]; then
        continue
      fi
      cat "$tmp/apply.log" >&2
      git apply --reject --whitespace=nowarn --include="$include" "$patch" > /dev/null 2>&1 || true
      rejected+=("$path")
    done
  fi
fi
conflicted=()
while IFS= read -r path; do
  conflicted+=("$path")
done < <(git -c core.quotePath=false diff --name-only --diff-filter=U)

echo "Running scripts/nightly_rebrand.py..."
PYTHONDONTWRITEBYTECODE=1 python3 scripts/nightly_rebrand.py

printf '%s\n' "$new_sha" > .zen-upstream
git add --all .

has_conflicts=0
if [ "${#conflicted[@]}" -gt 0 ] || [ "${#rejected[@]}" -gt 0 ]; then
  has_conflicts=1
fi

list() {
  if [ "$#" -eq 0 ]; then
    echo "- none"
  else
    # shellcheck disable=SC2016 # literal Markdown backticks
    printf -- '- `%s`\n' "$@"
  fi
}

title="Sync Zen upstream $short_old..$short_new"
if [ "$has_conflicts" = 1 ]; then
  title="$title (conflicts)"
fi

body="$tmp/body.md"
{
  echo "Syncs Zen upstream [\`$short_old...$short_new\`]($ZEN_WEB_URL/compare/$base_sha...$new_sha) (\`$ref\`)."
  echo
  echo "Generated by \`scripts/sync_upstream_zen.sh\`: the diff between the rebranded upstream snapshots was applied with \`git apply --3way\`, then \`scripts/nightly_rebrand.py\` ran on the result."
  echo
  if [ "$has_conflicts" = 1 ]; then
    echo "> [!WARNING]"
    echo "> Resolve the conflicts below on this branch before merging."
    echo
    echo "### Conflicts (markers committed)"
    list ${conflicted[@]+"${conflicted[@]}"}
    echo
    echo "### Not applied (see the \`*.rej\` files)"
    list ${rejected[@]+"${rejected[@]}"}
    echo
  fi
  echo "### Skipped: deleted in Nightly Browser"
  list ${skipped_deleted[@]+"${skipped_deleted[@]}"}
  echo
  echo "### Skipped: fork-owned branding changed upstream (review manually)"
  list ${skipped_owned[@]+"${skipped_owned[@]}"}
} > "$body"

git commit --quiet --no-verify -m "$title" -m "zen-browser/desktop@$new_sha ($ref)"
cat "$body"
echo
echo "Committed the sync on branch $branch."

if [ "$open_pr" = 1 ]; then
  git push --quiet --set-upstream origin "$branch"
  if [ "$has_conflicts" = 1 ]; then
    gh pr create --base "$base_branch" --head "$branch" --title "$title" --body-file "$body" --draft
  else
    gh pr create --base "$base_branch" --head "$branch" --title "$title" --body-file "$body"
  fi
fi

if [ "$has_conflicts" = 1 ]; then
  echo "Error: the upstream sync has ${#conflicted[@]} conflicted and ${#rejected[@]} rejected file(s); resolve them on $branch." >&2
  exit 1
fi
