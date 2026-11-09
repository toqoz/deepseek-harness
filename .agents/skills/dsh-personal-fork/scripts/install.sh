#!/usr/bin/env bash
# Build the fork checkout into a new ready generation. Nix owns the toolchain
# and the launchd service; this script owns the app build and the generation
# store. The committed HEAD of the checkout is the only source, and the prior
# generation stays published until a complete build and smoke pass.
#
# Usage: install.sh [--if-publishable]
#   --if-publishable  exit 0 instead of failing when the checkout cannot be
#                     published (dirty, or another branch); used by automation
set -euo pipefail
umask 077

CLI_ENTRY=apps/cli/lib/bin.js

GIT=${DSH_GIT:-git}
NODE=${DSH_NODE:-node}
PNPM=${DSH_PNPM:-pnpm}

HOME_DIR=${DEEPSEEK_HARNESS_HOME:-$HOME/.local/share/deepseek-harness}
BUILDS=$HOME_DIR/builds
READY=$HOME_DIR/ready

if_publishable=false
if [ "${1:-}" = "--if-publishable" ]; then
  if_publishable=true
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "install.sh: unexpected arguments: $*" >&2
  exit 2
fi

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

# A checkout that is dirty or on another branch stays untouched; automation
# passes --if-publishable so it does not fail on such a checkout.
refuse() {
  if [ "$if_publishable" = true ]; then
    echo "install.sh: $*; skipping" >&2
    trap - EXIT
    exit 0
  fi
  fail "$@"
}

attempt=
cleanup() {
  if [ -n "$attempt" ] && [ -d "$attempt" ]; then
    rm -rf "$attempt"
    echo "install.sh: failed; removed the attempt, prior ready build untouched" >&2
  fi
}
trap cleanup EXIT

CHECKOUT=${DSH_CHECKOUT:-}
if [ -z "$CHECKOUT" ]; then
  CHECKOUT=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi
if [ -z "$CHECKOUT" ] || ! "$GIT" -C "$CHECKOUT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  refuse "no git checkout at ${CHECKOUT:-<cwd>}; set DSH_CHECKOUT"
  exit 1
fi
if [ -n "$("$GIT" -C "$CHECKOUT" status --porcelain)" ]; then
  refuse "$CHECKOUT has uncommitted changes; commit or stash them first"
fi

REV=$("$GIT" -C "$CHECKOUT" rev-parse HEAD)
branch=
for candidate in toqoz/main toqoz/develop; do
  ref=$("$GIT" -C "$CHECKOUT" rev-parse --verify --quiet "refs/heads/$candidate" || true)
  if [ -n "$ref" ] && [ "$ref" = "$REV" ]; then
    branch=$candidate
    break
  fi
done
if [ -z "$branch" ]; then
  refuse "checkout HEAD ($REV) is not toqoz/main or toqoz/develop; switch to one of them"
fi

# Fast path: this commit is already the published generation.
if [ -L "$READY" ] && [ -d "$READY" ] && [ "$(cat "$READY/.dsh-rev" 2>/dev/null || true)" = "$REV" ]; then
  echo "deepseek-harness $REV ($branch) is already installed"
  trap - EXIT
  exit 0
fi

if [ -e "$READY" ] && [ ! -L "$READY" ]; then
  fail "$READY exists and is not a symlink; refusing to replace it"
fi

mkdir -p "$HOME_DIR"
attempt=$(mktemp -d "$HOME_DIR/attempt.XXXXXXXX")
rmdir "$attempt"
echo "==> cloning $CHECKOUT at $REV ($branch)"
# A local clone carries the committed tree and its Git metadata, so the client
# build can read the commit, while a dirty working tree stays out of the
# generation.
"$GIT" clone --local --no-checkout --quiet "$CHECKOUT" "$attempt"
"$GIT" -C "$attempt" checkout --detach "$REV" --quiet
[ "$("$GIT" -C "$attempt" rev-parse HEAD)" = "$REV" ] || fail "checkout did not converge onto $REV"

manifest=$attempt/package.json
[ -f "$manifest" ] || fail "$REV has no package.json"
VERSION=$("$NODE" -p "require('$manifest').version")

echo "==> pnpm install --frozen-lockfile"
(
  cd "$attempt"
  "$PNPM" install --frozen-lockfile
  echo "==> pnpm run build"
  "$PNPM" run build
)

echo "==> smoke: built CLI --version and web --help"
smoke=$("$NODE" "$attempt/$CLI_ENTRY" --version) || fail "built CLI failed"
case $smoke in
  *"$VERSION"*) ;;
  *) fail "source launch reported '$smoke', expected version $VERSION" ;;
esac
DSH_HOME="$attempt/.smoke-home" "$NODE" "$attempt/$CLI_ENTRY" web --help >/dev/null || fail "Web profile failed to boot"
rm -rf "$attempt/.smoke-home"

echo "==> publishing $VERSION"
mkdir -p "$BUILDS"
build_id=$VERSION-$(date -u +%Y%m%d%H%M%S)-$$
echo "$REV" > "$attempt/.dsh-rev"
mv "$attempt" "$BUILDS/$build_id"
attempt=
ln -s "builds/$build_id" "$READY.new.$$"
"$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$READY.new.$$" "$READY"
echo "deepseek-harness $VERSION ($branch) installed at $READY"
