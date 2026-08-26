#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const compose = ["compose", "-f", "compose.spike.yaml"];
const qualificationContainer = process.env.THUNDERCLAW_QUALIFICATION_CONTAINER;
const qualificationStateRoot = process.env.THUNDERCLAW_QUALIFICATION_STATE_ROOT;
const qualificationGatewayImage = process.env.THUNDERCLAW_QUALIFICATION_GATEWAY_IMAGE
  ?? "ghcr.io/openclaw/openclaw:2026.8.1-beta.3";
if (Boolean(qualificationContainer) !== Boolean(qualificationStateRoot)) {
  throw new Error("container qualification requires both its container and state root");
}
const stateRoot = qualificationStateRoot ? resolve(qualificationStateRoot) : join(root, ".spike", "thunderclaw-openclaw");
const openClawConfig = join(stateRoot, "openclaw.json");
const dryRun = process.argv.includes("--dry-run");
const noInstall = process.argv.includes("--no-install");
const selfTestRollback = process.argv.includes("--self-test-rollback");
const allowedArguments = new Set(["--dry-run", "--no-install", "--self-test-rollback"]);

if (process.argv.slice(2).some((value) => !allowedArguments.has(value))) {
  throw new Error("usage: qualify-pairing.ts [--dry-run | --no-install | --self-test-rollback]");
}
if ([dryRun, noInstall, selfTestRollback].filter(Boolean).length > 1) throw new Error("qualification modes are mutually exclusive");

type CommandOptions = { cwd?: string; input?: string; allowFailure?: boolean };

function redact(value: string): string {
  return value
    .replace(/(authorization|credential|password|secret|token)(\s*[=:]\s*)[^\s,}"]+/giu, "$1$2[REDACTED]")
    .replace(/Bearer\s+[^\s,}"]+/giu, "Bearer [REDACTED]");
}

function command(program: string, args: string[], options: CommandOptions = {}): string {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
    throw new Error(`${program} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function docker(...args: string[]): string {
  if (qualificationContainer) {
    const [operation, ...rest] = args;
    if (operation === "exec" && rest[0] === "-T" && rest[1] === "gateway") {
      return command("docker", ["exec", qualificationContainer, ...rest.slice(2)]);
    }
    if (operation === "restart" && rest.length === 1 && rest[0] === "gateway") {
      return command("docker", ["restart", qualificationContainer]);
    }
    if (operation === "logs" && rest.at(-1) === "gateway") {
      return command("docker", ["logs", ...rest.slice(0, -1), qualificationContainer]);
    }
    if (operation === "port" && rest[0] === "gateway" && rest[1] === "18789") {
      return command("docker", ["port", qualificationContainer, "18789/tcp"]);
    }
    throw new Error(`unsupported container qualification Docker operation: ${args.join(" ")}`);
  }
  return command("docker", [...compose, ...args]);
}

function inspectGateway(): void {
  if (qualificationContainer) {
    const running = command("docker", ["inspect", "--format", "{{.State.Running}}", qualificationContainer]).trim();
    if (running !== "true") throw new Error("the pinned Gateway container must already be running");
    const actualImage = command("docker", ["inspect", "--format", "{{.Image}}", qualificationContainer]).trim();
    const expectedImage = command("docker", ["image", "inspect", "--format", "{{.Id}}", qualificationGatewayImage]).trim();
    if (actualImage !== expectedImage) throw new Error("the Gateway container does not use the pinned image");
    docker("logs", "--tail=120", "gateway");
    gatewayCall("health", {});
    return;
  }
  const ps = docker("ps", "--format", "json").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const gateway = ps.find((entry) => entry.Service === "gateway");
  if (!gateway || !String(gateway.State ?? "").toLowerCase().includes("running")) {
    throw new Error("the pinned Gateway must already be running");
  }
  const image = String(gateway.Image ?? "");
  if (image !== "ghcr.io/openclaw/openclaw:2026.8.1-beta.3") {
    throw new Error(`unexpected Gateway image: ${image || "unknown"}`);
  }
  // Read before mutation as an operational safety check. Never print raw logs.
  docker("logs", "--tail=120", "gateway");
  gatewayCall("health", {});
}

function gatewayCall(method: string, params: Record<string, unknown>): unknown {
  const output = docker(
    "exec", "-T", "gateway", "node", "openclaw.mjs", "gateway", "call", method,
    "--json", "--params", JSON.stringify(params),
  );
  try { return JSON.parse(output); }
  catch { throw new Error(`Gateway method ${method} returned non-JSON output`); }
}

async function waitForGatewayHealth(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker("exec", "-T", "gateway", "node", "openclaw.mjs", "gateway", "call", "health", "--json");
      return;
    } catch { /* Gateway restart is still settling. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("the restored Gateway did not become healthy");
}

function packCandidate(): string {
  mkdirSync(join(root, "build"), { recursive: true });
  const output = command("mise", ["exec", "--", "node", "scripts/package-openclaw-plugin.mjs"], { cwd: root });
  const reportedArchive = output.trim().split("\n").at(-1);
  if (!reportedArchive) throw new Error("plugin packager did not report an archive");
  const archive = resolve(reportedArchive);
  if (join(root, "build", basename(archive)) !== archive || !archive.endsWith(".tgz")) {
    throw new Error("plugin packager did not report a safe archive path");
  }
  if (!existsSync(archive)) throw new Error("candidate plugin archive was not created");
  return archive;
}

function waitForPairingStatus(origin: string): Promise<void> {
  return retry(async () => {
    const response = await fetch(`${origin}/thunderclaw/pairing/v1/status`, {
      redirect: "error",
      headers: { connection: "close" },
    });
    if (!response.ok) throw new Error(`pairing status returned HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (body.protocolVersion !== 1 || body.pairingAvailable !== true) throw new Error("pairing v1 is unavailable");
  });
}

async function retry(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await operation(); return; } catch (error) { lastError = error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw lastError;
}

function endpoint(): string {
  const configured = process.env.THUNDERCLAW_PAIRING_ORIGIN;
  if (configured) {
    const parsed = new URL(configured);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new Error("THUNDERCLAW_PAIRING_ORIGIN must be an HTTP(S) origin with no credentials or path");
    }
    return parsed.origin;
  }
  const binding = docker("port", "gateway", "18789").trim().split("\n")[0];
  const match = /^(.*):(\d+)$/u.exec(binding ?? "");
  if (!match) throw new Error("could not resolve the published Gateway port");
  const host = match[1]!.includes(":") && !match[1]!.startsWith("[") ? `[${match[1]}]` : match[1];
  return `http://${host}:${match[2]}`;
}

