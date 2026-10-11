import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
for (const pairingExit of [0, 7]) {
  test(`isolated hosted cleanup retains sanitized diagnostics for pairing exit ${pairingExit}`, async () => {
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
  exit ${pairingExit}
fi
`, { mode: 0o700 });
      await writeFile(join(directory, 'bin', 'docker'), `#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then
  printf '%s\\n' 'exited false 137 true'
fi
exit 0
`, { mode: 0o700 });
      await writeFile(join(directory, 'bin', 'npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "synthetic-secret-canary"\n', { mode: 0o700 });
      const result = spawnSync('bash', [join(directory, 'scripts', 'run-openclaw-ci.sh')], {
        env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, THUNDERCLAW_OPENCLAW_PLUGIN_TGZ: join(directory, 'candidate.tgz') },
        encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, pairingExit, result.stderr);
      const retained = join(directory, 'build', 'qualification-diagnostics');
      const [run] = await readdir(retained);
      const text = await readFile(join(retained, run!, 'diagnostics.jsonl'), 'utf8');
      const records = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const terminal = records.at(-1)!;
      assert.equal(terminal.outcome, pairingExit ? 'failed' : 'passed');
      assert.equal(terminal.phase, pairingExit ? 'pairing-initial' : 'complete');
      // qualification exit is distinct from Docker's exit diagnostic.
      assert.equal(terminal.containerExitCode, 137);
      assert.equal(terminal.qualificationExitCode, pairingExit);
      assert.equal(terminal.containerStatus, 'exited');
      assert.equal(terminal.oomKilled, true);
      assert.equal(records.filter((record) => record.phase === 'pairing-initial' && record.outcome === 'started').length, 1);
      assert.ok(records.some((record) => record.phase === 'gateway-start' && record.outcome === 'ready'));
      assert.doesNotMatch(text, /synthetic-secret-canary|synthetic-image-or-token|candidate\.tgz|\/tmp\//u);
      assert.deepEqual(await readdir(join(directory, 'build')), ['qualification-diagnostics']);
      assert.ok(await readFile(join(directory, 'candidate.tgz'), 'utf8'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
