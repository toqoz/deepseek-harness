#!/usr/bin/env bash
# Personal-fork operations: rebase every change branch onto upstream, rebuild the
# staging branch as one commit, and publish it to the integration branch. See
# ../SKILL.md.
#
# Usage: sync.sh [--stage] [--push] [--promote [--force]] [--message <gist-url>]
#   (default), --stage  rebase every change onto upstream and rebuild
#                       toqoz/develop locally; touches neither toqoz/main nor
#                       the remote
#   --push              rebuild and publish: the change branches, toqoz/develop,
#                       and toqoz/main moved to the same commit (the upstream
#                       import path; it does not require a ready build)
#   --promote           move toqoz/main to the installed toqoz/develop commit and
#                       publish both (the feature path; requires a matching ready
#                       build; --force skips that check)
#   --install           build the rebuilt staging commit into a ready generation
#                       and restart the service; moves a clean checkout to that
#                       commit first (combine with --push for the import path)
#   --message           gist URL for the rebuilt staging commit; defaults to the
#                       current staging subject, else the integration subject
#
# Runs from any worktree and never moves the caller's checkout: change branches
# are rebased in temporary worktrees and branches are moved with
# `git update-ref`. The running worktree keeps its old files until it is reset.
set -euo pipefail

UPSTREAM_REMOTE=upstream
UPSTREAM_BRANCH=shiguredo
UPSTREAM_REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
INTEGRATION_BRANCH=toqoz/main
STAGING_BRANCH=toqoz/develop
CHANGE_PREFIX=toqoz/feat/
HARNESS_HOME=${DEEPSEEK_HARNESS_HOME:-$HOME/.local/share/deepseek-harness}
push=false
promote=false
force=false
install=false
message=

fail() {
  echo "sync.sh: $*" >&2
  exit 2
}

# Move the integration branch onto the staging commit. The two share one commit
# after promotion, so the installed generation keeps identifying the released
# commit and no rebuild is needed.
fast_forward_integration() {
  local staging old_main commits
  staging=$(git rev-parse "refs/heads/$STAGING_BRANCH")
  old_main=$(git rev-parse --verify --quiet "refs/heads/$INTEGRATION_BRANCH" || true)
  if [ "$old_main" = "$staging" ]; then
    echo "$INTEGRATION_BRANCH already matches $STAGING_BRANCH"
    return 0
  fi
  if [ -n "$old_main" ]; then
    git update-ref "refs/heads/$INTEGRATION_BRANCH" "$staging" "$old_main"
  else
    git update-ref "refs/heads/$INTEGRATION_BRANCH" "$staging"
  fi
  commits=$(git rev-list --count "$UPSTREAM_REF..$INTEGRATION_BRANCH")
  if [ "$commits" -ne 1 ]; then
    echo "sync.sh: $INTEGRATION_BRANCH has $commits commits on $UPSTREAM_REF; expected one" >&2
    echo "sync.sh: run sync.sh --stage so the staging commit sits directly on upstream" >&2
    exit 1
  fi
  echo "promoted $staging to $INTEGRATION_BRANCH"
}

publish() {
  local branch
  for branch in "$@"; do
    echo "pushing $branch"
    git push --no-verify --force-with-lease --set-upstream origin "$branch"
  done
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage) ;;
    --push) push=true ;;
    --promote) promote=true ;;
    --install) install=true ;;
    --force) force=true ;;
    --message)
      shift
      message=${1:-}
      if [ -z "$message" ]; then
        fail "--message needs a gist URL"
      fi
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"
checkout=$(pwd -P)
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

if [ -n "$(git status --porcelain)" ]; then
  fail "working tree is not clean; commit or stash first"
fi

