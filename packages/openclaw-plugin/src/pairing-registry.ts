import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;
const PREVIOUS_SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x54434c57; // "TCLW"
const REQUEST_TTL_MS = 10 * 60_000;
const CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60_000;
const MAX_PENDING_REQUESTS = 1000;
const CLEANUP_BATCH_SIZE = 200;
const MAX_DEVICE_NAME_CHARACTERS = 120;
const ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/u;
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/u;
const APPROVAL_CODE_PATTERN = /^[A-Z2-7]{10}$/u;
const CAPABILITIES = [
  "status:read",
  "agents:read",
  "agents:probe",
  "compose:transform",
  "message:transform",
  "credential:rotate",
  "credential:revoke",
] as const;

export type DeviceCapability = typeof CAPABILITIES[number];

export type PairingRequestInput = {
  requestId: string;
  deviceId: string;
  deviceName: string;
  credentialId: string;
  credentialVerifier: string;
  claimVerifier: string;
  approvalCodeVerifier: string;
};

export type PairingRequestRecord = {
  requestId: string;
  deviceId: string;
  deviceName: string;
  credentialId: string;
  state: "pending" | "approved";
  createdAt: string;
  expiresAt: string;
};

export type DeviceRecord = {
  credentialId: string;
  deviceId: string;
  deviceName: string;
  capabilities: readonly DeviceCapability[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  replacedBy: string | null;
};

type PairingRow = {
  request_id: string;
  device_id: string;
  device_name: string;
  credential_id: string;
  credential_verifier: string;
  claim_verifier: string;
  approval_code_verifier: string;
  state: "pending" | "approved" | "consumed" | "denied" | "expired";
  created_at_ms: number;
  expires_at_ms: number;
};

type CredentialRow = {
  credential_id: string;
  device_id: string;
  device_name: string;
  verifier: string;
  capabilities: string;
  created_at_ms: number;
  expires_at_ms: number;
  last_used_at_ms: number | null;
  revoked_at_ms: number | null;
  replaced_by: string | null;
};

const PROCESS_REGISTRY = Symbol.for("thunderclaw.pairing-registry.v1");

function processRegistry(): Map<string, PairingRegistry> {
  const global = globalThis as unknown as { [key: symbol]: Map<string, PairingRegistry> | undefined };
  if (global[PROCESS_REGISTRY] instanceof Map) return global[PROCESS_REGISTRY];
  const created = new Map<string, PairingRegistry>();
  global[PROCESS_REGISTRY] = created;
  return created;
}

function hash(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

export function deviceCredentialVerifier(credential: string): string {
  return hash("thunderclaw-device-credential-v1", credential);
}

export function claimCredentialVerifier(credential: string): string {
  return hash("thunderclaw-pairing-claim-v1", credential);
}

export function approvalCodeVerifier(code: string): string {
  return hash("thunderclaw-pairing-approval-v1", code.replaceAll("-", "").toUpperCase());
}

function equalVerifier(left: string, right: string): boolean {
  if (!VERIFIER_PATTERN.test(left) || !VERIFIER_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function safeObject(path: string, kind: "directory" | "file"): boolean {
  const stat = lstatSync(path);
  if (kind === "directory") return stat.isDirectory() && !stat.isSymbolicLink();
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function existsAs(path: string, kind: "directory" | "file"): boolean {
  try {
    if (!safeObject(path, kind)) throw new Error("unsafe filesystem object");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ensureDirectory(path: string, privateDirectory: boolean): void {
  if (!existsAs(path, "directory")) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !existsAs(path, "directory")) throw error;
    }
  }
  if (privateDirectory && process.platform !== "win32") chmodSync(path, 0o700);
}

function protectDatabaseFiles(path: string): void {
  if (process.platform === "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsAs(candidate, "file")) chmodSync(candidate, 0o600);
  }
}

function validName(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_DEVICE_NAME_CHARACTERS
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function requireIdentifier(value: string): void {
  if (!ID_PATTERN.test(value)) throw new PairingRegistryInputError("invalid identifier");
}

function iso(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new PairingRegistryUnavailableError();
  return new Date(value).toISOString();
}

function rollback(database: DatabaseSync): void {
  try { database.exec("ROLLBACK"); } catch { throw new PairingRegistryUnavailableError(); }
}

function validateSchema(database: DatabaseSync, version: number): void {
  const applicationId = database.prepare("PRAGMA application_id").get() as Record<string, unknown> | undefined;
  const userVersion = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  if (Object.values(applicationId ?? {})[0] !== APPLICATION_ID || Object.values(userVersion ?? {})[0] !== version) {
    throw new PairingRegistryUnavailableError();
  }
  type Column = readonly [name: string, type: "TEXT" | "INTEGER", notNull: 0 | 1, primaryKey: 0 | 1];
  const expected = new Map<string, readonly Column[]>([
    ["schema_metadata", [["singleton", "INTEGER", 0, 1], ["version", "INTEGER", 1, 0], ["created_at_ms", "INTEGER", 1, 0]]],
    ["pairing_requests", [
      ["request_id", "TEXT", 1, 1], ["device_id", "TEXT", 1, 0], ["device_name", "TEXT", 1, 0], ["credential_id", "TEXT", 1, 0],
      ["credential_verifier", "TEXT", 1, 0], ["claim_verifier", "TEXT", 1, 0], ["approval_code_verifier", "TEXT", 1, 0],
      ["state", "TEXT", 1, 0], ["created_at_ms", "INTEGER", 1, 0], ["expires_at_ms", "INTEGER", 1, 0],
      ["decided_at_ms", "INTEGER", 0, 0], ["consumed_at_ms", "INTEGER", 0, 0],
    ]],
    ["credentials", [
      ["credential_id", "TEXT", 1, 1], ["device_id", "TEXT", 1, 0], ["device_name", "TEXT", 1, 0], ["verifier", "TEXT", 1, 0],
      ["capabilities", "TEXT", 1, 0], ["created_at_ms", "INTEGER", 1, 0], ["expires_at_ms", "INTEGER", 1, 0],
      ["last_used_at_ms", "INTEGER", 0, 0], ["revoked_at_ms", "INTEGER", 0, 0], ["replaced_by", "TEXT", 0, 0],
    ]],
    ["revocations", [["credential_id", "TEXT", 1, 1], ["revoked_at_ms", "INTEGER", 1, 0], ["reason", "TEXT", 1, 0]]],
  ]);
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  if (tables.length !== expected.size || tables.some(({ name }) => !expected.has(name))) throw new PairingRegistryUnavailableError();
  for (const [table, columns] of expected) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    if (actual.length !== columns.length || actual.some((column, index) => {
      const wanted = columns[index];
      return !wanted || column.name !== wanted[0] || column.type !== wanted[1] || column.notnull !== wanted[2] || column.pk !== wanted[3];
    })) {
      throw new PairingRegistryUnavailableError();
    }
  }
  const strictTables = database.prepare("PRAGMA table_list").all() as Array<{ schema: string; name: string; strict: number }>;
  if ([...expected.keys()].some((name) => !strictTables.some((table) => table.schema === "main" && table.name === name && table.strict === 1))) {
    throw new PairingRegistryUnavailableError();
  }
  const indexes = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>;
  const expectedIndexes = version === PREVIOUS_SCHEMA_VERSION
    ? ["credentials_device", "pairing_requests_state_expiry"]
    : ["credentials_device", "credentials_expiry", "pairing_requests_state_expiry"];
  if (indexes.length !== expectedIndexes.length || indexes.some((index, position) => index.name !== expectedIndexes[position])) {
    throw new PairingRegistryUnavailableError();
  }
  const executableSchemaObjects = database.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view') LIMIT 1").all();
  if (executableSchemaObjects.length !== 0) throw new PairingRegistryUnavailableError();
  const credentialForeignKeys = database.prepare("PRAGMA foreign_key_list(credentials)").all() as Array<{ table: string; from: string; to: string }>;
  const revocationForeignKeys = database.prepare("PRAGMA foreign_key_list(revocations)").all() as Array<{ table: string; from: string; to: string }>;
  if (credentialForeignKeys.length !== 1 || credentialForeignKeys[0]?.table !== "credentials"
    || credentialForeignKeys[0].from !== "replaced_by" || credentialForeignKeys[0].to !== "credential_id"
    || revocationForeignKeys.length !== 1 || revocationForeignKeys[0]?.table !== "credentials"
    || revocationForeignKeys[0].from !== "credential_id" || revocationForeignKeys[0].to !== "credential_id") {
    throw new PairingRegistryUnavailableError();
  }
  const metadata = database.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get() as { version: number } | undefined;
  if (!metadata || metadata.version !== version) throw new PairingRegistryUnavailableError();
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) throw new PairingRegistryUnavailableError();
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateBackup(path: string): void {
  if (!safeObject(path, "file")) throw new PairingRegistryUnavailableError();
  const backup = new DatabaseSync(path, { readOnly: true });
  try {
    const check = backup.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!check || Object.values(check)[0] !== "ok") throw new PairingRegistryUnavailableError();
    validateSchema(backup, PREVIOUS_SCHEMA_VERSION);
  } finally {
    backup.close();
  }
}

function migrateV1ToV2(database: DatabaseSync, databasePath: string): void {
  const backupPath = `${databasePath}.v1.backup`;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (existsAs(backupPath, "file")) throw new PairingRegistryUnavailableError();
    const snapshot = new DatabaseSync(databasePath, { readOnly: true });
    try {
      snapshot.exec(`VACUUM INTO ${sqliteString(backupPath)}`);
    } finally {
      snapshot.close();
    }
    if (process.platform !== "win32") chmodSync(backupPath, 0o600);
    validateBackup(backupPath);
    database.exec("CREATE INDEX credentials_expiry ON credentials(expires_at_ms, revoked_at_ms)");
    database.prepare("UPDATE schema_metadata SET version = ? WHERE singleton = 1 AND version = ?")
      .run(SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION);
    database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    validateSchema(database, SCHEMA_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function initialize(database: DatabaseSync, databasePath: string, created: boolean, now: number): void {
  database.exec("PRAGMA busy_timeout=5000");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  const check = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (!check || Object.values(check)[0] !== "ok") throw new PairingRegistryUnavailableError();
  if (created) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE schema_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
        ) STRICT;
        CREATE TABLE pairing_requests (
          request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 20 AND 64),
          device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 20 AND 64),
          device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 120),
          credential_id TEXT NOT NULL CHECK (length(credential_id) BETWEEN 20 AND 64),
          credential_verifier TEXT NOT NULL CHECK (length(credential_verifier) = 64),
          claim_verifier TEXT NOT NULL CHECK (length(claim_verifier) = 64),
          approval_code_verifier TEXT NOT NULL CHECK (length(approval_code_verifier) = 64),
          state TEXT NOT NULL CHECK (state IN ('pending','approved','consumed','denied','expired')),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
          decided_at_ms INTEGER,
          consumed_at_ms INTEGER,
          UNIQUE(credential_id)
        ) STRICT;
        CREATE INDEX pairing_requests_state_expiry ON pairing_requests(state, expires_at_ms);
        CREATE TABLE credentials (
          credential_id TEXT PRIMARY KEY CHECK (length(credential_id) BETWEEN 20 AND 64),
          device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 20 AND 64),
          device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 120),
          verifier TEXT NOT NULL CHECK (length(verifier) = 64),
          capabilities TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
          last_used_at_ms INTEGER,
          revoked_at_ms INTEGER,
          replaced_by TEXT REFERENCES credentials(credential_id)
        ) STRICT;
        CREATE INDEX credentials_device ON credentials(device_id, created_at_ms DESC);
        CREATE INDEX credentials_expiry ON credentials(expires_at_ms, revoked_at_ms);
        CREATE TABLE revocations (
          credential_id TEXT PRIMARY KEY REFERENCES credentials(credential_id),
          revoked_at_ms INTEGER NOT NULL CHECK (revoked_at_ms >= 0),
          reason TEXT NOT NULL CHECK (reason IN ('self','operator','rotation','expired'))
        ) STRICT;
      `);
      database.prepare("INSERT INTO schema_metadata(singleton, version, created_at_ms) VALUES (1, ?, ?)")
        .run(SCHEMA_VERSION, now);
      database.exec(`PRAGMA application_id=${APPLICATION_ID}`);
      database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
  } else {
    const applicationId = database.prepare("PRAGMA application_id").get() as Record<string, unknown> | undefined;
    const userVersion = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    if (Object.values(applicationId ?? {})[0] !== APPLICATION_ID) throw new PairingRegistryUnavailableError();
    const version = Object.values(userVersion ?? {})[0];
    if (version === PREVIOUS_SCHEMA_VERSION) {
      validateSchema(database, PREVIOUS_SCHEMA_VERSION);
      migrateV1ToV2(database, databasePath);
    } else if (version !== SCHEMA_VERSION) {
      throw new PairingRegistryUnavailableError();
    }
  }
  validateSchema(database, SCHEMA_VERSION);
  const journal = database.prepare("PRAGMA journal_mode=WAL").get() as Record<string, unknown> | undefined;
  if (!journal || Object.values(journal)[0] !== "wal") throw new PairingRegistryUnavailableError();
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA secure_delete=ON");
  database.exec("PRAGMA journal_size_limit=4194304");
  database.exec("PRAGMA wal_autocheckpoint=100");
}

export class PairingRegistryUnavailableError extends Error {
  readonly code = "PAIRING_UNAVAILABLE";
  constructor() { super("pairing registry is unavailable"); }
}

export class PairingRegistryInputError extends Error {
  readonly code = "INVALID_REQUEST";
}

export class PairingRegistryConflictError extends Error {
  readonly code = "PAIRING_CONFLICT";
}

export class PairingRegistryAuthenticationError extends Error {
  readonly code: "AUTHENTICATION_FAILED" | "CREDENTIAL_EXPIRED" | "CREDENTIAL_REVOKED";
  constructor(code: PairingRegistryAuthenticationError["code"]) {
    super(code === "CREDENTIAL_EXPIRED" ? "device credential expired" : code === "CREDENTIAL_REVOKED" ? "device credential revoked" : "device authentication failed");
    this.code = code;
  }
}

export class PairingRegistry {
  private database: DatabaseSync | null;
  private available: boolean;
  private readonly now: () => number;
  private readonly key: string;

  private constructor(database: DatabaseSync | null, key: string, now: () => number) {
    this.database = database;
    this.available = database !== null;
    this.key = key;
    this.now = now;
  }

  static open(stateDir: string, now: () => number = Date.now): PairingRegistry {
    const key = resolve(stateDir);
    const stores = processRegistry();
    const existing = stores.get(key);
    if (existing) return existing;
    let database: DatabaseSync | null = null;
    try {
      if (!safeObject(key, "directory")) throw new Error("unsafe state directory");
      const plugins = join(key, "plugins");
      ensureDirectory(plugins, false);
      const plugin = join(plugins, "thunderclaw");
      ensureDirectory(plugin, true);
      const path = join(plugin, "pairing.sqlite");
      const created = !existsAs(path, "file");
      if (created) closeSync(openSync(path, "wx", 0o600));
      if (!safeObject(path, "file")) throw new Error("unsafe database");
      protectDatabaseFiles(path);
      database = new DatabaseSync(path);
      initialize(database, path, created, now());
      protectDatabaseFiles(path);
    } catch {
      try { database?.close(); } catch { /* fail closed */ }
      database = null;
    }
    const store = new PairingRegistry(database, key, now);
    stores.set(key, store);
    return store;
  }

  get isAvailable(): boolean { return this.available; }

  private use<T>(operation: (database: DatabaseSync) => T): T {
    if (!this.database || !this.available) throw new PairingRegistryUnavailableError();
    try {
      return operation(this.database);
    } catch (error) {
      if (error instanceof PairingRegistryInputError || error instanceof PairingRegistryConflictError || error instanceof PairingRegistryAuthenticationError) throw error;
      this.available = false;
      try { this.database.close(); } catch { /* fail closed */ }
      this.database = null;
      throw new PairingRegistryUnavailableError();
    }
  }

  private cleanup(database: DatabaseSync, current: number): void {
    database.prepare("UPDATE pairing_requests SET state = 'expired' WHERE state IN ('pending','approved') AND expires_at_ms <= ?").run(current);
    database.prepare(`DELETE FROM pairing_requests WHERE request_id IN (
      SELECT request_id FROM pairing_requests
      WHERE state IN ('consumed','denied','expired') AND created_at_ms < ?
      ORDER BY created_at_ms ASC LIMIT ?
    )`).run(current - 7 * 24 * 60 * 60_000, CLEANUP_BATCH_SIZE);
  }

  issue(input: PairingRequestInput): PairingRequestRecord {
    requireIdentifier(input.requestId);
    requireIdentifier(input.deviceId);
    requireIdentifier(input.credentialId);
    if (!validName(input.deviceName) || !VERIFIER_PATTERN.test(input.credentialVerifier)
      || !VERIFIER_PATTERN.test(input.claimVerifier) || !VERIFIER_PATTERN.test(input.approvalCodeVerifier)) {
      throw new PairingRegistryInputError("invalid pairing request");
    }
    return this.use((database) => {
      const current = this.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        this.cleanup(database, current);
        const count = database.prepare("SELECT count(*) AS count FROM pairing_requests WHERE state IN ('pending','approved')").get() as { count: number };
        if (count.count >= MAX_PENDING_REQUESTS) throw new PairingRegistryConflictError("pairing request capacity is full");
        const existingCredential = database.prepare("SELECT 1 FROM credentials WHERE credential_id = ?").get(input.credentialId);
        if (existingCredential) throw new PairingRegistryConflictError("pairing identity was already used");
        database.prepare(`INSERT INTO pairing_requests(
          request_id, device_id, device_name, credential_id, credential_verifier,
          claim_verifier, approval_code_verifier, state, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(input.requestId, input.deviceId, input.deviceName, input.credentialId,
            input.credentialVerifier, input.claimVerifier, input.approvalCodeVerifier,
            current, current + REQUEST_TTL_MS);
        database.exec("COMMIT");
        return {
          requestId: input.requestId, deviceId: input.deviceId, deviceName: input.deviceName,
          credentialId: input.credentialId, state: "pending" as const,
          createdAt: iso(current), expiresAt: iso(current + REQUEST_TTL_MS),
        };
      } catch (error) {
        rollback(database);
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY" || (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new PairingRegistryConflictError("pairing identity was already used");
        }
        throw error;
      }
    });
  }

  listPending(): PairingRequestRecord[] {
    return this.use((database) => {
      this.cleanup(database, this.now());
      const rows = database.prepare("SELECT * FROM pairing_requests WHERE state IN ('pending','approved') ORDER BY created_at_ms ASC LIMIT ?")
        .all(MAX_PENDING_REQUESTS + 1) as unknown as PairingRow[];
      if (rows.length > MAX_PENDING_REQUESTS) throw new PairingRegistryUnavailableError();
      return rows.map((row) => ({
        requestId: row.request_id, deviceId: row.device_id, deviceName: row.device_name,
        credentialId: row.credential_id, state: row.state as "pending" | "approved",
        createdAt: iso(row.created_at_ms), expiresAt: iso(row.expires_at_ms),
      }));
    });
  }

  approve(requestId: string, approvalCode: string): void {
    requireIdentifier(requestId);
    const normalized = approvalCode.replaceAll("-", "").toUpperCase();
    if (!APPROVAL_CODE_PATTERN.test(normalized)) throw new PairingRegistryInputError("invalid approval code");
    this.use((database) => {
      const current = this.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        this.cleanup(database, current);
        const row = database.prepare("SELECT * FROM pairing_requests WHERE request_id = ?").get(requestId) as PairingRow | undefined;
        if (!row || row.state !== "pending" || !equalVerifier(row.approval_code_verifier, approvalCodeVerifier(normalized))) {
          throw new PairingRegistryConflictError("pairing request or approval code is invalid");
        }
        database.prepare("UPDATE pairing_requests SET state = 'approved', decided_at_ms = ? WHERE request_id = ? AND state = 'pending'").run(current, requestId);
        database.exec("COMMIT");
      } catch (error) { rollback(database); throw error; }
    });
  }

  deny(requestId: string): void {
    requireIdentifier(requestId);
    this.use((database) => {
      const current = this.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        this.cleanup(database, current);
        const changed = database.prepare("UPDATE pairing_requests SET state = 'denied', decided_at_ms = ? WHERE request_id = ? AND state = 'pending'")
          .run(current, requestId);
        if (changed.changes !== 1) throw new PairingRegistryConflictError("pairing request is not pending");
        database.exec("COMMIT");
      } catch (error) { rollback(database); throw error; }
    });
  }

  claim(requestId: string, claimCredential: string): DeviceRecord {
    requireIdentifier(requestId);
    if (claimCredential.length < 40 || claimCredential.length > 160) throw new PairingRegistryAuthenticationError("AUTHENTICATION_FAILED");
    return this.use((database) => {
      const current = this.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        this.cleanup(database, current);
        const row = database.prepare("SELECT * FROM pairing_requests WHERE request_id = ?").get(requestId) as PairingRow | undefined;
        if (!row || row.state !== "approved" || !equalVerifier(row.claim_verifier, claimCredentialVerifier(claimCredential))) {
          throw new PairingRegistryAuthenticationError("AUTHENTICATION_FAILED");
        }
        const capabilities = JSON.stringify(CAPABILITIES);
        database.prepare(`INSERT INTO credentials(
          credential_id, device_id, device_name, verifier, capabilities, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(row.credential_id, row.device_id, row.device_name, row.credential_verifier,
            capabilities, current, current + CREDENTIAL_TTL_MS);
        const consumed = database.prepare("UPDATE pairing_requests SET state = 'consumed', consumed_at_ms = ? WHERE request_id = ? AND state = 'approved'")
          .run(current, requestId);
        if (consumed.changes !== 1) throw new PairingRegistryConflictError("pairing request was already claimed");
        database.exec("COMMIT");
        return this.deviceRecord({
          credential_id: row.credential_id, device_id: row.device_id, device_name: row.device_name,
          verifier: row.credential_verifier, capabilities, created_at_ms: current,
          expires_at_ms: current + CREDENTIAL_TTL_MS, last_used_at_ms: null,
          revoked_at_ms: null, replaced_by: null,
        });
      } catch (error) {
        rollback(database);
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY" || (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new PairingRegistryConflictError("pairing identity was already used");
        }
        throw error;
      }
    });
  }

  authenticate(credentialId: string, credential: string, capability: DeviceCapability): DeviceRecord {
    requireIdentifier(credentialId);
    if (credential.length < 40 || credential.length > 200) throw new PairingRegistryAuthenticationError("AUTHENTICATION_FAILED");
    return this.use((database) => {
      const current = this.now();
      database.exec("BEGIN IMMEDIATE");
      let expired = false;
      let result: DeviceRecord | undefined;
      try {
        const row = database.prepare("SELECT * FROM credentials WHERE credential_id = ?").get(credentialId) as CredentialRow | undefined;
        if (!row || !equalVerifier(row.verifier, deviceCredentialVerifier(credential))) throw new PairingRegistryAuthenticationError("AUTHENTICATION_FAILED");
        if (row.revoked_at_ms !== null) throw new PairingRegistryAuthenticationError("CREDENTIAL_REVOKED");
        if (row.expires_at_ms <= current) {
          this.revokeInDatabase(database, row.credential_id, current, "expired");
          expired = true;
        } else {
          const capabilities = this.capabilities(row.capabilities);
          if (!capabilities.includes(capability)) throw new PairingRegistryAuthenticationError("AUTHENTICATION_FAILED");
          database.prepare("UPDATE credentials SET last_used_at_ms = ? WHERE credential_id = ?").run(current, credentialId);
          result = this.deviceRecord({ ...row, last_used_at_ms: current });
        }
        database.exec("COMMIT");
      } catch (error) { rollback(database); throw error; }
      if (expired) throw new PairingRegistryAuthenticationError("CREDENTIAL_EXPIRED");
      if (!result) throw new PairingRegistryUnavailableError();
      return result;
    });
  }

  rotate(currentCredentialId: string, nextCredentialId: string, nextVerifier: string): DeviceRecord {
    requireIdentifier(currentCredentialId);
    requireIdentifier(nextCredentialId);
    if (!VERIFIER_PATTERN.test(nextVerifier)) throw new PairingRegistryInputError("invalid credential verifier");
    return this.use((database) => {
      const current = this.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare("SELECT * FROM credentials WHERE credential_id = ?").get(currentCredentialId) as CredentialRow | undefined;
        if (!row || row.revoked_at_ms !== null || row.expires_at_ms <= current) throw new PairingRegistryConflictError("credential cannot be rotated");
        database.prepare(`INSERT INTO credentials(
          credential_id, device_id, device_name, verifier, capabilities, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(nextCredentialId, row.device_id, row.device_name, nextVerifier, row.capabilities, current, current + CREDENTIAL_TTL_MS);
        this.revokeInDatabase(database, currentCredentialId, current, "rotation", nextCredentialId);
        database.exec("COMMIT");
        return this.deviceRecord({ ...row, credential_id: nextCredentialId, verifier: nextVerifier,
          created_at_ms: current, expires_at_ms: current + CREDENTIAL_TTL_MS,
          last_used_at_ms: null, revoked_at_ms: null, replaced_by: null });
      } catch (error) {
        rollback(database);
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY" || (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new PairingRegistryConflictError("credential identity was already used");
        }
        throw error;
      }
    });
  }

  revoke(credentialId: string, reason: "self" | "operator"): void {
    requireIdentifier(credentialId);
    this.use((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        this.revokeInDatabase(database, credentialId, this.now(), reason);
        database.exec("COMMIT");
      } catch (error) { rollback(database); throw error; }
    });
  }

  listDevices(): DeviceRecord[] {
    return this.use((database) => (database.prepare("SELECT * FROM credentials ORDER BY created_at_ms DESC LIMIT 500").all() as unknown as CredentialRow[])
      .map((row) => this.deviceRecord(row)));
  }

  private revokeInDatabase(database: DatabaseSync, credentialId: string, current: number, reason: "self" | "operator" | "rotation" | "expired", replacedBy: string | null = null): void {
    const changed = database.prepare("UPDATE credentials SET revoked_at_ms = ?, replaced_by = ? WHERE credential_id = ? AND revoked_at_ms IS NULL")
      .run(current, replacedBy, credentialId);
    if (changed.changes !== 1) throw new PairingRegistryConflictError("credential is absent or already revoked");
    database.prepare("INSERT INTO revocations(credential_id, revoked_at_ms, reason) VALUES (?, ?, ?)").run(credentialId, current, reason);
  }

  private capabilities(value: string): DeviceCapability[] {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new PairingRegistryUnavailableError(); }
    if (!Array.isArray(parsed) || parsed.length !== CAPABILITIES.length || parsed.some((item, index) => item !== CAPABILITIES[index])) {
      throw new PairingRegistryUnavailableError();
    }
    return [...CAPABILITIES];
  }

  private deviceRecord(row: CredentialRow): DeviceRecord {
    return {
      credentialId: row.credential_id, deviceId: row.device_id, deviceName: row.device_name,
      capabilities: this.capabilities(row.capabilities), createdAt: iso(row.created_at_ms),
      expiresAt: iso(row.expires_at_ms), lastUsedAt: row.last_used_at_ms === null ? null : iso(row.last_used_at_ms),
      revokedAt: row.revoked_at_ms === null ? null : iso(row.revoked_at_ms), replacedBy: row.replaced_by,
    };
  }

  close(): void {
    try { this.database?.close(); } finally {
      this.database = null;
      this.available = false;
      if (processRegistry().get(this.key) === this) processRegistry().delete(this.key);
    }
  }
}
