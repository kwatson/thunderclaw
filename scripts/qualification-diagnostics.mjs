import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const phases = new Set(['setup', 'provider-install', 'onboard', 'agent-install', 'plugin-install', 'configure', 'gateway-start', 'gateway-restore', 'pairing-initial', 'credential-restart', 'revocation-restart', 'pairing-recovery', 'complete']);
const outcomes = new Set(['started', 'retry', 'ready', 'timeout', 'passed', 'failed']);
const categories = new Set(['connection', 'probe-timeout', 'http-status', 'protocol', 'process', 'unknown']);
const statuses = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

// Construct from an allowlist; never serialize errors, URLs, environment or command output.
export function diagnosticRecord(input) {
  if (!phases.has(input.phase) || !outcomes.has(input.outcome)) throw new Error('Invalid diagnostic event');
  const record = { schemaVersion: 1, phase: input.phase, outcome: input.outcome };
  for (const key of ['elapsedMs', 'attempts', 'qualificationExitCode', 'containerExitCode']) if (safeInteger(input[key])) record[key] = input[key];
  if (categories.has(input.category)) record.category = input.category;
  if (/^v?\d+\.\d+\.\d+$/u.test(input.nodeVersion ?? '')) record.nodeVersion = input.nodeVersion;
  if (/^\d+\.\d+\.\d+$/u.test(input.npmVersion ?? '')) record.npmVersion = input.npmVersion;
  if (statuses.has(input.containerStatus)) record.containerStatus = input.containerStatus;
  for (const key of ['containerRunning', 'oomKilled']) if (typeof input[key] === 'boolean') record[key] = input[key];
  return record;
}

export function writeQualificationDiagnostic(input, file = process.env.THUNDERCLAW_QUALIFICATION_DIAGNOSTICS) {
  if (!file) return;
  const record = diagnosticRecord(input);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function containerDiagnostic(container, run = spawnSync) {
  // Request only safe state fields. Even unexpected Docker output must pass validation.
  const result = run('docker', ['inspect', '--format', '{{.State.Status}} {{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', container], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096 });
  if (result.status !== 0 || result.error) return {};
  const match = /^(created|running|paused|restarting|removing|exited|dead) (true|false) (\d{1,3}) (true|false)\s*$/u.exec(result.stdout ?? '');
  if (!match) return {};
  return { containerStatus: match[1], containerRunning: match[2] === 'true', containerExitCode: Number(match[3]), oomKilled: match[4] === 'true' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, outcome, exitCode, container] = process.argv.slice(2);
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096 });
  writeQualificationDiagnostic({ phase, outcome, qualificationExitCode: Number(exitCode), nodeVersion: process.version,
    npmVersion: npm.status === 0 ? npm.stdout.trim() : undefined, ...(container ? containerDiagnostic(container) : {}) });
}