function identifier(): string {
  return randomBytes(24).toString("base64url");
}

function secret(identifierValue: string): string {
  return `${identifierValue}.${randomBytes(32).toString("base64url")}`;
}

function verifier(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

async function jsonCall(origin: string, path: string, options: { method?: "GET" | "POST"; body?: unknown; bearer?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    redirect: "error",
    headers: {
      connection: "close",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body: Record<string, unknown>;
  try { body = await response.json() as Record<string, unknown>; }
  catch { throw new Error(`${path} returned a non-JSON HTTP ${response.status} response`); }
  return { status: response.status, body };
}

function expectStatus(result: { status: number }, expected: number, operation: string): void {
  if (result.status !== expected) throw new Error(`${operation} returned HTTP ${result.status}, expected ${expected}`);
}

function scanRawCredentials(rawCredentials: readonly string[]): void {
  if (rawCredentials.length === 0 || rawCredentials.some((value) => value.length < 40)) {
    throw new Error("raw credential scan received invalid canaries");
  }
  const logArgs = qualificationContainer
    ? ["logs", qualificationContainer]
    : [...compose, "logs", "--no-color", "gateway"];
  const logResult = spawnSync("docker", logArgs, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (logResult.error || logResult.status !== 0) throw new Error("could not capture Gateway logs for the raw credential scan");

  const sources: Array<{ name: string; bytes: Buffer }> = [
    { name: "Gateway logs", bytes: Buffer.concat([logResult.stdout ?? Buffer.alloc(0), logResult.stderr ?? Buffer.alloc(0)]) },
  ];
  const safeStateRoot = realpathSync(stateRoot);
  const registryDirectory = join(safeStateRoot, "plugins", "thunderclaw");
  if (!existsSync(registryDirectory)) throw new Error("the pairing registry directory is absent");
  const safeRegistryDirectory = realpathSync(registryDirectory);
  if (!safeRegistryDirectory.startsWith(`${safeStateRoot}${sep}`)) throw new Error("the pairing registry directory is unsafe");

  for (const filename of ["pairing.sqlite", "pairing.sqlite-wal", "pairing.sqlite-shm"]) {
    const candidate = join(safeRegistryDirectory, filename);
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(candidate) !== candidate) {
      throw new Error(`refusing to scan unsafe pairing registry file ${filename}`);
    }
    sources.push({ name: filename, bytes: readFileSync(candidate) });
  }
  if (!sources.some((source) => source.name === "pairing.sqlite")) throw new Error("the pairing registry database is absent");

  const canaries = rawCredentials.map((value) => Buffer.from(value, "utf8"));
  for (const source of sources) {
    if (canaries.some((canary) => source.bytes.includes(canary))) {
      throw new Error(`raw pairing credential found in ${source.name}`);
    }
  }
}

async function qualify(initialOrigin: string): Promise<void> {
  let origin = initialOrigin;
  const requestId = identifier();
  const deviceId = identifier();
  const credentialId = identifier();
  const deviceCredential = secret(credentialId);
  const claimCredential = secret(requestId);

  const issued = await jsonCall(origin, "/thunderclaw/pairing/v1/requests", { body: {
    protocolVersion: 1,
    requestId,
    deviceId,
    deviceName: "ThunderClaw automated qualification",
    credentialId,
    credentialVerifier: verifier("thunderclaw-device-credential-v1", deviceCredential),
    claimVerifier: verifier("thunderclaw-pairing-claim-v1", claimCredential),
  } });
  expectStatus(issued, 201, "public pairing request");
  process.stdout.write("Pairing request issued.\n");
  if (issued.body.requestId !== requestId || typeof issued.body.approvalCode !== "string") {
    throw new Error("public pairing request response is invalid");
  }

  const requests = gatewayCall("thunderclaw.pairing.requests", {}) as { requests?: Array<Record<string, unknown>> };
  if (!requests.requests?.some((request) => request.requestId === requestId && request.state === "pending")) {
    throw new Error("operator request listing did not include the pending request");
  }
  gatewayCall("thunderclaw.pairing.approve", { requestId, approvalCode: issued.body.approvalCode });
  process.stdout.write("Pairing request approved through the Gateway.\n");

  expectStatus(await jsonCall(origin, "/thunderclaw/pairing/v1/claim", { method: "POST", bearer: claimCredential }), 200, "one-time claim");
  expectStatus(await jsonCall(origin, "/thunderclaw/pairing/v1/claim", { method: "POST", bearer: claimCredential }), 401, "claim replay rejection");
  expectStatus(await jsonCall(origin, "/thunderclaw/v1/status", { bearer: deviceCredential }), 200, "authenticated product status");
  process.stdout.write("Claim and authenticated product status passed.\n");

  const nextCredentialId = identifier();
  const nextCredential = secret(nextCredentialId);
  expectStatus(await jsonCall(origin, "/thunderclaw/pairing/v1/rotate", {
    bearer: deviceCredential,
    body: {
      protocolVersion: 1,
      credentialId: nextCredentialId,
      credentialVerifier: verifier("thunderclaw-device-credential-v1", nextCredential),
    },
  }), 200, "credential rotation");
  expectStatus(await jsonCall(origin, "/thunderclaw/v1/status", { bearer: deviceCredential }), 401, "rotated credential rejection");
  expectStatus(await jsonCall(origin, "/thunderclaw/v1/status", { bearer: nextCredential }), 200, "new credential product status");
  process.stdout.write("Credential rotation passed.\n");

  docker("restart", "gateway");
  origin = endpoint();
  await waitForPairingStatus(origin);
  expectStatus(await jsonCall(origin, "/thunderclaw/v1/status", { bearer: nextCredential }), 200, "credential restart persistence");
  process.stdout.write("Credential restart persistence passed.\n");

  expectStatus(await jsonCall(origin, "/thunderclaw/pairing/v1/revoke", { method: "POST", bearer: nextCredential }), 200, "self revocation");
  expectStatus(await jsonCall(origin, "/thunderclaw/v1/status", { bearer: nextCredential }), 401, "revoked credential rejection");
  docker("restart", "gateway");
  origin = endpoint();
  await waitForPairingStatus(origin);
  expectStatus(await jsonCall(origin, "/thunderclaw/v1/status", { bearer: nextCredential }), 401, "revocation restart persistence");
  process.stdout.write("Revocation and restart persistence passed.\n");
  scanRawCredentials([claimCredential, deviceCredential, nextCredential]);
}

function assertSafeStatePaths(): void {
  const expected = join(realpathSync(root), ".spike", "thunderclaw-openclaw");
  if (realpathSync(stateRoot) !== expected) throw new Error("refusing to mutate an unexpected OpenClaw state directory");
  if (!existsSync(openClawConfig)) throw new Error("the existing OpenClaw config must be present");
}

function installedPluginRoot(): string {
  const output = docker("exec", "-T", "gateway", "node", "openclaw.mjs", "plugins", "list", "--json");
  const report = JSON.parse(output) as { plugins?: Array<{ id?: unknown; rootDir?: unknown; status?: unknown }> };
  const plugin = report.plugins?.find((entry) => entry.id === "thunderclaw");
  if (!plugin || plugin.status !== "loaded" || typeof plugin.rootDir !== "string") {
    throw new Error("the existing ThunderClaw plugin must be loaded");
  }
  const containerPrefix = "/home/node/.openclaw/";
  if (!plugin.rootDir.startsWith(containerPrefix)) throw new Error("the installed plugin root is outside managed OpenClaw state");
  const candidate = realpathSync(join(stateRoot, plugin.rootDir.slice(containerPrefix.length)));
  const safeStateRoot = realpathSync(stateRoot);
  if (!candidate.startsWith(`${safeStateRoot}${sep}`)
    || !existsSync(join(candidate, "package.json"))
    || !existsSync(join(candidate, "openclaw.plugin.json"))) {
    throw new Error("the installed plugin root is unsafe or incomplete");
  }
  return candidate;
}

type PluginBackup = {
  directory: string;
  config: string;
  archive: string;
  preserveArchive: boolean;
  recoveryCompleted: boolean;
};

function backupInstalledPlugin(): PluginBackup {
  assertSafeStatePaths();
  const pluginRoot = installedPluginRoot();
  const directory = mkdtempSync(join(tmpdir(), "thunderclaw-pairing-qualification-"));
  const config = join(directory, "openclaw.json");
  mkdirSync(join(root, "build"), { recursive: true });
  const archive = join(root, "build", `pairing-rollback-thunderclaw-${Date.now()}-${randomBytes(6).toString("hex")}.tgz`);
  try {
    cpSync(openClawConfig, config, { preserveTimestamps: true });
    command("tar", ["-czf", archive, "--transform=s|^\\./|package/|", "-C", pluginRoot, "."]);
    const entries = command("tar", ["-tzf", archive]).split("\n");
    if (!entries.includes("package/package.json") || !entries.includes("package/openclaw.plugin.json")) {
      throw new Error("the prior-plugin recovery archive has an invalid package layout");
    }
    return { directory, config, archive, preserveArchive: false, recoveryCompleted: false };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    rmSync(archive, { force: true });
    throw error;
  }
}

async function restoreInstalledPlugin(backup: PluginBackup): Promise<void> {
  backup.preserveArchive = true;
  assertSafeStatePaths();
  command("docker", [...compose, "exec", "-T", "gateway", "node", "openclaw.mjs", "plugins", "uninstall", "thunderclaw", "--force"], { allowFailure: true });
  docker("exec", "-T", "gateway", "node", "openclaw.mjs", "plugins", "install", "--force", `npm-pack:/workspace/thunderclaw/build/${basename(backup.archive)}`);
  const replacementConfig = join(stateRoot, `.openclaw.json.pairing-restore-${process.pid}`);
  try {
    cpSync(backup.config, replacementConfig, { preserveTimestamps: true });
    renameSync(replacementConfig, openClawConfig);
  } catch (error) {
    rmSync(replacementConfig, { force: true });
    throw error;
  }
  docker("restart", "gateway");
  await waitForGatewayHealth();
  backup.recoveryCompleted = true;
}

function cleanupBackup(backup: PluginBackup): void {
  // If recovery itself failed, retain the private config snapshot and archive
  // for operator-led repair. A completed recovery retains only the archive
  // because OpenClaw's durable install record now refers to it.
  if (!backup.preserveArchive || backup.recoveryCompleted) {
    rmSync(backup.directory, { recursive: true, force: true });
  }
  if (!backup.preserveArchive) rmSync(backup.archive, { force: true });
}

type TransactionHooks<Backup> = {
  backup: () => Backup;
  install: (backup: Backup) => Promise<void>;
  restore: (backup: Backup) => Promise<void>;
  cleanup: (backup: Backup) => void;
};

async function installTransaction<Backup, Result>(hooks: TransactionHooks<Backup>, action: () => Promise<Result>): Promise<Result> {
  let backup: Backup | undefined;
  try {
    backup = hooks.backup();
    await hooks.install(backup);
    return await action();
  } catch (error) {
    if (backup !== undefined) {
      try { await hooks.restore(backup); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], "qualification failed and the prior plugin could not be restored");
      }
    }
    throw error;
  } finally {
    if (backup !== undefined) hooks.cleanup(backup);
  }
}

async function runRollbackSelfTest(): Promise<void> {
  const events: string[] = [];
  const expectedError = new Error("synthetic install failure");
  try {
    await installTransaction({
      backup: () => { events.push("backup"); return {}; },
      install: async () => { events.push("install"); throw expectedError; },
      restore: async () => {
        events.push("restore-start");
        await Promise.resolve();
        events.push("restore-complete");
      },
      cleanup: () => { events.push("cleanup"); },
    }, async () => { events.push("action"); });
    throw new Error("rollback self-test did not surface the synthetic failure");
  } catch (error) {
    if (error !== expectedError) throw error;
  }
  const expected = ["backup", "install", "restore-start", "restore-complete", "cleanup"];
  if (events.length !== expected.length || events.some((event, index) => event !== expected[index])) {
    throw new Error(`rollback self-test ordering failed: ${events.join(",")}`);
  }
  process.stdout.write("Pairing rollback self-test passed: asynchronous restore completed before backup cleanup.\n");
}

async function main(): Promise<void> {
  if (selfTestRollback) {
    await runRollbackSelfTest();
    return;
  }
  inspectGateway();
  const origin = endpoint();
  if (dryRun) {
    packCandidate();
    const backup = backupInstalledPlugin();
    cleanupBackup(backup);
    process.stdout.write("Pairing qualification dry run passed: pinned Gateway, logs, health, endpoint, and candidate archive verified.\n");
    return;
  }

  const qualifyInstalledCandidate = async () => {
    await waitForPairingStatus(origin);
    await qualify(origin);
  };

  if (!noInstall) {
    const candidateArchive = packCandidate();
    await installTransaction<PluginBackup, void>({
      backup: backupInstalledPlugin,
      install: async () => {
      // The legacy schema requires its static token even while disabled. The
      // supported uninstall lifecycle removes that obsolete config/install
      // entry without deleting the separate plugin-owned registry state.
      docker("exec", "-T", "gateway", "node", "openclaw.mjs", "plugins", "uninstall", "thunderclaw", "--force");
      docker("exec", "-T", "gateway", "node", "openclaw.mjs", "plugins", "install", "--force", `npm-pack:/workspace/thunderclaw/build/${basename(candidateArchive)}`);
      docker("exec", "-T", "gateway", "node", "openclaw.mjs", "config", "set", "plugins.entries.thunderclaw.enabled", "true", "--strict-json");
      docker("restart", "gateway");
      },
      restore: restoreInstalledPlugin,
      cleanup: cleanupBackup,
    }, qualifyInstalledCandidate);
  } else {
    await qualifyInstalledCandidate();
  }
  process.stdout.write("Pairing qualification passed: request, operator approval, one-time claim, product authentication, rotation, revocation, and restart persistence.\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Pairing qualification failed: ${redact(message)}\n`);
  process.exitCode = 1;
});
