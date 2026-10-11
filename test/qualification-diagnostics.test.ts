import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { containerDiagnostic, diagnosticRecord, writeQualificationDiagnostic } from '../scripts/qualification-diagnostics.mjs';

const secret = 'synthetic-secret-canary';
test('diagnostic records reconstruct allowed fields and discard secret-bearing extras', () => {
  const record = diagnosticRecord({ phase: 'credential-restart', outcome: 'timeout', attempts: 24, elapsedMs: 120000,
    category: 'connection', nodeVersion: 'v24.19.0', npmVersion: '12.1.0', error: secret, url: `https://${secret}`,
    env: { TOKEN: secret }, headers: { authorization: secret }, message: secret, containerStatus: secret,
    containerExitCode: secret, oomKilled: secret });
  assert.deepEqual(record, { schemaVersion: 1, phase: 'credential-restart', outcome: 'timeout', elapsedMs: 120000,
    attempts: 24, category: 'connection', nodeVersion: 'v24.19.0', npmVersion: '12.1.0' });
  assert.doesNotMatch(JSON.stringify(record), /synthetic-secret/u);
  assert.throws(() => diagnosticRecord({ phase: secret, outcome: 'failed' }), /Invalid diagnostic/u);
});

test('container inspection is bounded, narrow, and fails closed on unexpected output', () => {
  const calls: unknown[][] = [];
  const run = (...args: unknown[]) => { calls.push(args); return { status: 0, stdout: 'exited false 137 true\n' }; };
  assert.deepEqual(containerDiagnostic('test-container', run), { containerStatus: 'exited', containerRunning: false, containerExitCode: 137, oomKilled: true });
  const args = calls[0]!;
  assert.equal(args[0], 'docker');
  assert.deepEqual(args[2], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.doesNotMatch(JSON.stringify(args), /Config|Env|Logs|Error/u);
  for (const result of [{ status: 0, stdout: secret }, { status: 1, stdout: 'running true 0 false', stderr: secret },
    { status: 0, stdout: 'running true 0 false', error: new Error(secret) }]) {
    assert.deepEqual(containerDiagnostic('test-container', () => result), {});
  }
});

test('retained evidence contains only allowlisted JSON even with secret canaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderclaw-safe-diagnostics-'));
  try {
    const file = join(directory, 'diagnostics.jsonl');
    writeQualificationDiagnostic({ phase: 'pairing-initial', outcome: 'failed', error: secret, nodeVersion: secret }, file);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schemaVersion: 1, phase: 'pairing-initial', outcome: 'failed' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
