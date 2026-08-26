import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function expectedArtifactNames(version) {
  return [
    `thunderclaw-openclaw-plugin-${version}.tgz`,
    `thunderclaw-thunderbird-${version}.xpi`,
    `thunderclaw-thunderbird-source-${version}.zip`,
  ];
}

export function parseChecksums(contents) {
  const records = new Map();
  for (const line of contents.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([^/]+)$/u.exec(line);
    if (!match || records.has(match[2])) throw new Error(`Invalid checksum record: ${line}`);
    records.set(match[2], match[1]);
  }
  return records;
}

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyMarketplaceRelease({ directory, tag, repository, commit }) {
  if (!releaseTagPattern.test(tag)) throw new Error(`Release tag must have canonical form vX.Y.Z: ${tag}`);
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error(`Release commit must be a full SHA-1: ${commit}`);
  const version = tag.slice(1);
  const expectedNames = expectedArtifactNames(version);
  const expectedReleaseFiles = [...expectedNames, "SHA256SUMS", "release-provenance.json"].sort();
  const actualReleaseFiles = (await readdir(directory)).sort();
  if (JSON.stringify(actualReleaseFiles) !== JSON.stringify(expectedReleaseFiles)) {
    throw new Error(`GitHub release assets must be exactly: ${expectedReleaseFiles.join(", ")}`);
  }
  for (const name of actualReleaseFiles) {
    if (!(await lstat(path.join(directory, name))).isFile()) throw new Error(`Release asset is not a regular file: ${name}`);
  }
  const checksums = parseChecksums(await readFile(path.join(directory, "SHA256SUMS"), "utf8"));
  if (checksums.size !== expectedNames.length || expectedNames.some((name) => !checksums.has(name))) {
    throw new Error(`SHA256SUMS must contain exactly: ${expectedNames.join(", ")}`);
  }

  const verified = [];
  for (const name of expectedNames) {
    const file = path.join(directory, name);
    const actual = await sha256(file);
    if (actual !== checksums.get(name)) throw new Error(`Checksum mismatch for ${name}`);
    verified.push({ name, sha256: actual, size: (await stat(file)).size });
  }

  const provenance = JSON.parse(await readFile(path.join(directory, "release-provenance.json"), "utf8"));
  if (provenance?.format !== "thunderclaw-release-provenance-v1") throw new Error("Unknown release provenance format");
  if (provenance?.source?.repository !== `https://github.com/${repository}`) throw new Error("Release provenance repository mismatch");
  if (provenance?.source?.tag !== tag) throw new Error("Release provenance tag mismatch");
  if (provenance?.source?.commit !== commit) throw new Error("Release provenance commit mismatch");
  if (!Array.isArray(provenance.artifacts) || provenance.artifacts.length !== verified.length) {
    throw new Error("Release provenance artifact set does not match the downloaded bytes");
  }
  const provenanceByName = new Map(provenance.artifacts.map((artifact) => [artifact?.name, artifact]));
  for (const artifact of verified) {
    const recorded = provenanceByName.get(artifact.name);
    if (recorded?.sha256 !== artifact.sha256 || recorded?.size !== artifact.size) {
      throw new Error(`Release provenance metadata mismatch for ${artifact.name}`);
    }
  }
  return { tag, version, commit, artifacts: verified };
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--directory", "--tag", "--repository", "--commit"].includes(key) || !value || values.has(key)) {
      throw new Error("Usage: verify-marketplace-release.mjs --directory <dir> --tag vX.Y.Z --repository owner/repo --commit <sha>");
    }
    values.set(key, value);
  }
  if (values.size !== 4) throw new Error("All release verification arguments are required");
  return Object.fromEntries([...values].map(([key, value]) => [key.slice(2), value]));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyMarketplaceRelease(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
