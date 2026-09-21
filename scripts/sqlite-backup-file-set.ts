export interface SQLiteBackupFileSet {
  databaseEntry: string;
  walEntries: string[];
  shmEntries: string[];
  databaseEntries: string[];
}

export interface SQLiteFileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  nlink: number;
  mode: number;
}

export function safeArchiveEntry(entry: string): boolean {
  return entry.length > 0
    && !entry.startsWith("/")
    && !entry.startsWith("-")
    && !entry.split("/").includes("..")
    && !entry.includes("\\")
    && !/[\u0000-\u001F\u007F]/u.test(entry);
}

export function selectSQLiteBackupFileSet(entries: string[], suffix: string): SQLiteBackupFileSet {
  if (!entries.every(safeArchiveEntry)) throw new Error("the recovery archive contains an unsafe path");
  const databaseEntries = entries.filter((entry) => entry.endsWith(suffix));
  if (databaseEntries.length !== 1) {
    throw new Error("the recovery archive does not contain exactly one current pairing registry");
  }
  const databaseEntry = databaseEntries[0];
  const walEntries = entries.filter((entry) => entry === `${databaseEntry}-wal`);
  const shmEntries = entries.filter((entry) => entry === `${databaseEntry}-shm`);
  if (walEntries.length > 1 || shmEntries.length > 1 || (shmEntries.length === 1 && walEntries.length !== 1)) {
    throw new Error("the recovery archive contains an inconsistent SQLite file set");
  }
  return { databaseEntry, walEntries, shmEntries, databaseEntries: [databaseEntry, ...walEntries, ...shmEntries] };
}

export function isPrivateRegularSQLiteFile(stat: SQLiteFileStat): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600;
}

export function extractSQLiteBackupFileSet(
  archive: string,
  extraction: string,
  entries: string[],
  suffix: string,
): SQLiteBackupFileSet {
  const fileSet = selectSQLiteBackupFileSet(entries, suffix);
  const result = spawnSync("tar", ["-xzf", archive, "-C", extraction, "--", ...fileSet.databaseEntries], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar failed with status ${result.status}`);
  return fileSet;
}
import { spawnSync } from "node:child_process";
