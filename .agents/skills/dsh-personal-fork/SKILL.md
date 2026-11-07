---
name: dsh-personal-fork
description: Use when creating, updating, rebasing, or publishing a personal change in the toqoz/deepseek-harness fork, when importing a new shiguredo upstream into it, or when resolving the fork's branch conflicts.
---

# Personal fork operation

This checkout is a personal fork of [shiguredo/deepseek-harness](https://github.com/shiguredo/deepseek-harness). The procedure and its script live on the orphan branch `toqoz/ops`, mounted in the worktree `.git/wt/ops`; they are never merged into the code.

## Branch model

| Ref | Meaning |
| --- | --- |
| `upstream/shiguredo` | The only upstream. Fetched from `https://github.com/shiguredo/deepseek-harness`. |
| `toqoz/feat/<slug>` | One personal change: exactly one commit on the current upstream, with an ordinary commit message. |
| `toqoz/main` | Integration branch: upstream plus one commit holding every `toqoz/feat/*`. Its message is one bare gist URL. |
| `toqoz/ops` | Orphan branch holding this file and `sync.sh`. Never merged into the code. |

Hard rules:

- A `toqoz/feat/*` branch holds exactly one non-merge commit with a normal commit message.
- A commit whose subject is one bare gist URL is an integration commit, never a personal change.
- `toqoz/main` holds exactly one commit on upstream and is rebuilt by the script. Never commit on it by hand.
- The `toqoz/main` commit message is one bare gist URL and nothing else.
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
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --push
```

Then bring the checkout you run from up to date and verify:

```sh
git reset --hard toqoz/main
pnpm exec vitest run packages/client packages/host
pnpm run typecheck
```

`sync.sh` never moves the caller's checkout; the reset is what applies the rebuild.

## Change an existing branch

```sh
git switch toqoz/feat/<slug>
# edit and verify
git add -A
git commit --amend --no-edit
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --push
git reset --hard toqoz/main
```

## Update the gist

`toqoz/main` keeps the gist URL of the previous run. Rewrite the gist only when the personal delta changes materially, then rebuild with the new URL:

```sh
gh gist edit <id> --filename deepseek-harness-toqoz-fork.md deepseek-harness-toqoz-fork.md   # last path is the local file
# or, for a new gist
gh gist create --public --desc "個人 fork の変更" --filename deepseek-harness-toqoz-fork.md - < deepseek-harness-toqoz-fork.md
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --message <gist-url> --push
```

The gist is public; visibility is fixed at creation, so create a new gist (and repoint the commit message) if it was made secret by mistake. Write it in Japanese, short and factual: what changed, why, and how it was verified. Sections are optional; do not pad it.

## Import upstream

The scheduled task runs this; a human runs it the same way.

```sh
git fetch upstream shiguredo --prune
.git/wt/ops/.agents/skills/dsh-personal-fork/scripts/sync.sh --push
git reset --hard toqoz/main
pnpm exec vitest run packages/client packages/host
pnpm run typecheck
```

`upstream/shiguredo` is a single squashed commit whose subject is one bare gist URL, and upstream replaces it on every update instead of appending. A change branch therefore still points at the previous upstream tip until the script rebases it. The script skips that stale tip when counting a change's commits and rebases only the change's own commit onto the current upstream, so importing needs no manual step; a conflicting rebase still leaves the temporary worktree.

The script:

1. fetches `upstream/shiguredo`;
2. refuses unless every `toqoz/feat/*` holds exactly one non-merge personal commit, not counting a stale upstream integration commit it sits on;
3. rebases each branch onto upstream in a temporary worktree, dropping that stale commit, and leaving a worktree behind when a rebase conflicts;
4. rebuilds `toqoz/main` as upstream plus one squash commit of every `toqoz/feat/*` in a temporary worktree, reusing the gist URL of the previous run and discarding the rebuild when two branches overlap;
5. with `--push`, publishes each branch with `--force-with-lease` and `--no-verify`.

Publishing skips the repository pre-push hook because the ops worktree has no `package.json`; the reset-and-verify step above is the gate instead, and it runs after the push.

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
