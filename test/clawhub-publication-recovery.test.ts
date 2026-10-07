import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { assessClawHubPublisher, findOriginalClawHubPublisher, selectOriginalClawHubPublisher } from '../scripts/clawhub-publication-recovery.mjs';
import { parseMarketplaceVerificationArguments } from '../scripts/verify-marketplace-notes.mjs';

const identity = { repository: 'kwatson/thunderclaw', tag: 'openclaw-plugin-v0.1.16', commit: 'a'.repeat(40) };
const run = { id: 123, repository: { full_name: identity.repository }, event: 'workflow_dispatch',
  path: '.github/workflows/publish-clawhub.yml', head_sha: identity.commit, head_branch: identity.tag,
  status: 'completed', conclusion: 'failure' };
const accepted = { name: '@thunderclaw/openclaw-plugin', version: '0.1.16',
  attemptId: 'attempt-123', releaseId: 'release-456', publicationStatus: 'pending' };

test('accepted scan timeout and lost publisher response resume reads without another upload', () => {
  assert.equal(assessClawHubPublisher({ ...identity, run, submission: accepted }), 'verify-public');
  assert.equal(assessClawHubPublisher({ ...identity, run, submission: { ...accepted, publicationStatus: 'published' } }), 'verify-public');
  assert.equal(assessClawHubPublisher({ ...identity, run, submission: { publicationStatus: 'client-unconfirmed' } }), 'verify-public');
});

test('permanent rejection, cancellation, and missing evidence fail immediately', () => {
  for (const submission of [undefined, {}, { publicationStatus: 'client-rejected' },
    { ...accepted, name: 'another-plugin' }, { ...accepted, version: '0.1.17' },
    { ...accepted, attemptId: undefined }, { ...accepted, releaseId: undefined },
    { ...accepted, publicationStatus: 'rejected' }]) {
    assert.throws(() => assessClawHubPublisher({ ...identity, run, submission }), /explicit operator recovery/u);
  }
  assert.throws(() => assessClawHubPublisher({ ...identity, run: { ...run, conclusion: 'cancelled' }, submission: accepted }), /cancelled/u);
});

test('publisher recovery authenticates the run before trusting success or retained submission', () => {
  for (const patch of [{ repository: { full_name: 'someone/fork' } }, { event: 'push' },
    { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) },
    { head_branch: 'main' }, { id: 0 }]) {
    assert.throws(() => assessClawHubPublisher({ ...identity, run: { ...run, ...patch, conclusion: 'success' }, submission: accepted }), /exact protected-tag/u);
  }
  assert.equal(assessClawHubPublisher({ ...identity, run: { ...run, conclusion: 'success' } }), 'complete');
  assert.equal(assessClawHubPublisher({ ...identity, run: { ...run, status: 'in_progress', conclusion: null } }), 'await');
});

