import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClawHubPendingError, verifyClawHubRelease } from '../scripts/verify-marketplace-notes.mjs';

test('public verification progresses pending to clean and fails immutable mismatches immediately', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'thunderclaw-public-progress-'));
  try {
    const artifact = path.join(directory, 'plugin.tgz');
    const bytes = Buffer.from('synthetic qualified plugin');
    await writeFile(artifact, bytes);
    const options = { packageName: '@thunderclaw/openclaw-plugin', version: '1.2.3', artifact, repository: 'owner/repo', tag: 'openclaw-plugin-v1.2.3', commit: 'a'.repeat(40), timeoutMs: 500, requestTimeoutMs: 50, pollIntervalMs: 1 };
    const payload = { package: { name: options.packageName }, version: { version: options.version, artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }, verification: { sourceRepo: options.repository, sourceTag: options.tag, sourceCommit: options.commit, scanStatus: 'pending' } } };
    let attempts = 0;
    const result = await verifyClawHubRelease({ ...options, fetchImpl: async (url) => {
      if (String(url).endsWith('/artifact/download')) return new Response(bytes);
      attempts++;
      if (attempts === 1) return new Response('', { status: 503 });
      return Response.json({ ...payload, version: { ...payload.version, verification: { ...payload.version.verification, scanStatus: attempts > 2 ? 'clean' : 'pending' } } });
    } });
    assert.equal(result.artifactVerified, true); assert.equal(attempts, 3);
    for (const patch of [ { verification: { ...payload.version.verification, sourceCommit: 'b'.repeat(40), scanStatus: 'pending' } }, { artifact: { ...payload.version.artifact, size: 1 } }, { verification: { ...payload.version.verification, scanStatus: 'rejected' } } ]) {
      let calls = 0;
      await assert.rejects(verifyClawHubRelease({ ...options, fetchImpl: async () => { calls++; return Response.json({ ...payload, version: { ...payload.version, ...patch } }); } }), (error: any) => !(error instanceof ClawHubPendingError));
      assert.equal(calls, 1);
    }
    for (const fetchImpl of [async () => new Promise<Response>(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response]) {
      const started = Date.now();
      await assert.rejects(verifyClawHubRelease({ ...options, timeoutMs: 0, requestTimeoutMs: 20, fetchImpl }), ClawHubPendingError);
      assert.ok(Date.now() - started < 500, 'stalled connection/body must have a bounded deadline');
    }
    await assert.rejects(verifyClawHubRelease({ ...options, timeoutMs: 0, fetchImpl: async () => new Response('', { status: 404 }) }), ClawHubPendingError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
