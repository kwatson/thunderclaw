import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  PairingRegistry,
  PairingRegistryAuthenticationError,
  PairingRegistryConflictError,
  approvalCodeVerifier,
  claimCredentialVerifier,
  deviceCredentialVerifier,
} from "../packages/openclaw-plugin/src/pairing-registry.js";

const REQUEST_ID = "request_12345678901234567890";
const DEVICE_ID = "device_123456789012345678901";
const CREDENTIAL_ID = "credential_12345678901234567";
const NEXT_CREDENTIAL_ID = "credential_98765432109876543";
const CLAIM_SECRET = "claim-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
const DEVICE_SECRET = "device-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
const NEXT_DEVICE_SECRET = "next-device-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
const APPROVAL_CODE = "ABCDE23456";

async function registryFixture(context: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-pairing-test-"));
  let current = Date.UTC(2026, 7, 10, 12);
  const registry = PairingRegistry.open(stateDir, () => current);
  assert.equal(registry.isAvailable, true);
  context.after(async () => {
    registry.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return { registry, stateDir, advance: (milliseconds: number) => { current += milliseconds; } };
}

function issue(registry: PairingRegistry) {
  return registry.issue({
    requestId: REQUEST_ID,
    deviceId: DEVICE_ID,
    deviceName: "Workstation",
    credentialId: CREDENTIAL_ID,
    credentialVerifier: deviceCredentialVerifier(`${CREDENTIAL_ID}.${DEVICE_SECRET}`),
    claimVerifier: claimCredentialVerifier(`${REQUEST_ID}.${CLAIM_SECRET}`),
    approvalCodeVerifier: approvalCodeVerifier(APPROVAL_CODE),
  });
}

function pair(registry: PairingRegistry) {
  issue(registry);
  registry.approve(REQUEST_ID, `ABCDE-${APPROVAL_CODE.slice(5)}`);
  return registry.claim(REQUEST_ID, `${REQUEST_ID}.${CLAIM_SECRET}`);
}

function downgradeDatabaseToV1(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DROP INDEX credentials_expiry");
    database.exec("UPDATE schema_metadata SET version = 1 WHERE singleton = 1");
    database.exec("PRAGMA user_version=1");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

test("pairing approval and claim are one-time and expose only fixed capabilities", async (context) => {
  const { registry } = await registryFixture(context);
  const request = issue(registry);
  assert.equal(request.state, "pending");
  assert.throws(() => registry.approve(REQUEST_ID, "ZZZZZ-ZZZZZ"), PairingRegistryConflictError);
  registry.approve(REQUEST_ID, "abcde-23456");
  const device = registry.claim(REQUEST_ID, `${REQUEST_ID}.${CLAIM_SECRET}`);
  assert.deepEqual(device.capabilities, [
    "status:read", "agents:read", "agents:probe", "compose:transform", "message:transform",
    "credential:rotate", "credential:revoke",
  ]);
  assert.throws(
    () => registry.claim(REQUEST_ID, `${REQUEST_ID}.${CLAIM_SECRET}`),
    (error: unknown) => error instanceof PairingRegistryAuthenticationError && error.code === "AUTHENTICATION_FAILED",
  );
  assert.equal(registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "compose:transform").credentialId, CREDENTIAL_ID);
});

test("expired and denied requests cannot be approved or claimed", async (context) => {
  const { registry, advance } = await registryFixture(context);
  issue(registry);
  advance(10 * 60_000);
  assert.throws(() => registry.approve(REQUEST_ID, APPROVAL_CODE), PairingRegistryConflictError);
  assert.throws(() => registry.deny(REQUEST_ID), PairingRegistryConflictError);
  assert.throws(() => registry.claim(REQUEST_ID, `${REQUEST_ID}.${CLAIM_SECRET}`), PairingRegistryAuthenticationError);
});

test("concurrent claim and rotation attempts have exactly one winner", async (context) => {
  const { registry } = await registryFixture(context);
  issue(registry);
  registry.approve(REQUEST_ID, APPROVAL_CODE);
  const claims = await Promise.allSettled([
    Promise.resolve().then(() => registry.claim(REQUEST_ID, `${REQUEST_ID}.${CLAIM_SECRET}`)),
    Promise.resolve().then(() => registry.claim(REQUEST_ID, `${REQUEST_ID}.${CLAIM_SECRET}`)),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);

  const rotations = await Promise.allSettled([
    Promise.resolve().then(() => registry.rotate(CREDENTIAL_ID, NEXT_CREDENTIAL_ID, deviceCredentialVerifier(`${NEXT_CREDENTIAL_ID}.${NEXT_DEVICE_SECRET}`))),
    Promise.resolve().then(() => registry.rotate(CREDENTIAL_ID, "credential_third_1234567890123", deviceCredentialVerifier("credential_third_1234567890123.secret-value-abcdefghijklmnopqrstuvwxyz"))),
  ]);
  assert.equal(rotations.filter((result) => result.status === "fulfilled").length, 1);
  assert.throws(() => registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "status:read"), PairingRegistryAuthenticationError);
});

test("rotation, self revocation, operator revocation, and expiration are enforced", async (context) => {
  const { registry, advance } = await registryFixture(context);
  pair(registry);
  registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "credential:rotate");
  registry.rotate(CREDENTIAL_ID, NEXT_CREDENTIAL_ID, deviceCredentialVerifier(`${NEXT_CREDENTIAL_ID}.${NEXT_DEVICE_SECRET}`));
  assert.throws(
    () => registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "status:read"),
    (error: unknown) => error instanceof PairingRegistryAuthenticationError && error.code === "CREDENTIAL_REVOKED",
  );
  assert.equal(registry.authenticate(NEXT_CREDENTIAL_ID, `${NEXT_CREDENTIAL_ID}.${NEXT_DEVICE_SECRET}`, "status:read").credentialId, NEXT_CREDENTIAL_ID);
  registry.revoke(NEXT_CREDENTIAL_ID, "self");
  assert.throws(() => registry.authenticate(NEXT_CREDENTIAL_ID, `${NEXT_CREDENTIAL_ID}.${NEXT_DEVICE_SECRET}`, "status:read"), PairingRegistryAuthenticationError);

  const separate = await registryFixture(context);
  pair(separate.registry);
  separate.registry.revoke(CREDENTIAL_ID, "operator");
  assert.throws(() => separate.registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "status:read"), PairingRegistryAuthenticationError);

  const expiring = await registryFixture(context);
  pair(expiring.registry);
  expiring.advance(90 * 24 * 60 * 60_000);
  assert.throws(
    () => expiring.registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "status:read"),
    (error: unknown) => error instanceof PairingRegistryAuthenticationError && error.code === "CREDENTIAL_EXPIRED",
  );
  assert.equal(expiring.registry.listDevices()[0]?.revokedAt !== null, true);
});

