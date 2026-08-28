import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReleaseTag, releaseComponents } from "./release-metadata.mjs";

export function expectedArtifactNames(component, version) {
  if (!releaseComponents.includes(component)) throw new Error(`Unknown release component: ${component}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`Version must have canonical form X.Y.Z: ${version}`);
  }
  return component === "openclaw-plugin"
    ? [`thunderclaw-openclaw-plugin-${version}.tgz`]
    : [`thunderclaw-thunderbird-${version}.xpi`, `thunderclaw-thunderbird-source-${version}.zip`];
}

export function parseChecksums(contents) {
  if (typeof contents !== "string" || !contents.endsWith("\n")) {
    throw new Error("SHA256SUMS must be newline-terminated text");
  }
  const records = new Map();
  for (const line of contents.slice(0, -1).split("\n")) {
    const match = /^([a-f0-9]{64})  ([^/]+)$/u.exec(line);
    if (!match || records.has(match[2])) throw new Error(`Invalid checksum record: ${line}`);
    records.set(match[2], match[1]);
  }
  return records;
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateReleaseProvenance(provenance, { component, tag, repository, commit, artifacts }) {
  const releaseWorkflow = component === "openclaw-plugin" ? "release-openclaw-plugin.yml" : "release.yml";
  const expectedWorkflow = `${repository}/.github/workflows/${releaseWorkflow}@refs/tags/${tag}`;
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const runPattern = new RegExp(`^https://github\\.com/${escapedRepository}/actions/runs/[1-9]\\d*$`, "u");
  if (!hasExactKeys(provenance, ["format", "component", "source", "build", "artifacts"])
      || provenance.format !== "thunderclaw-release-provenance-v2" || provenance.component !== component) {
    throw new Error("Release provenance must use the strict component-specific v2 schema");
  }
  if (!hasExactKeys(provenance.source, ["repository", "tag", "commit"])
      || provenance.source.repository !== `https://github.com/${repository}`
      || provenance.source.tag !== tag || provenance.source.commit !== commit) {
    throw new Error("Release provenance source identity mismatch");
  }
  if (!hasExactKeys(provenance.build, ["workflow", "run", "attempt"])
      || provenance.build.workflow !== expectedWorkflow
      || typeof provenance.build.run !== "string" || !runPattern.test(provenance.build.run)
      || !Number.isSafeInteger(provenance.build.attempt) || provenance.build.attempt < 1) {
    throw new Error("Release provenance build identity is malformed");
  }
  if (!Array.isArray(provenance.artifacts) || provenance.artifacts.length !== artifacts.length) {
    throw new Error("Release provenance artifact set does not match the downloaded bytes");
  }
  for (const [index, artifact] of artifacts.entries()) {
    const recorded = provenance.artifacts[index];
    if (!hasExactKeys(recorded, ["name", "sha256", "size"])
        || recorded.name !== artifact.name || recorded.sha256 !== artifact.sha256
        || recorded.size !== artifact.size) {
      throw new Error(`Release provenance metadata mismatch for ${artifact.name}`);
    }
  }
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyMarketplaceRelease({ directory, component, tag, repository, commit }) {
  if (!releaseComponents.includes(component)) throw new Error(`Unknown release component: ${component}`);
  const parsedTag = parseReleaseTag(tag);
  if (parsedTag.component !== component) throw new Error("Release tag component does not match --component");
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error(`Release commit must be a full SHA-1: ${commit}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Repository must have owner/name form");

  const expectedNames = expectedArtifactNames(component, parsedTag.version);
  const expectedReleaseFiles = [...expectedNames, "SHA256SUMS", "release-notes.md", "release-provenance.json"].sort();
  const actualReleaseFiles = (await readdir(directory)).sort();
  if (JSON.stringify(actualReleaseFiles) !== JSON.stringify(expectedReleaseFiles)) {
    throw new Error(`GitHub release assets must be exactly: ${expectedReleaseFiles.join(", ")}`);
  }
  for (const name of actualReleaseFiles) {
    if (!(await lstat(path.join(directory, name))).isFile()) throw new Error(`Release asset is not a regular file: ${name}`);
  }
  if ((await readFile(path.join(directory, "release-notes.md"), "utf8")).trim().length === 0) {
    throw new Error("release-notes.md must be non-empty");
  }

  const checksums = parseChecksums(await readFile(path.join(directory, "SHA256SUMS"), "utf8"));
  if (checksums.size !== expectedNames.length || expectedNames.some((name) => !checksums.has(name))) {
    throw new Error(`SHA256SUMS must contain exactly: ${expectedNames.join(", ")}`);
  }
  const artifacts = [];
  for (const name of expectedNames) {
    const file = path.join(directory, name);
    const actual = await sha256(file);
    if (actual !== checksums.get(name)) throw new Error(`Checksum mismatch for ${name}`);
    artifacts.push({ name, sha256: actual, size: (await stat(file)).size });
  }

  const provenance = JSON.parse(await readFile(path.join(directory, "release-provenance.json"), "utf8"));
  validateReleaseProvenance(provenance, { component, tag, repository, commit, artifacts });
  return { component, tag, version: parsedTag.version, commit, artifacts };
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--directory", "--component", "--tag", "--repository", "--commit"].includes(key)
        || !value || values.has(key)) {
      throw new Error("Usage: verify-marketplace-release.mjs --directory <dir> --component <component> --tag <component-vX.Y.Z> --repository owner/repo --commit <sha>");
    }
    values.set(key, value);
  }
  if (values.size !== 5) throw new Error("All release verification arguments are required");
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
