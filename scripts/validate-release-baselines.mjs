import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseComponents } from "./release-metadata.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateReleaseBaselines(ledger) {
  if (!exactKeys(ledger, ["format", "repository", "releases"])
      || ledger.format !== "thunderclaw-legacy-release-baselines-v1"
      || ledger.repository !== "https://github.com/kwatson/thunderclaw"
      || !Array.isArray(ledger.releases)) {
    throw new Error("Legacy release baseline ledger has an invalid root schema");
  }
  const keys = new Set();
  for (const release of ledger.releases) {
    if (!exactKeys(release, ["component", "version", "legacyTag", "commit", "assets", "provenance", "attestation"])
        || !releaseComponents.includes(release.component) || !versionPattern.test(release.version)
        || release.legacyTag !== `v${release.version}` || !commitPattern.test(release.commit)) {
      throw new Error("Legacy release baseline entry has an invalid identity schema");
    }
    const key = `${release.component}@${release.version}`;
    if (keys.has(key)) throw new Error(`Duplicate legacy release baseline: ${key}`);
    keys.add(key);
    if (!Array.isArray(release.assets) || release.assets.length === 0) throw new Error(`${key} has no pinned assets`);
    const names = new Set();
    for (const asset of release.assets) {
      if (!exactKeys(asset, ["name", "size", "sha256"]) || typeof asset.name !== "string"
          || asset.name.length === 0 || asset.name.includes("/") || names.has(asset.name)
          || !Number.isSafeInteger(asset.size) || asset.size < 1 || !sha256Pattern.test(asset.sha256)) {
        throw new Error(`${key} has an invalid pinned asset`);
      }
      names.add(asset.name);
    }
    if (!exactKeys(release.provenance, ["format", "workflowRun", "attempt"])
        || release.provenance.format !== "thunderclaw-release-provenance-v1"
        || !/^https:\/\/github\.com\/kwatson\/thunderclaw\/actions\/runs\/\d+$/u.test(release.provenance.workflowRun)
        || release.provenance.attempt !== 1) throw new Error(`${key} has invalid provenance identity`);
    if (!exactKeys(release.attestation, ["verified", "issuer", "workflow", "invocation"])
        || release.attestation.verified !== true
        || release.attestation.issuer !== "https://token.actions.githubusercontent.com"
        || release.attestation.workflow !== `kwatson/thunderclaw/.github/workflows/release.yml@refs/tags/${release.legacyTag}`
        || release.attestation.invocation !== `${release.provenance.workflowRun}/attempts/${release.provenance.attempt}`) {
      throw new Error(`${key} has invalid attestation identity`);
    }
  }
  for (const component of releaseComponents) {
    for (const version of ["0.1.0", "0.1.1"]) {
      if (!keys.has(`${component}@${version}`)) throw new Error(`${component}@${version} is not reserved`);
    }
  }
  return ledger;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const ledger = JSON.parse(await readFile(path.join(root, "release-baselines.json"), "utf8"));
    validateReleaseBaselines(ledger);
    process.stdout.write(`${JSON.stringify({ releases: ledger.releases.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