test("database files never contain raw claim, device, or approval secrets", async (context) => {
  const { registry, stateDir } = await registryFixture(context);
  pair(registry);
  registry.close();
  const base = join(stateDir, "plugins", "thunderclaw", "pairing.sqlite");
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    let content: Buffer;
    try { content = await readFile(path); } catch { continue; }
    for (const secret of [CLAIM_SECRET, DEVICE_SECRET, APPROVAL_CODE, `${REQUEST_ID}.${CLAIM_SECRET}`, `${CREDENTIAL_ID}.${DEVICE_SECRET}`]) {
      assert.equal(content.includes(Buffer.from(secret)), false, `${path} contained raw secret material`);
    }
  }
});

test("credentials persist across restart and their identities cannot be paired again after request cleanup", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-pairing-restart-"));
  let current = Date.UTC(2026, 7, 10, 12);
  let registry = PairingRegistry.open(stateDir, () => current);
  pair(registry);
  registry.close();

  registry = PairingRegistry.open(stateDir, () => current);
  assert.equal(registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "message:transform").deviceId, DEVICE_ID);
  current += 8 * 24 * 60 * 60_000;
  assert.throws(() => registry.issue({
    requestId: "request_replay_123456789012345",
    deviceId: DEVICE_ID,
    deviceName: "Replay",
    credentialId: CREDENTIAL_ID,
    credentialVerifier: deviceCredentialVerifier(`${CREDENTIAL_ID}.${DEVICE_SECRET}`),
    claimVerifier: claimCredentialVerifier("request_replay_123456789012345.new_claim_secret_abcdefghijklmnopqrstuvwxyz"),
    approvalCodeVerifier: approvalCodeVerifier("FGHIJ23456"),
  }), PairingRegistryConflictError);
  assert.equal(registry.isAvailable, true, "expected identity conflict must not disable the registry");
  registry.close();
  await rm(stateDir, { recursive: true, force: true });
  context.after(() => { registry.close(); });
});

