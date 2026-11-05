#!/usr/bin/env bash
# Personal-fork operations: rebase every change branch onto upstream, rebuild
# the integration branch as one commit, and publish. See ../SKILL.md.
#
# Usage: sync.sh [--message <gist-url>] [--push]
#   --message  gist URL for the rebuilt integration commit; defaults to the
#              branch's current subject, which is the gist URL of the previous
#              run
#   --push     publish every change branch and the integration branch
#
# Runs from any worktree and never moves the caller's checkout: change branches
# are rebased in temporary worktrees and the integration branch is moved with
# `git update-ref`. The running worktree keeps its old files until it is reset.
set -euo pipefail

UPSTREAM_REMOTE=upstream
UPSTREAM_BRANCH=shiguredo
UPSTREAM_REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
INTEGRATION_BRANCH=toqoz/main
CHANGE_PREFIX=toqoz/feat/
push=false
message=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --push) push=true ;;
    --message)
      shift
      message=${1:-}
      if [ -z "$message" ]; then
        echo "sync.sh: --message needs a gist URL" >&2
        exit 2
      fi
      ;;
    *)
      echo "sync.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "sync.sh: working tree is not clean; commit or stash first" >&2
  exit 1
fi

if [ -z "$message" ]; then
  message=$(git log -1 --format=%s "$INTEGRATION_BRANCH" 2>/dev/null || true)
fi
case "$message" in
  https://gist.github.com/*) ;;
  *)
    echo "sync.sh: $INTEGRATION_BRANCH has no gist URL; pass --message <url>" >&2
    exit 1
    ;;
esac

common=$(git rev-parse --path-format=absolute --git-common-dir)
tmp_root="$common/wt"
worktrees=()
keep_worktrees=false
cleanup() {
  [ "$keep_worktrees" = true ] && return
  for path in ${worktrees[@]+"${worktrees[@]}"}; do
    git worktree remove --force "$path" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

echo "fetching $UPSTREAM_REMOTE $UPSTREAM_BRANCH"
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --prune
git rev-parse --verify "$UPSTREAM_REF" >/dev/null

changes=()
while IFS= read -r branch; do
  changes+=("$branch")
done < <(git for-each-ref --format='%(refname:short)' "refs/heads/$CHANGE_PREFIX")

if [ "${#changes[@]}" -eq 0 ]; then
  echo "sync.sh: no ${CHANGE_PREFIX}* branches" >&2
  exit 1
fi

# Each change is one commit. Checking before the rebase names the offending
# branch before history is rewritten under it.
for branch in "${changes[@]}"; do
  commits=$(git rev-list --count "$UPSTREAM_REF..$branch")
  if [ "$commits" -ne 1 ]; then
    echo "sync.sh: $branch holds $commits commits on $UPSTREAM_REF; a change holds exactly one" >&2
    exit 1
  fi
  if [ -n "$(git rev-list --merges "$UPSTREAM_REF..$branch")" ]; then
    echo "sync.sh: $branch contains a merge commit; a change holds one non-merge commit" >&2
    exit 1
  fi
done

for branch in "${changes[@]}"; do
  echo "rebasing $branch onto $UPSTREAM_REF"
  path="$tmp_root/rebase-$(printf '%s' "$branch" | tr '/' '-')"
  worktrees+=("$path")
  # The branch is checked out here, so `git rebase --continue` moves it for us.
  git worktree add --force "$path" "$branch" >/dev/null
  if ! git -C "$path" rebase "$UPSTREAM_REF"; then
    keep_worktrees=true
    echo "sync.sh: $branch conflicts; resolve it in $path, run 'git -C $path rebase --continue', then remove that worktree and rerun" >&2
    exit 1
  fi
  commits=$(git -C "$path" rev-list --count "$UPSTREAM_REF..HEAD")
  if [ "$commits" -ne 1 ]; then
    echo "sync.sh: rebasing $branch left $commits commits; upstream may already contain it — delete the branch and rerun" >&2
    exit 1
  fi
  git worktree remove --force "$path"
done

echo "rebuilding $INTEGRATION_BRANCH from $UPSTREAM_REF"
build_path="$tmp_root/build"
worktrees+=("$build_path")
git worktree add --force --detach "$build_path" "$UPSTREAM_REF" >/dev/null
for branch in "${changes[@]}"; do
  if ! git -C "$build_path" merge --squash "$branch" >/dev/null; then
    echo "sync.sh: merging $branch into $INTEGRATION_BRANCH conflicted; the rebuild was discarded." >&2
    echo "sync.sh: resolve the overlap in $branch, or move the shared part into its own branch, then rerun." >&2
    exit 1
  fi
  git -C "$build_path" commit --no-verify -q -m "squash $branch"
done
git -C "$build_path" reset --soft "$UPSTREAM_REF"
git -C "$build_path" commit --no-verify -q -m "$message"
new_commit=$(git -C "$build_path" rev-parse HEAD)
new_tree=$(git -C "$build_path" rev-parse 'HEAD^{tree}')
current_tree=$(git rev-parse --verify "refs/heads/$INTEGRATION_BRANCH^{tree}" 2>/dev/null || true)
if [ "$new_tree" = "$current_tree" ] && [ "$message" = "$(git log -1 --format=%s "$INTEGRATION_BRANCH" 2>/dev/null || true)" ]; then
  echo "$INTEGRATION_BRANCH already matches upstream and every change; nothing to rebuild"
  git worktree remove --force "$build_path"
  exit 0
fi
old_commit=$(git rev-parse --verify "refs/heads/$INTEGRATION_BRANCH" 2>/dev/null || true)
if [ -n "$old_commit" ]; then
  git update-ref "refs/heads/$INTEGRATION_BRANCH" "$new_commit" "$old_commit"
else
  git update-ref "refs/heads/$INTEGRATION_BRANCH" "$new_commit"
fi
git worktree remove --force "$build_path"

commits=$(git rev-list --count "$UPSTREAM_REF..$INTEGRATION_BRANCH")
if [ "$commits" -ne 1 ]; then
  echo "sync.sh: $INTEGRATION_BRANCH has $commits commits on $UPSTREAM_REF; expected one" >&2
  exit 1
fi

echo
echo "$INTEGRATION_BRANCH: $(git log -1 --format=%s "$INTEGRATION_BRANCH")"
git diff --stat "$UPSTREAM_REF..$INTEGRATION_BRANCH" | tail -1
echo "the checked-out worktree keeps its old files until 'git reset --hard $INTEGRATION_BRANCH'"

if [ "$push" = true ]; then
  for branch in "${changes[@]}"; do
    echo "pushing $branch"
    git push --no-verify --force-with-lease --set-upstream origin "$branch"
  done
  echo "pushing $INTEGRATION_BRANCH"
  git push --no-verify --force-with-lease origin "$INTEGRATION_BRANCH"
fi
