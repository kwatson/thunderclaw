import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { PairingRegistry } from "../packages/openclaw-plugin/src/pairing-registry.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const compose = ["compose", "-f", "compose.spike.yaml"];
const outputDirectory = join(root, "build", "pairing-recovery-qualification");
const containerArchive = `/tmp/thunderclaw-pairing-recovery-${randomUUID()}.tar.gz`;

function command(program: string, args: string[], capture = true): string {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${program} failed with status ${result.status}`);
  return result.stdout.trim();
}

function docker(...args: string[]): string { return command("docker", [...compose, ...args]); }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function safeArchiveEntry(entry: string): boolean {
  return entry.length > 0 && !entry.startsWith("/") && !entry.split("/").includes("..") && !entry.includes("\\");
}

async function main(): Promise<void> {
  const ps = docker("ps", "--status", "running", "--services").split(/\r?\n/u);
  assert(ps.includes("gateway"), "the pinned Gateway must already be running");
  const gatewayContainer = docker("ps", "-q", "gateway");
  assert(/^[a-f0-9]{12,64}$/u.test(gatewayContainer), "could not resolve the exact Gateway container");
  docker("exec", "-T", "gateway", "node", "openclaw.mjs", "gateway", "call", "health", "--json");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  const archive = join(outputDirectory, `thunderclaw-pairing-recovery-${new Date().toISOString().replace(/[:.]/gu, "-")}.tar.gz`);
  const extraction = mkdtempSync(join(tmpdir(), "thunderclaw-pairing-recovery-"));
  chmodSync(extraction, 0o700);
  try {
    assert(!existsSync(archive), "refusing to overwrite a recovery archive");
    docker("exec", "-T", "gateway", "test", "!", "-e", containerArchive);
    const created = JSON.parse(docker("exec", "-T", "gateway", "node", "openclaw.mjs", "backup", "create",
      "--verify", "--no-include-workspace", "--output", containerArchive, "--json")) as Record<string, unknown>;
    assert(created.verified === true && created.archivePath === containerArchive, "OpenClaw did not verify the created archive");
    command("docker", ["cp", `${gatewayContainer}:${containerArchive}`, archive]);
    chmodSync(archive, 0o600);
    docker("exec", "-T", "gateway", "rm", containerArchive);
    const relativeArchive = archive.slice(`${root}${sep}`.length);
    const verified = JSON.parse(docker("exec", "-T", "gateway", "node", "openclaw.mjs", "backup", "verify",
      `/workspace/thunderclaw/${relativeArchive}`, "--json")) as Record<string, unknown>;
    assert(verified.ok === true, "the copied recovery archive failed verification");

    const entries = command("tar", ["-tzf", archive]).split(/\r?\n/u).filter(Boolean);
    assert(entries.every(safeArchiveEntry), "the recovery archive contains an unsafe path");
    const suffix = "/payload/posix/home/node/.openclaw/plugins/thunderclaw/pairing.sqlite";
    const databaseEntry = entries.find((entry) => entry.endsWith(suffix));
    assert(databaseEntry && entries.filter((entry) => entry.endsWith(suffix)).length === 1,
      "the recovery archive does not contain exactly one current pairing registry");
    assert(!entries.some((entry) => entry === `${databaseEntry}-wal` || entry === `${databaseEntry}-shm`),
      "the recovery archive retained transient SQLite sidecars");
    command("tar", ["-xzf", archive, "-C", extraction, databaseEntry]);
    const restoredDatabase = join(extraction, databaseEntry);
    const restoredStateRoot = dirname(dirname(dirname(restoredDatabase)));
    const safeExtraction = resolve(extraction);
    assert(resolve(restoredDatabase).startsWith(`${safeExtraction}${sep}`), "the restored registry escaped its private root");
    const stat = lstatSync(restoredDatabase);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600,
      "the restored registry is not a private regular file");

    const database = new DatabaseSync(restoredDatabase, { readOnly: true });
    const quick = database.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
    const schema = database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    const counts = Object.fromEntries(["pairing_requests", "credentials", "revocations"].map((table) => {
      const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
      return [table, row.count];
    }));
    database.close();
    assert(Object.values(quick)[0] === "ok" && Object.values(schema)[0] === 2, "the restored registry failed integrity or schema validation");

    const registry = PairingRegistry.open(restoredStateRoot);
    assert(registry.isAvailable, "production PairingRegistry refused the isolated restored database");
    const restoredDevices = registry.listDevices().length;
    registry.close();
    assert(restoredDevices === counts.credentials, "production restore view disagrees with the SQLite snapshot");

    const summary = {
      status: "passed",
      createdAt: created.createdAt,
      runtimeVersion: verified.runtimeVersion,
      archive: basename(archive),
      archiveSha256: sha256(archive),
      archiveMode: "0600",
      entryCount: entries.length,
      pairingDatabase: { schema: 2, quickCheck: "ok", mode: "0600", walExcluded: true, shmExcluded: true, counts },
      productionRegistryOpen: true,
    };
    writeFileSync(join(outputDirectory, "qualification-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Pairing recovery qualification passed: ${archive}\n`);
    process.stdout.write("The retained archive contains broad OpenClaw state and must be handled as a sensitive artifact.\n");
  } finally {
    try { docker("exec", "-T", "gateway", "rm", "-f", containerArchive); } catch { /* Best-effort cleanup of our exact temporary path. */ }
    rmSync(extraction, { recursive: true, force: true });
  }
}

await main();