# Build the staged commit into a ready generation and restart the service. Nix
# owns the toolchain and supervision; this owns the app build and generations.
publish_generation() {
  local staging current
  [ "$install" = true ] || return 0
  staging=$(git rev-parse "refs/heads/$STAGING_BRANCH")
  current=$(cat "$HARNESS_HOME/ready/.dsh-rev" 2>/dev/null || true)
  if [ "$current" = "$staging" ]; then
    echo "the ready generation already runs $staging; nothing to install"
    return 0
  fi
  if [ "$(git -C "$checkout" rev-parse HEAD)" != "$staging" ]; then
    echo "==> moving $checkout to $STAGING_BRANCH ($staging)"
    git -C "$checkout" switch --quiet "$STAGING_BRANCH"
    git -C "$checkout" reset --hard --quiet "$staging"
  fi
  echo "==> building a ready generation"
  DSH_CHECKOUT="$checkout" DEEPSEEK_HARNESS_HOME="$HARNESS_HOME" "$script_dir/install.sh"
  echo "==> restarting the service"
  "$script_dir/restart.sh"
}

# Promotion publishes the verified staging commit and nothing else, so it
# neither fetches upstream nor rebuilds. Promote only what was installed and
# verified: the ready generation records the commit `deepseek-harness-install`
# built. An already-promoted staging commit needs no check.
if [ "$promote" = true ]; then
  staging=$(git rev-parse --verify --quiet "refs/heads/$STAGING_BRANCH" || true)
  if [ -z "$staging" ]; then
    fail "no $STAGING_BRANCH; run sync.sh first"
  fi
  current_main=$(git rev-parse --verify --quiet "refs/heads/$INTEGRATION_BRANCH" || true)
  if [ "$current_main" = "$staging" ]; then
    echo "$INTEGRATION_BRANCH already matches $STAGING_BRANCH ($staging)"
    publish "$STAGING_BRANCH" "$INTEGRATION_BRANCH"
    exit 0
  fi
  if [ "$force" != true ]; then
    ready_rev=$(cat "$HARNESS_HOME/ready/.dsh-rev" 2>/dev/null || true)
    if [ "$ready_rev" != "$staging" ]; then
      fail "the ready build is ${ready_rev:-absent}, not $STAGING_BRANCH ($staging); install and verify it, or pass --force"
    fi
  fi
  fast_forward_integration
  echo
  publish "$STAGING_BRANCH" "$INTEGRATION_BRANCH"
  publish_generation
  echo
  echo "the checked-out worktree keeps its files until 'git switch $INTEGRATION_BRANCH'"
  exit 0
fi

echo "fetching $UPSTREAM_REMOTE $UPSTREAM_BRANCH"
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --prune
git rev-parse --verify "$UPSTREAM_REF" >/dev/null

changes=()
while IFS= read -r branch; do
  changes+=("$branch")
done < <(git for-each-ref --format='%(refname:short)' "refs/heads/$CHANGE_PREFIX")

if [ "${#changes[@]}" -eq 0 ]; then
  fail "no ${CHANGE_PREFIX}* branches"
fi

# A squashed branch tip whose subject is one bare gist URL is an integration
# commit, never a personal change.
is_integration_commit() {
  case "$(git log -1 --format=%s "$1")" in
    https://gist.github.com/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Each change is one commit. Checking before the rebase names the offending
# branch before history is rewritten under it.
#
# Upstream replaces its single integration commit instead of appending, so a
# change branch can still sit on the tip upstream has since rewritten. That
# commit is skipped when counting here and dropped by the rebase below.
bases=()
stale_counts=()
for branch in "${changes[@]}"; do
  own=0
  base=
  stale=0
  while IFS= read -r commit; do
    if [ "$own" -eq 0 ] && is_integration_commit "$commit"; then
      stale=$((stale + 1))
      continue
    fi
    own=$((own + 1))
    base=$(git rev-parse "$commit~1")
  done < <(git rev-list --reverse "$UPSTREAM_REF..$branch")
  if [ "$own" -ne 1 ]; then
    echo "sync.sh: $branch holds $own personal commits on $UPSTREAM_REF; a change holds exactly one" >&2
    exit 1
  fi
  if [ -n "$(git rev-list --merges "$base..$branch")" ]; then
    echo "sync.sh: $branch contains a merge commit; a change holds one non-merge commit" >&2
    exit 1
  fi
  bases+=("$base")
  stale_counts+=("$stale")
done

if [ -z "$message" ]; then
  message=$(git log -1 --format=%s "$STAGING_BRANCH" 2>/dev/null || true)
fi
if [ -z "$message" ]; then
  message=$(git log -1 --format=%s "$INTEGRATION_BRANCH" 2>/dev/null || true)
fi
case "$message" in
  https://gist.github.com/*) ;;
  *)
    fail "$STAGING_BRANCH has no gist URL; pass --message <url>"
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

