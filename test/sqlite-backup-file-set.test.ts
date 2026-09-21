import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractSQLiteBackupFileSet,
  isPrivateRegularSQLiteFile,
  safeArchiveEntry,
  selectSQLiteBackupFileSet,
  type SQLiteFileStat,
} from "../scripts/sqlite-backup-file-set.js";

const database = "backup/payload/posix/home/node/.openclaw/plugins/thunderclaw/pairing.sqlite";
const suffix = "/payload/posix/home/node/.openclaw/plugins/thunderclaw/pairing.sqlite";

test("recovery accepts a database alone or a consistent SQLite WAL file set", () => {
  assert.deepEqual(selectSQLiteBackupFileSet([database], suffix).databaseEntries, [database]);
  assert.deepEqual(selectSQLiteBackupFileSet([database, `${database}-wal`], suffix).databaseEntries,
    [database, `${database}-wal`]);
  assert.deepEqual(selectSQLiteBackupFileSet([database, `${database}-wal`, `${database}-shm`], suffix).databaseEntries,
    [database, `${database}-wal`, `${database}-shm`]);
});

test("recovery rejects incomplete, duplicate, and ambiguous SQLite file sets", () => {
  assert.throws(() => selectSQLiteBackupFileSet([`${database}-shm`, database], suffix), /inconsistent SQLite file set/u);
  assert.throws(() => selectSQLiteBackupFileSet([database, `${database}-wal`, `${database}-wal`], suffix), /inconsistent SQLite file set/u);
  assert.throws(() => selectSQLiteBackupFileSet([database, database], suffix), /exactly one current pairing registry/u);
  assert.throws(() => selectSQLiteBackupFileSet(["other.sqlite"], suffix), /exactly one current pairing registry/u);
});

test("recovery rejects unsafe archive paths and non-private SQLite files", () => {
  for (const unsafe of ["/absolute", "-option", "backup/../escape", "backup\\escape", "backup/control\nentry"]) {
    assert.equal(safeArchiveEntry(unsafe), false);
    assert.throws(() => selectSQLiteBackupFileSet([database, unsafe], suffix), /unsafe path/u);
  }
  const stat = (overrides: Partial<SQLiteFileStat> = {}): SQLiteFileStat => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
    mode: 0o100600,
    ...overrides,
  });
  assert.equal(isPrivateRegularSQLiteFile(stat()), true);
  assert.equal(isPrivateRegularSQLiteFile(stat({ isFile: () => false })), false);
  assert.equal(isPrivateRegularSQLiteFile(stat({ isSymbolicLink: () => true })), false);
  assert.equal(isPrivateRegularSQLiteFile(stat({ nlink: 2 })), false);
  assert.equal(isPrivateRegularSQLiteFile(stat({ mode: 0o100640 })), false);
});

test("recovery archive members cannot inject GNU tar options", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-tar-option-test-"));
  try {
    const staging = path.join(directory, "staging");
    const extraction = path.join(directory, "extraction");
    const archive = path.join(directory, "malicious.tar.gz");
    const marker = path.join(directory, "marker");
    const maliciousRoot = `--to-command=touch ${marker} #`;
    const maliciousDatabase = `${maliciousRoot}${suffix}`;
    await mkdir(path.dirname(path.join(staging, maliciousDatabase)), { recursive: true });
    await mkdir(extraction);
    await writeFile(path.join(staging, maliciousDatabase), "synthetic database");
    const created = spawnSync("tar", ["-czf", archive, "-C", staging, "--", maliciousRoot], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    const entries = listed.stdout.trim().split(/\r?\n/u);
    assert.throws(() => extractSQLiteBackupFileSet(archive, extraction, entries, suffix), /unsafe path/u);
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
