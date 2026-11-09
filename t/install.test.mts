// Verify install.sh and restart.sh with a real checkout repository and stub
// node/pnpm inside a tempdir. The scripts read every path from the environment,
// so the tests drive production behavior unchanged.
//
// Run from the ops worktree root:
//   node --test t/*.test.mts

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = `${REPO}/.agents/skills/dsh-personal-fork/scripts`;
const INSTALL_SH = `${SCRIPTS}/install.sh`;
const RESTART_SH = `${SCRIPTS}/restart.sh`;

const VERSION = '0.0.0-test';

type RunResult = { status: number | null; stdout: string; stderr: string };

type World = {
  root: string;
  home: string;
  checkout: string;
  revA: string;
  revB: string;
  log: string;
  bin: string;
  env: NodeJS.ProcessEnv;
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

// Build a world: a checkout whose `toqoz/main` publishes revA while revB waits
// one commit behind, plus stub node/pnpm that log cwd and argv to STUB_LOG.
function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-'));
  const home = join(root, 'data');
  const checkout = join(root, 'checkout');
  const bin = join(root, 'bin');
  const log = join(root, 'stub.log');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(bin);

  git(checkout, 'init', '-b', 'toqoz/main');
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'test');
  mkdirSync(join(checkout, 'apps/cli/src'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'fixture', version: VERSION }, null, 2) + '\n');
  writeFileSync(join(checkout, 'apps/cli/src/bin.ts'), '// rev A\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'a');
  const revA = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'apps/cli/src/bin.ts'), '// rev B\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'b');
  const revB = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'reset', '--hard', revA);
  git(checkout, 'checkout', '-b', 'toqoz/feat/demo', revA);
  writeFileSync(join(checkout, 'apps/cli/src/bin.ts'), '// feature\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'feature');
  git(checkout, 'checkout', 'toqoz/main');

  const versionFile = join(root, 'cli-version');
  writeFileSync(versionFile, VERSION + '\n');

  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
{
  echo "node cwd=$PWD"
  echo "node state=\${DSH_HOME:-}"
  echo "node argv=$*"
} >> "$STUB_LOG"
if [ "$1" = '-e' ] || [ "$1" = '-p' ]; then exec '${process.execPath}' "$@"; fi
case " $* " in
  *" --version "*) printf '%s\\n' "\${STUB_CLI_VERSION:-$(cat "$CLI_VERSION_FILE")}" ;;
esac
exit "\${STUB_NODE_EXIT:-0}"
`,
  );
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env bash
echo "pnpm cwd=$PWD argv=$*" >> "$STUB_LOG"
case "$1" in
  install)
    if [ "\${STUB_PNPM_INSTALL_EXIT:-0}" -ne 0 ]; then exit "$STUB_PNPM_INSTALL_EXIT"; fi
    exit 0
    ;;
  run)
    mkdir -p apps/cli/lib
    cp apps/cli/src/bin.ts apps/cli/lib/bin.js
    exit "\${STUB_PNPM_RUN_EXIT:-0}"
    ;;
esac
exit 2
`,
  );
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'pnpm'), 0o755);

  return {
    root,
    home,
    checkout,
    revA,
    revB,
    log,
    bin,
    env: {
      ...process.env,
      DEEPSEEK_HARNESS_HOME: home,
      DSH_CHECKOUT: checkout,
      DSH_GIT: 'git',
      DSH_NODE: join(bin, 'node'),
      DSH_PNPM: join(bin, 'pnpm'),
      STUB_LOG: log,
      CLI_VERSION_FILE: versionFile,
    },
  };
}

