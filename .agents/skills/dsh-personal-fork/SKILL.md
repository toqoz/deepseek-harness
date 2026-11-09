---
name: dsh-personal-fork
description: Use when creating, updating, rebasing, staging, verifying, or publishing a personal change in the toqoz/deepseek-harness fork, when importing a new shiguredo upstream into it, or when resolving the fork's branch conflicts.
---

# Personal fork operation

This checkout is a personal fork of [shiguredo/deepseek-harness](https://github.com/shiguredo/deepseek-harness). The procedure and its scripts live on the orphan branch `toqoz/ops`, mounted in the worktree `.git/wt/ops`; they are never merged into the code.

Two owners share this machine. The Nix configuration (`~/src/github.com/toqoz/config`) provides the toolchain (the pinned official Node and pnpm), the launchd service, and the data directories. This branch owns the app lifecycle: building a checkout into a ready generation, publishing it to `toqoz/develop`/`toqoz/main`, and restarting the service. Nix never builds the app and does not know the fork's revision.

## Branch model

| Ref | Meaning |
| --- | --- |
| `upstream/shiguredo` | The only upstream. Fetched from `https://github.com/shiguredo/deepseek-harness`. |
| `toqoz/feat/<slug>` | One personal change: exactly one commit on the current upstream, with an ordinary commit message. |
| `toqoz/develop` | Staging branch: upstream plus one commit holding every `toqoz/feat/*`. Rebuilt by the script; the feature path installs and verifies it before publishing, the import path publishes it directly. |
| `toqoz/main` | Integration branch: the published `toqoz/develop` commit. Its message is one bare gist URL. |
| `toqoz/ops` | Orphan branch holding this file and `sync.sh`. Never merged into the code. |

Hard rules:

- A `toqoz/feat/*` branch holds exactly one non-merge commit with a normal commit message.
- A commit whose subject is one bare gist URL is an integration commit, never a personal change.
- `toqoz/develop` and `toqoz/main` each hold exactly one commit on upstream and are rebuilt or moved by the script. Never commit on them by hand.
- `toqoz/main` is the same commit as `toqoz/develop` whenever it moves. `--push` (the import path) moves it without an install check; `--promote` (the feature path) moves it only for a `deepseek-harness-install` build of that commit and checks `ready/.dsh-rev`.
- The integration commit message is one bare gist URL and nothing else; the staging and integration commits are the same commit after promotion.
- The gist records what changed and why in Japanese, concisely. It summarizes and points here; this file is the only home of the procedure.
- A human edit to the gist that changes the procedure must land in this file in the same run.
- Nothing on `toqoz/ops` is rebased or merged; it has no common ancestor with upstream.

## Bootstrap

The script runs from any worktree, but DSH discovers this skill from the project root of the session's working directory. The main checkout is on `toqoz/main`, which does not contain `.agents/skills/dsh-personal-fork`, so link it locally once:

```sh
cd "$(git -C .git/wt/ops rev-parse --path-format=absolute --git-common-dir)/.."
ln -s ../../.git/wt/ops/.agents/skills/dsh-personal-fork .agents/skills/dsh-personal-fork
printf '.agents/skills/dsh-personal-fork\n' >> .git/info/exclude
```

The link is untracked and excluded locally; it survives branch switches and `git reset --hard`.

## Start a change

```sh
git fetch upstream shiguredo --prune
git switch -c toqoz/feat/<slug> upstream/shiguredo
# make the change, update its tests and docs, verify
git add -A
git commit -m "<commit message>"
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh
```

`sync.sh` (also spelled `--stage`) rebases every change onto upstream and rebuilds `toqoz/develop` as one squash commit. It touches neither `toqoz/main` nor the remote; that is the feature path. Routine publishing, including the upstream import, uses `--push` instead, which moves `main` to the same commit.

## Verify and promote

The staged generation is what you install and check; promotion then moves that exact commit, so a verified build becomes the released one without another install. A `--push` run already published `main` at the staging commit, so `--promote` has nothing left to do.

```sh
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --install
# … verify the running app …
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --promote
```

`--install` moves a clean checkout to the rebuilt `toqoz/develop`, runs `scripts/install.sh`, and restarts the service through `scripts/restart.sh`. Restarting drops live sessions, so it is a deliberate step.

`--promote` fast-forwards `toqoz/main` to the `toqoz/develop` commit and publishes both. It does not fetch, rebase, or rebuild, and it refuses unless `ready/.dsh-rev` (under `DEEPSEEK_HARNESS_HOME`, default `~/.local/share/deepseek-harness`) equals the staging commit, so on the feature path an uninstalled or rebuilt staging commit cannot reach `main`. `--force` skips that check.

Because the promoted commit is unchanged, `.dsh-rev` still identifies `toqoz/main` afterwards: no reinstall and no service restart are needed. A change made after verification means a new staging commit and a new install.

## Change an existing branch

```sh
git switch toqoz/feat/<slug>
# edit and verify
git add -A
git commit --amend --no-edit
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh
```

## Update the gist

`toqoz/develop` keeps the gist URL of the previous run. Rewrite the gist only when the personal delta changes materially, then rebuild the staging commit with the new URL:

```sh
gh gist edit <id> --filename deepseek-harness-toqoz-fork.md deepseek-harness-toqoz-fork.md   # last path is the local file
# or, for a new gist
gh gist create --public --desc "個人 fork の変更" --filename deepseek-harness-toqoz-fork.md - < deepseek-harness-toqoz-fork.md
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --message <gist-url>
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --promote --force
```

The gist is public; visibility is fixed at creation, so create a new gist (and repoint the commit message) if it was made secret by mistake. Write it in Japanese, short and factual: what changed, why, and how it was verified. Sections are optional; do not pad it.

## Import upstream

The scheduled task runs this; a human runs it the same way. It publishes the change branches, `toqoz/develop`, and `toqoz/main` at the same commit, so the release follows the import without an install step.

```sh
git fetch upstream shiguredo --prune
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --push
git switch toqoz/main
git reset --hard toqoz/main
pnpm exec vitest run packages/client packages/host
pnpm run typecheck
```

Add `--install` to the same run to build the imported checkout and restart the service; leaving it out publishes the branches only, and the running app keeps its generation.

`upstream/shiguredo` is a single squashed commit whose subject is one bare gist URL, and upstream replaces it on every update instead of appending. A change branch therefore still points at the previous upstream tip until the script rebases it. The script skips that stale tip when counting a change's commits and rebases only the change's own commit onto the current upstream, so importing needs no manual step; a conflicting rebase still leaves the temporary worktree.

The script:

1. fetches `upstream/shiguredo`;
2. refuses unless every `toqoz/feat/*` holds exactly one non-merge personal commit, not counting a stale upstream integration commit it sits on;
3. rebases each branch onto upstream in a temporary worktree, dropping that stale commit, and leaving a worktree behind when a rebase conflicts;
4. rebuilds `toqoz/develop` as upstream plus one squash commit of every `toqoz/feat/*` in a temporary worktree, reusing the gist URL of the previous run and discarding the rebuild when two branches overlap;
5. with `--push`, moves `toqoz/main` to the rebuilt staging commit and publishes the change branches, `toqoz/develop`, and `toqoz/main` with `--force-with-lease` and `--no-verify`;
6. with `--promote`, after checking the installed generation, moves `toqoz/main` to the already-built staging commit and publishes `toqoz/develop` and `toqoz/main` without fetching or rebuilding;
7. with `--install`, builds the staging commit with `scripts/install.sh` (moving a clean checkout to it first) and restarts the launchd service with `scripts/restart.sh`.

Publishing skips the repository pre-push hook because the ops worktree has no `package.json`; the checkout-and-verify step is the gate instead. `--push` releases `main` before the post-import tests run, which is why those tests must run and be reported; `--promote` checks the installed generation before the push.

## Install and generation store

`scripts/install.sh` builds the checkout HEAD into a generation:

- it refuses a dirty checkout and a HEAD that is neither `toqoz/main` nor `toqoz/develop` (`--if-publishable` skips instead of failing);
- it clones the commit into `$DEEPSEEK_HARNESS_HOME/builds/<version>-<UTC stamp>-<pid>` (default home `~/.local/share/deepseek-harness`), runs `pnpm install --frozen-lockfile` and `pnpm run build`, and smoke-tests `--version` and `web --help`;
- it publishes atomically by replacing the `ready` symlink and records the commit in `ready/.dsh-rev`;
- a failed build leaves the previous generation published.

`scripts/restart.sh` kickstarts `gui/<uid>/deepseek-harness`; it fails when the job is not loaded. Node, pnpm, and git come from `PATH` (`DSH_NODE`, `DSH_PNPM`, `DSH_GIT` override), because Nix provides them.

Run the script tests from this worktree:

```sh
node --test t/*.test.mts
```

## Publish and credentials

`git push` and `gh gist` both need GitHub authentication. Confirm it before a run that publishes:

```sh
gh auth status
```

If the token is invalid, stop and ask the operator to run `gh auth login`; do not invent a commit message to work around a missing gist.

The verification commands need the package manager to write its environment directory. When pnpm cannot create it, point `PNPM_HOME` at a writable directory.

## Conflict policy

- Upstream changed a file the branch also changed: resolve the rebase in the temporary worktree the script names, then remove that worktree and rerun.
- Upstream implemented the personal change: delete the `toqoz/feat/*` branch and drop that section from the gist.
- Two branches conflict with each other: fix the pair in the newer branch or split the shared part into its own branch; the rebuild is discarded on overlap, so nothing is left half-applied.
