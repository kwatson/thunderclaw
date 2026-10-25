import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifestVersions } from "./release-metadata.mjs";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const repository = "kwatson/thunderclaw";

function ghIdentityExists(endpoint, root) {
  const result = spawnSync("gh", ["api", endpoint], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return true;
  if (result.stderr?.includes("(HTTP 404)")) return false;
  throw new Error("Cannot establish GitHub publication identity; check GitHub access before preparing a version");
}

export async function inspectPublication({ root, tag, version, fetchImpl = fetch }) {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  if (remote.status !== 0 || !/^(?:git@github\.com:|https:\/\/github\.com\/)kwatson\/thunderclaw(?:\.git)?\s*$/u.test(remote.stdout)) {
    throw new Error("Release preparation requires the verified kwatson/thunderclaw origin");
  }
  const localTag = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { cwd: root });
  if (localTag.status === 0) return { exists: true, evidence: "local tag" };
  if (localTag.status !== 1) throw new Error("Cannot inspect local release tags");
  for (const endpoint of [`repos/${repository}/git/ref/tags/${tag}`, `repos/${repository}/releases/tags/${tag}`]) {
    if (ghIdentityExists(endpoint, root)) return { exists: true, evidence: "GitHub tag or release" };
  }
  const response = await fetchImpl(`https://addons.thunderbird.net/api/v4/addons/addon/thunderclaw%40addons.thunderbird.net/versions/?fresh=${Date.now()}`, {
    cache: "no-store", headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Cannot establish public ATN version identity");
  const payload = await response.json();
  if (!Array.isArray(payload?.results)) throw new Error("Cannot establish public ATN version identity");
  if (payload.results.some((record) => record?.version === version)) return { exists: true, evidence: "public ATN version" };
  // Preparation only accepts a version newer than the checkout. A paginated result cannot prove its absence.
  if (payload.next) throw new Error("ATN version history is paginated; publication identity is unknown");
  return { exists: false };
}

export async function prepareNextRelease({ root, version, inspect = inspectPublication, date = new Date().toISOString().slice(0, 10), io = { writeFile, rename } }) {
  if (!versionPattern.test(version)) throw new Error("Version must have canonical form X.Y.Z");
  const files = ["packages/thunderbird-extension/package.json", "packages/thunderbird-extension/src/manifest.json", "package-lock.json", "CHANGELOG.md"];
  const originals = await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")));
  const [workspace, manifest, lock] = originals.slice(0, 3).map((text) => JSON.parse(text));
  const current = workspace.version;
  if (!versionPattern.test(current)) throw new Error("Current extension version is invalid");
  validateManifestVersions(current, { manifest: manifest.version, lock: lock.packages?.["packages/thunderbird-extension"]?.version });
  const before = current.split(".").map(BigInt); const after = version.split(".").map(BigInt);
  const differing = after.findIndex((part, index) => part !== before[index]);
  if (differing < 0 || after[differing] < before[differing]) throw new Error(`New version must increase ${current}`);
  if (originals[3].includes(`## Thunderbird extension [${version}]`)) throw new Error("Changelog already contains this version");
  const tag = `thunderbird-extension-v${version}`;
  const identity = await inspect({ root, tag, version });
  if (identity.exists !== false) throw new Error(`Version identity already exists or is unknown${identity.evidence ? `: ${identity.evidence}` : ""}`);
  workspace.version = version; manifest.version = version; lock.packages["packages/thunderbird-extension"].version = version;
  const heading = /^# Changelog[^\n]*\n/u.exec(originals[3]);
  if (!heading) throw new Error("Changelog must begin with # Changelog");
  const section = `\n## Thunderbird extension [${version}] - ${date}\n\n<!-- release:prepare draft; replace this marker and TODO with reviewed release notes before tagging. -->\n\n- TODO: describe the shipped extension change.\n`;
  const updated = [workspace, manifest, lock].map((value) => `${JSON.stringify(value, null, 2)}\n`);
  const firstSection = /^## /mu.exec(originals[3]);
  const insertion = firstSection ? firstSection.index : originals[3].length;
  const preamble = originals[3].slice(0, insertion).replace(/\n*$/u, "\n");
  updated.push(`${preamble}${section}\n${originals[3].slice(insertion)}`);
  // Stage complete replacements and backups before changing any release file.
  const transaction = await mkdtemp(path.join(root, ".thunderclaw-release-prepare-"));
  const replaced = [];
  let preserveBackups = false;
  try {
    for (const [index, file] of files.entries()) {
      const mode = (await stat(path.join(root, file))).mode;
      await io.writeFile(path.join(transaction, `original-${index}`), originals[index], { flag: "wx", mode });
      await io.writeFile(path.join(transaction, `next-${index}`), updated[index], { flag: "wx", mode });
    }
    // Refuse edits made while public identity or staging was being checked.
    for (const [index, file] of files.entries()) {
      if (await readFile(path.join(root, file), "utf8") !== originals[index]) throw new Error("Release files changed during preparation; retry after reviewing them");
    }
    try {
      for (const [index, file] of files.entries()) {
        await io.rename(path.join(transaction, `next-${index}`), path.join(root, file));
        replaced.push(index);
      }
    } catch (error) {
      try {
        for (const index of replaced.reverse()) await io.rename(path.join(transaction, `original-${index}`), path.join(root, files[index]));
      } catch (rollbackError) {
        preserveBackups = true;
        throw new Error(`Release preparation failed and originals could not be fully restored; backups retained at ${transaction}`, { cause: rollbackError });
      }
      throw error;
    }
  } finally {
    if (!preserveBackups) await rm(transaction, { recursive: true, force: true });
  }
  return { version, tag, files, releaseNotes: "draft: review and replace the changelog marker before tagging" };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      process.stdout.write("Usage: npm run release:prepare -- X.Y.Z\nUpdates extension versions and adds a changelog draft after checking publication identity. Creates no commit, tag, or release.\n");
    } else {
    if (process.argv.length !== 3) throw new Error("Usage: npm run release:prepare -- X.Y.Z");
    process.stdout.write(`${JSON.stringify(await prepareNextRelease({ root: process.cwd(), version: process.argv[2] }), null, 2)}\n`);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