index=0
for branch in "${changes[@]}"; do
  base=${bases[$index]}
  stale=${stale_counts[$index]}
  index=$((index + 1))
  if [ "$stale" -gt 0 ]; then
    echo "rebasing $branch onto $UPSTREAM_REF, dropping $stale stale upstream commit(s)"
  else
    echo "rebasing $branch onto $UPSTREAM_REF"
  fi
  path="$tmp_root/rebase-$(printf '%s' "$branch" | tr '/' '-')"
  worktrees+=("$path")
  # The branch is checked out here, so `git rebase --continue` moves it for us.
  git worktree add --force "$path" "$branch" >/dev/null
  if ! git -C "$path" rebase --onto "$UPSTREAM_REF" "$base"; then
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

echo "rebuilding $STAGING_BRANCH from $UPSTREAM_REF"
build_path="$tmp_root/build"
worktrees+=("$build_path")
git worktree add --force --detach "$build_path" "$UPSTREAM_REF" >/dev/null
for branch in "${changes[@]}"; do
  if ! git -C "$build_path" merge --squash "$branch" >/dev/null; then
    echo "sync.sh: merging $branch into $STAGING_BRANCH conflicted; the rebuild was discarded." >&2
    echo "sync.sh: resolve the overlap in $branch, or move the shared part into its own branch, then rerun." >&2
    exit 1
  fi
  git -C "$build_path" commit --no-verify -q -m "squash $branch"
done
git -C "$build_path" reset --soft "$UPSTREAM_REF"
git -C "$build_path" commit --no-verify -q -m "$message"
new_commit=$(git -C "$build_path" rev-parse HEAD)
new_tree=$(git -C "$build_path" rev-parse 'HEAD^{tree}')
current_tree=$(git rev-parse --verify "refs/heads/$STAGING_BRANCH^{tree}" 2>/dev/null || true)
if [ "$new_tree" = "$current_tree" ] && [ "$message" = "$(git log -1 --format=%s "$STAGING_BRANCH" 2>/dev/null || true)" ]; then
  echo "$STAGING_BRANCH already matches upstream and every change; nothing to rebuild"
  git worktree remove --force "$build_path"
  if [ "$push" = true ]; then
    fast_forward_integration
    echo
    publish "${changes[@]}" "$STAGING_BRANCH" "$INTEGRATION_BRANCH"
  fi
  publish_generation
  exit 0
fi
old_commit=$(git rev-parse --verify "refs/heads/$STAGING_BRANCH" 2>/dev/null || true)
if [ -n "$old_commit" ]; then
  git update-ref "refs/heads/$STAGING_BRANCH" "$new_commit" "$old_commit"
else
  git update-ref "refs/heads/$STAGING_BRANCH" "$new_commit"
fi
git worktree remove --force "$build_path"

commits=$(git rev-list --count "$UPSTREAM_REF..$STAGING_BRANCH")
if [ "$commits" -ne 1 ]; then
  echo "sync.sh: $STAGING_BRANCH has $commits commits on $UPSTREAM_REF; expected one" >&2
  exit 1
fi

echo
echo "$STAGING_BRANCH: $(git log -1 --format=%s "$STAGING_BRANCH")"
git diff --stat "$UPSTREAM_REF..$STAGING_BRANCH" | tail -1

if [ "$push" = true ]; then
  fast_forward_integration
  echo
  publish "${changes[@]}" "$STAGING_BRANCH" "$INTEGRATION_BRANCH"
else
  echo "$INTEGRATION_BRANCH stays at $(git log -1 --format='%h %s' "$INTEGRATION_BRANCH" 2>/dev/null || echo 'no commit')"
fi

if [ "$install" = true ]; then
  publish_generation
elif [ "$push" != true ]; then
  echo
  echo "next: sync.sh --install    # build and restart the staged generation"
  echo "      sync.sh --promote    # after verification; fast-forwards $INTEGRATION_BRANCH"
fi
