import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOpenClawQualification } from "./openclaw-qualification.mjs";

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} failed with status ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function readArchivePackage(archive) {
  const result = spawnSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("Provider archive does not contain package/package.json");
  return JSON.parse(result.stdout);
}

async function verifyArchive(archive, provider) {
  const metadata = await lstat(archive);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("Provider archive must be one unlinked regular file");
  }
  const bytes = await readFile(archive);
  const actualIntegrity = sha512Integrity(bytes);
  if (actualIntegrity !== provider.integrity) throw new Error("Provider archive integrity does not match the qualification ledger");
  const packageManifest = readArchivePackage(archive);
  if (packageManifest.name !== provider.package || packageManifest.version !== provider.version) {
    throw new Error("Provider archive package identity does not match the qualification ledger");
  }
  return { package: provider.package, version: provider.version, integrity: actualIntegrity, size: bytes.length };
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new Error("Usage: stage-openclaw-provider.mjs --output <archive.tgz>");
  }
  return path.resolve(args[1]);
}

async function stage(output) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { provider } = await readOpenClawQualification(root);
  try {
    const existing = await verifyArchive(output, provider);
    return { ...existing, output, reused: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-provider-stage-"));
  try {
    const packed = JSON.parse(command("npm", ["pack", `${provider.package}@${provider.version}`, "--json", "--ignore-scripts",
      "--pack-destination", temporary]));
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== "string") {
      throw new Error("npm pack did not return exactly one provider archive");
    }
    const source = path.join(temporary, packed[0].filename);
    const verified = await verifyArchive(source, provider);
    await copyFile(source, output, constants.COPYFILE_EXCL);
    await chmod(output, 0o644);
    const staged = await verifyArchive(output, provider);
    return { ...staged, output, reused: false, sourceSize: verified.size };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await stage(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
