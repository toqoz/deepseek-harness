# toqoz/ops

This orphan branch holds the tooling for the personal fork of
[shiguredo/deepseek-harness](https://github.com/shiguredo/deepseek-harness). It
is never merged into the code; `toqoz/develop` is upstream plus the personal
changes, `toqoz/main` is the verified `toqoz/develop` commit, and
`toqoz/feat/*` holds one change each.

It is mounted in the worktree `.git/wt/ops`. Recreate it after a fresh clone:

```sh
git fetch origin 'refs/heads/toqoz/*:refs/remotes/origin/toqoz/*'
git worktree add .git/wt/ops toqoz/ops
ln -s ../../.git/wt/ops/.agents/skills/dsh-personal-fork .agents/skills/dsh-personal-fork
printf '.agents/skills/dsh-personal-fork\n' >> .git/info/exclude
```

The link lets DSH discover the skill from the main checkout. After a fresh
clone, also recreate `CLAUDE.local.md` (gitignored) with a short pointer to
this skill: DSH injects `.local` overlays into every session whose working
directory is the checkout, so a new session starts with the branch model in
context instead of committing straight to a code branch.

The procedure is `.agents/skills/dsh-personal-fork/SKILL.md`; the entry point is
`scripts/sync.sh`. The Nix configuration (`~/src/github.com/toqoz/config`)
provides the pinned Node and pnpm, the launchd service, and the data
directories; this branch owns the app build (`scripts/install.sh`), the
generation store, and the restart (`scripts/restart.sh`).

Script tests run from this worktree:

```sh
node --test t/*.test.mts
```

The main checkout excludes the skill symlink through `.git/info/exclude`, which
also hides new files under this skill in every worktree. Add them with
`git add -f`.