test("fresh registries create schema v2 without manufacturing a migration backup", async (context) => {
  const { registry, stateDir } = await registryFixture(context);
  const databasePath = join(stateDir, "plugins", "thunderclaw", "pairing.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Object.values(database.prepare("PRAGMA user_version").get() as Record<string, unknown>)[0], 2);
  assert.equal((database.prepare("SELECT version FROM schema_metadata").get() as { version: number }).version, 2);
  assert.ok(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'credentials_expiry'").get());
  database.close();
  await assert.rejects(() => stat(`${databasePath}.v1.backup`), { code: "ENOENT" });
  assert.equal(registry.isAvailable, true);
});

test("v1 opens create a private coherent backup and transactionally migrate live data to v2", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-pairing-migration-"));
  const databasePath = join(stateDir, "plugins", "thunderclaw", "pairing.sqlite");
  const backupPath = `${databasePath}.v1.backup`;
  let registry = PairingRegistry.open(stateDir);
  pair(registry);
  registry.revoke(CREDENTIAL_ID, "operator");
  registry.close();
  const before = new DatabaseSync(databasePath, { readOnly: true });
  const expectedVerifier = (before.prepare("SELECT verifier FROM credentials WHERE credential_id = ?").get(CREDENTIAL_ID) as { verifier: string }).verifier;
  before.close();
  downgradeDatabaseToV1(databasePath);

  registry = PairingRegistry.open(stateDir);
  assert.equal(registry.isAvailable, true);
  const retained = registry.listDevices()[0];
  assert.equal(retained?.credentialId, CREDENTIAL_ID);
  assert.notEqual(retained?.revokedAt, null);

  const live = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Object.values(live.prepare("PRAGMA user_version").get() as Record<string, unknown>)[0], 2);
  assert.equal((live.prepare("SELECT version FROM schema_metadata").get() as { version: number }).version, 2);
  assert.equal((live.prepare("SELECT verifier FROM credentials WHERE credential_id = ?").get(CREDENTIAL_ID) as { verifier: string }).verifier, expectedVerifier);
  assert.equal((live.prepare("SELECT reason FROM revocations WHERE credential_id = ?").get(CREDENTIAL_ID) as { reason: string }).reason, "operator");
  const liveRequest = live.prepare("SELECT state, credential_verifier, claim_verifier, approval_code_verifier FROM pairing_requests WHERE request_id = ?")
    .get(REQUEST_ID) as { state: string; credential_verifier: string; claim_verifier: string; approval_code_verifier: string };
  assert.deepEqual({ ...liveRequest }, {
    state: "consumed",
    credential_verifier: deviceCredentialVerifier(`${CREDENTIAL_ID}.${DEVICE_SECRET}`),
    claim_verifier: claimCredentialVerifier(`${REQUEST_ID}.${CLAIM_SECRET}`),
    approval_code_verifier: approvalCodeVerifier(APPROVAL_CODE),
  });
  assert.ok(live.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'credentials_expiry'").get());
  live.close();

  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(Object.values(backup.prepare("PRAGMA quick_check").get() as Record<string, unknown>)[0], "ok");
  assert.equal(Object.values(backup.prepare("PRAGMA user_version").get() as Record<string, unknown>)[0], 1);
  assert.equal((backup.prepare("SELECT version FROM schema_metadata").get() as { version: number }).version, 1);
  assert.equal((backup.prepare("SELECT verifier FROM credentials WHERE credential_id = ?").get(CREDENTIAL_ID) as { verifier: string }).verifier, expectedVerifier);
  assert.equal((backup.prepare("SELECT reason FROM revocations WHERE credential_id = ?").get(CREDENTIAL_ID) as { reason: string }).reason, "operator");
  const backupRequest = backup.prepare("SELECT state, credential_verifier, claim_verifier, approval_code_verifier FROM pairing_requests WHERE request_id = ?")
    .get(REQUEST_ID) as { state: string; credential_verifier: string; claim_verifier: string; approval_code_verifier: string };
  assert.deepEqual({ ...backupRequest }, { ...liveRequest });
  assert.equal(backup.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'credentials_expiry'").get(), undefined);
  backup.close();
  if (process.platform !== "win32") assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const backupBytes = await readFile(backupPath);
  assert.equal(backupBytes.includes(Buffer.from(DEVICE_SECRET)), false);
  assert.equal(backupBytes.includes(Buffer.from(CLAIM_SECRET)), false);

  registry.close();
  await rm(stateDir, { recursive: true, force: true });
  context.after(() => { registry.close(); });
});

test("v1 migration refuses to overwrite an existing backup and leaves the live schema untouched", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-pairing-migration-refusal-"));
  const databasePath = join(stateDir, "plugins", "thunderclaw", "pairing.sqlite");
  const backupPath = `${databasePath}.v1.backup`;
  let registry = PairingRegistry.open(stateDir);
  registry.close();
  downgradeDatabaseToV1(databasePath);
  const sentinel = Buffer.from("existing operator backup");
  await writeFile(backupPath, sentinel, { mode: 0o600 });

  registry = PairingRegistry.open(stateDir);
  assert.equal(registry.isAvailable, false);
  assert.deepEqual(await readFile(backupPath), sentinel);
  const live = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Object.values(live.prepare("PRAGMA user_version").get() as Record<string, unknown>)[0], 1);
  assert.equal((live.prepare("SELECT version FROM schema_metadata").get() as { version: number }).version, 1);
  assert.equal(live.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'credentials_expiry'").get(), undefined);
  live.close();

  registry.close();
  await rm(stateDir, { recursive: true, force: true });
  context.after(() => { registry.close(); });
});

test("schema tampering and hostile filesystem objects fail closed", async (context) => {
  const { registry, stateDir } = await registryFixture(context);
  registry.close();
  const path = join(stateDir, "plugins", "thunderclaw", "pairing.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version=999");
  database.close();
  const corrupted = PairingRegistry.open(stateDir);
  assert.equal(corrupted.isAvailable, false);
  assert.throws(() => corrupted.listDevices(), { name: "Error", message: "pairing registry is unavailable" });
  corrupted.close();

  const target = await mkdtemp(join(tmpdir(), "thunderclaw-pairing-target-"));
  const link = join(tmpdir(), `thunderclaw-pairing-link-${process.pid}-${Date.now()}`);
  await symlink(target, link);
  context.after(async () => { await rm(link, { force: true }); await rm(target, { recursive: true, force: true }); });
  const hostile = PairingRegistry.open(link);
  assert.equal(hostile.isAvailable, false);
  hostile.close();
});