test('finalizer consumes failure evidence and verifies pinned bytes instead of rerunning publisher', async () => {
  const workflow = await readFile(new URL('../.github/workflows/complete-plugin-publication.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /gh run rerun/u);
  assert.match(workflow, /gh run download "\$run_id"/u);
  assert.match(workflow, /scripts\/clawhub-publication-recovery\.mjs/u);
  assert.match(workflow, /RELEASE_SHA256: \$\{\{ needs\.verify\.outputs\.sha256 \}\}/u);
  assert.match(workflow, /sha256sum --check --strict/u);
  assert.match(workflow, /if \[\[ "\$action" == verify-public \]\]; then/u);
  assert.match(workflow, /scripts\/verify-marketplace-notes\.mjs/u);
});

test('marketplace CLI accepts bounded read-only timeouts and rejects unsafe budgets', () => {
  const args = ['--package', '@thunderclaw/openclaw-plugin', '--version', '0.1.16',
    '--notes-file', 'notes.md', '--artifact', 'plugin.tgz', '--repository', identity.repository,
    '--tag', identity.tag, '--commit', identity.commit];
  assert.equal(parseMarketplaceVerificationArguments(args).timeoutMs, undefined);
  for (const value of ['0', '300000', '3600000']) {
    assert.equal(parseMarketplaceVerificationArguments([...args, '--timeout-ms', value]).timeoutMs, Number(value));
  }
  for (const value of ['-1', 'NaN', '1.5', '3600001', '999999999999999999999', '01']) {
    assert.throws(() => parseMarketplaceVerificationArguments([...args, '--timeout-ms', value]), /timeout must be an integer/u);
  }
});

test('late publisher failures consume the remaining parent budget rather than starting another hour', async () => {
  const workflow = await readFile(new URL('../.github/workflows/complete-plugin-publication.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('                remaining_seconds=$((publication_deadline - SECONDS))');
  const end = workflow.indexOf('                timeout --kill-after=10s', start);
  assert.ok(start > 0 && end > start);
  const budget = workflow.slice(start, end);
  for (const [elapsed, expected] of [[0, '3600'], [4500, '300']] as const) {
    assert.equal(execFileSync('bash', ['-c', `publication_deadline=4800; SECONDS=${elapsed};\n${budget}\nprintf '%s' "$verification_seconds"`], { encoding: 'utf8' }), expected);
  }
  const exhausted = spawnSync('bash', ['-c', `publication_deadline=4800; SECONDS=4800;\n${budget}`], { encoding: 'utf8' });
  assert.equal(exhausted.status, 75);
  assert.match(exhausted.stdout, /resume read-only verification/u);
  assert.match(workflow, /timeout --kill-after=10s "\$\{remaining_seconds\}s"/u);
  assert.match(workflow, /--timeout-ms "\$\(\(verification_seconds \* 1000\)\)"/u);
});

test('known rejection overrides even a successful publisher conclusion', () => {
  assert.throws(() => assessClawHubPublisher({ ...identity, run: { ...run, conclusion: 'success' }, submission: { publicationStatus: 'client-rejected' } }), /rejected/u);
});

test('paginated original publisher survives more than 100 unrelated runs and prevents duplicate dispatch after a 404 probe', async () => {
  const unrelated = Array.from({ length: 125 }, (_, index) => ({ ...run, id: index + 200, head_branch: `unrelated-${index}`, head_sha: 'b'.repeat(40) }));
  const pages = [{ workflow_runs: unrelated.slice(0, 100) }, { workflow_runs: [...unrelated.slice(100), run] }];
  const execute = (_command: string, args: string[]) => {
    assert.ok(args.includes('--paginate')); assert.ok(args.includes('--slurp'));
    return JSON.stringify(pages);
  };
  assert.equal(findOriginalClawHubPublisher(identity, execute).id, run.id);
  assert.throws(() => selectOriginalClawHubPublisher([run, { ...run, id: 124 }], identity), /Ambiguous/u);
  for (const patch of [{ repository: { full_name: 'wrong/repo' } }, { event: 'push' }, { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) }]) {
    assert.throws(() => selectOriginalClawHubPublisher([{ ...run, ...patch }], identity), /exact protected-tag/u);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'thunderclaw-publisher-history-'));
  try {
    await writeFile(path.join(directory, 'pages.json'), JSON.stringify(pages));
    const gh = path.join(directory, 'gh');
    await writeFile(gh, '#!/bin/sh\nif [ "$1" = api ]; then cat "$THUNDERCLAW_TEST_PAGES"; else echo unexpected-upload >&2; exit 99; fi\n');
    await chmod(gh, 0o755);
    const workflow = await readFile(new URL('../.github/workflows/complete-plugin-publication.yml', import.meta.url), 'utf8');
    const step = workflow.indexOf('      - name: Dispatch and await');
    const start = workflow.indexOf('          set -euo pipefail', step);
    const end = workflow.indexOf('          for _ in', start);
    const script = workflow.slice(start, end) + '\nprintf "%s" "$run"';
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, THUNDERCLAW_TEST_PAGES: path.join(directory, 'pages.json'), GITHUB_REPOSITORY: identity.repository, RELEASE_TAG: identity.tag, RELEASE_COMMIT: identity.commit, PUBLISHER_READ_TOKEN: 'synthetic-read-token' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).id, run.id);
    await writeFile(path.join(directory, 'pages.json'), JSON.stringify([{ workflow_runs: [run, { ...run, id: 124 }] }]));
    const ambiguous = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, THUNDERCLAW_TEST_PAGES: path.join(directory, 'pages.json'), GITHUB_REPOSITORY: identity.repository, RELEASE_TAG: identity.tag, RELEASE_COMMIT: identity.commit, PUBLISHER_READ_TOKEN: 'synthetic-read-token' } });
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /Ambiguous/u);
    assert.doesNotMatch(ambiguous.stderr, /unexpected-upload/u);
    assert.equal((workflow.match(/scripts\/clawhub-publication-recovery\.mjs find/g) ?? []).length, 2, 'probe and dispatch share the same selector');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
