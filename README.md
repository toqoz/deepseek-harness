# toqoz/ops

This orphan branch holds the tooling for the personal fork of
[shiguredo/deepseek-harness](https://github.com/shiguredo/deepseek-harness). It
is never merged into the code; `toqoz/main` is upstream plus the personal
changes, and `toqoz/feat/*` holds one change each.

It is mounted in the worktree `.git/wt/ops`. Recreate it after a fresh clone:

```sh
git fetch origin 'refs/heads/toqoz/*:refs/remotes/origin/toqoz/*'
git worktree add .git/wt/ops toqoz/ops
ln -s ../../.git/wt/ops/.agents/skills/dsh-personal-fork .agents/skills/dsh-personal-fork
printf '.agents/skills/dsh-personal-fork\n' >> .git/info/exclude
```

The link lets DSH discover the skill from the main checkout.

The procedure is `.agents/skills/dsh-personal-fork/SKILL.md`; the entry point is
`scripts/sync.sh`.
