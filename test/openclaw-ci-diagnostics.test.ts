import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
// Exercise macOS's system Bash even if a newer shell is installed on PATH.
const bash = process.platform === 'darwin' ? '/bin/bash' : 'bash';
for (const scenario of [
  { name: 'pairing exit 0', pairingExit: 0, candidate: 'present', exit: 0, phase: 'complete' },
  { name: 'pairing exit 7', pairingExit: 7, candidate: 'present', exit: 7, phase: 'pairing-initial' },
  { name: 'unset candidate path', pairingExit: 0, candidate: 'unset', exit: 2, phase: 'setup' },
  { name: 'empty candidate path', pairingExit: 0, candidate: 'empty', exit: 2, phase: 'setup' },
]) {
  test(`isolated hosted cleanup retains sanitized diagnostics for ${scenario.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'thunderclaw-ci-diagnostics-'));
    try {
      await mkdir(join(directory, 'scripts'));
      await mkdir(join(directory, 'bin'));
      for (const file of ['run-openclaw-ci.sh', 'qualification-diagnostics.mjs', 'qualify-gateway-startup.ts', 'qualification-readiness.ts']) {
        await cp(new URL(`scripts/${file}`, root), join(directory, 'scripts', file));
      }
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await symlink(new URL('node_modules', root).pathname, join(directory, 'node_modules'));
      await writeFile(join(directory, 'candidate.tgz'), 'synthetic candidate');
      // Fake external commands; the actual diagnostic writer and bounded startup CLI run unchanged.
      await writeFile(join(directory, 'bin', 'mise'), `#!/usr/bin/env bash
set -eu
shift 2
if [[ "$*" == 'node -e '* ]]; then
  printf '%s' 'synthetic-image-or-token'
elif [[ "$*" == 'node scripts/qualification-diagnostics.mjs '* || "$*" == 'node --import tsx scripts/qualify-gateway-startup.ts' ]]; then
  exec '${process.execPath}' "\${@:2}"
elif [[ "$*" == 'npm run qualify:pairing -- --no-install' ]]; then
  exit ${scenario.pairingExit}
fi
`, { mode: 0o700 });
      await writeFile(join(directory, 'bin', 'docker'), `#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then
  printf '%s\\n' 'exited false 137 true'
fi
exit 0
`, { mode: 0o700 });
      await writeFile(join(directory, 'bin', 'npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "synthetic-secret-canary"\n', { mode: 0o700 });
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, THUNDERCLAW_OPENCLAW_PLUGIN_TGZ: join(directory, 'candidate.tgz') };
      if (scenario.candidate === 'unset') delete env.THUNDERCLAW_OPENCLAW_PLUGIN_TGZ;
      if (scenario.candidate === 'empty') env.THUNDERCLAW_OPENCLAW_PLUGIN_TGZ = '';
      const result = spawnSync(bash, [join(directory, 'scripts', 'run-openclaw-ci.sh')], {
        env,
        encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, scenario.exit, result.stderr);
      if (scenario.candidate !== 'present') {
        assert.match(result.stderr, /THUNDERCLAW_OPENCLAW_PLUGIN_TGZ must name an existing candidate archive/u);
        assert.doesNotMatch(result.stderr, /unbound variable|conditional binary operator/u);
      }
      const retained = join(directory, 'build', 'qualification-diagnostics');
      const [run] = await readdir(retained);
      const text = await readFile(join(retained, run!, 'diagnostics.jsonl'), 'utf8');
      const records = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const terminal = records.at(-1)!;
      assert.equal(terminal.outcome, scenario.exit ? 'failed' : 'passed');
      assert.equal(terminal.phase, scenario.phase);
      // qualification exit is distinct from Docker's exit diagnostic.
      assert.equal(terminal.containerExitCode, 137);
      assert.equal(terminal.qualificationExitCode, scenario.exit);
      assert.equal(terminal.containerStatus, 'exited');
      assert.equal(terminal.oomKilled, true);
      assert.equal(records.filter((record) => record.phase === 'pairing-initial' && record.outcome === 'started').length, scenario.candidate === 'present' ? 1 : 0);
      assert.equal(records.some((record) => record.phase === 'gateway-start' && record.outcome === 'ready'), scenario.candidate === 'present');
      assert.doesNotMatch(text, /synthetic-secret-canary|synthetic-image-or-token|candidate\.tgz|\/tmp\//u);
      assert.deepEqual(await readdir(join(directory, 'build')), ['qualification-diagnostics']);
      assert.ok(await readFile(join(directory, 'candidate.tgz'), 'utf8'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