function run(script: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): RunResult {
  const r = spawnSync('bash', [script, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
}

function attemptDirs(w: World): string[] {
  if (!existsSync(w.home)) return [];
  return readdirSync(w.home).filter((d) => d.startsWith('attempt.'));
}

test('install builds the checkout HEAD, runs frozen install/build/smoke, and publishes ready', () => {
  const w = makeWorld();
  const neutral = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cwd-')));

  const r = run(INSTALL_SH, [], { cwd: neutral, env: w.env });
  assert.equal(r.status, 0, r.stderr);

  const ready = join(w.home, 'ready');
  assert.ok(lstatSync(ready).isSymbolicLink(), 'ready must be a symlink');
  assert.match(readlinkSync(ready), /^builds\//);
  assert.equal(readFileSync(join(ready, '.dsh-rev'), 'utf8').trim(), w.revA);
  assert.equal(readFileSync(join(ready, 'apps/cli/src/bin.ts'), 'utf8'), '// rev A\n');
  assert.equal(readdirSync(join(w.home, 'builds')).length, 1);
  assert.equal(git(ready, 'rev-parse', 'HEAD'), w.revA);

  const log = readFileSync(w.log, 'utf8');
  assert.match(log, /argv=install --frozen-lockfile/);
  assert.match(log, /argv=run build/);
  assert.match(log, /node argv=\S+\/apps\/cli\/lib\/bin\.js --version/);
  assert.match(log, /node argv=\S+\/apps\/cli\/lib\/bin\.js web --help/);
  assert.deepEqual(attemptDirs(w), [], 'attempt dir must be removed after publish');
});

test('install is idempotent while the checkout HEAD is published', () => {
  const w = makeWorld();
  assert.equal(run(INSTALL_SH, [], { cwd: w.root, env: w.env }).status, 0);
  const logAfterFirst = readFileSync(w.log, 'utf8');
  const second = run(INSTALL_SH, [], { cwd: w.root, env: w.env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already installed/);
  assert.equal(readFileSync(w.log, 'utf8'), logAfterFirst, 'pnpm/node must not rerun');
  assert.equal(readdirSync(join(w.home, 'builds')).length, 1);
});

test('a failed install publishes nothing and cleans the attempt', () => {
  const w = makeWorld();
  const env = { ...w.env, STUB_PNPM_INSTALL_EXIT: '9' };

  const r = run(INSTALL_SH, [], { cwd: w.root, env });
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(join(w.home, 'ready')), 'no ready symlink may be published');
  assert.deepEqual(attemptDirs(w), [], 'attempt dir must be removed');
  assert.match(r.stderr, /failed; removed the attempt, prior ready build untouched/);
});

test('a failed rebuild preserves the prior ready build', () => {
  const w = makeWorld();
  assert.equal(run(INSTALL_SH, [], { cwd: w.root, env: w.env }).status, 0);
  const readyTarget = readlinkSync(join(w.home, 'ready'));

  git(w.checkout, 'reset', '--hard', w.revB);
  const r = run(INSTALL_SH, [], { cwd: w.root, env: { ...w.env, STUB_PNPM_RUN_EXIT: '7' } });
  assert.notEqual(r.status, 0);

  assert.equal(readlinkSync(join(w.home, 'ready')), readyTarget);
  assert.equal(readFileSync(join(w.home, 'ready/.dsh-rev'), 'utf8').trim(), w.revA);
  assert.equal(readdirSync(join(w.home, 'builds')).length, 1);
  assert.deepEqual(attemptDirs(w), []);
});

test('a successful upgrade replaces the ready symlink without modifying the prior generation', () => {
  const w = makeWorld();
  assert.equal(run(INSTALL_SH, [], { cwd: w.root, env: w.env }).status, 0);
  const prior = realpathSync(join(w.home, 'ready'));

  git(w.checkout, 'reset', '--hard', w.revB);
  const result = run(INSTALL_SH, [], { cwd: w.root, env: w.env });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(realpathSync(join(w.home, 'ready')), prior);
  assert.equal(readFileSync(join(w.home, 'ready/.dsh-rev'), 'utf8').trim(), w.revB);
  assert.equal(readFileSync(join(prior, '.dsh-rev'), 'utf8').trim(), w.revA);
});

test('install refuses a dirty checkout, and --if-publishable skips instead', () => {
  const w = makeWorld();
  writeFileSync(join(w.checkout, 'scratch.txt'), 'x');

  const strict = run(INSTALL_SH, [], { cwd: w.root, env: w.env });
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /uncommitted changes/);

  const lenient = run(INSTALL_SH, ['--if-publishable'], { cwd: w.root, env: w.env });
  assert.equal(lenient.status, 0, lenient.stderr);
  assert.match(lenient.stderr, /skipping/);
  assert.ok(!existsSync(join(w.home, 'ready')));
});

test('install refuses a checkout outside toqoz/main and toqoz/develop', () => {
  const w = makeWorld();
  git(w.checkout, 'checkout', 'toqoz/feat/demo');

  const r = run(INSTALL_SH, [], { cwd: w.root, env: w.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not toqoz\/main or toqoz\/develop/);
  assert.ok(!existsSync(join(w.home, 'ready')));
});

test('install accepts a staged toqoz/develop commit', () => {
  const w = makeWorld();
  git(w.checkout, 'checkout', '-b', 'toqoz/develop', w.revA);
  git(w.checkout, 'reset', '--hard', w.revB);

  const r = run(INSTALL_SH, [], { cwd: w.root, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(w.home, 'ready/.dsh-rev'), 'utf8').trim(), w.revB);
});

test('a failed smoke does not publish', () => {
  const w = makeWorld();
  const r = run(INSTALL_SH, [], { cwd: w.root, env: { ...w.env, STUB_CLI_VERSION: '9.9.9-wrong' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /expected version/);
  assert.ok(!existsSync(join(w.home, 'ready')));
  assert.deepEqual(attemptDirs(w), []);
});

test('restart kickstarts the loaded service', () => {
  const w = makeWorld();
  const calls = join(w.root, 'launchctl-called');
  writeFileSync(
    join(w.bin, 'launchctl'),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}.log"
[ "$1" = print ] && exit "\${STUB_PRINT_EXIT:-0}"
exit 0
`,
  );
  chmodSync(join(w.bin, 'launchctl'), 0o755);

  const r = run(RESTART_SH, [], {
    cwd: w.root,
    env: { ...w.env, PATH: `${w.bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(`${calls}.log`, 'utf8');
  assert.match(log, /^print gui\/\d+\/deepseek-harness$/m);
  assert.match(log, /^kickstart -k gui\/\d+\/deepseek-harness$/m);
});

test('restart fails when the service is not loaded', () => {
  const w = makeWorld();
  writeFileSync(join(w.bin, 'launchctl'), '#!/usr/bin/env bash\nexit 3\n');
  chmodSync(join(w.bin, 'launchctl'), 0o755);

  const r = run(RESTART_SH, [], {
    cwd: w.root,
    env: { ...w.env, PATH: `${w.bin}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not loaded/);
});
