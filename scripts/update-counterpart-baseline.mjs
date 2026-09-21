import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseTag } from "./release-metadata.mjs";
import { validateCounterpartBaselines } from "./verify-counterpart-baseline.mjs";
import { verifyMarketplaceRelease } from "./verify-marketplace-release.mjs";

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function baselineVersion(tag) {
  const match = /^(?:v|openclaw-plugin-v|thunderbird-extension-v)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(tag);
  if (!match) throw new Error(`Invalid counterpart baseline tag: ${tag}`);
  return match[1];
}

export function updateCounterpartManifest(manifestValue, verifiedRelease) {
  const manifest = structuredClone(validateCounterpartBaselines(manifestValue));
  const { component, tag, version, artifacts } = verifiedRelease;
  if (!["openclaw-plugin", "thunderbird-extension"].includes(component)) throw new Error(`Unknown release component: ${component}`);
  const parsed = parseReleaseTag(tag);
  if (parsed.component !== component || parsed.version !== version) throw new Error("Verified release identity is inconsistent");
  const current = baselineVersion(manifest[component].tag);
  if (compareVersions(version, current) <= 0) {
    throw new Error(`Counterpart baseline update must advance ${component} beyond ${current}`);
  }
  const expectedName = component === "openclaw-plugin"
    ? `thunderclaw-openclaw-plugin-${version}.tgz`
    : `thunderclaw-thunderbird-${version}.xpi`;
  const artifact = artifacts.find((candidate) => candidate.name === expectedName);
  if (!artifact || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) {
    throw new Error(`Verified release does not contain ${expectedName}`);
  }
  manifest[component] = { tag, name: artifact.name, sha256: artifact.sha256, size: artifact.size };
  return validateCounterpartBaselines(manifest);
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${program} failed with status ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function resolveTagCommit(repository, tag) {
  let object = JSON.parse(command("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`])).object;
  for (let depth = 0; depth < 4 && object?.type === "tag"; depth += 1) {
    object = JSON.parse(command("gh", ["api", `repos/${repository}/git/tags/${object.sha}`])).object;
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/u.test(object.sha)) {
    throw new Error(`Cannot resolve ${tag} to a release commit`);
  }
  return object.sha;
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--tag", "--repository"].includes(option) || !value || values.has(option)) {
      throw new Error("Usage: update-counterpart-baseline.mjs --tag <component-vX.Y.Z> --repository <owner/repo>");
    }
    values.set(option, value);
  }
  if (values.size !== 2 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.get("--repository"))) {
    throw new Error("Usage: update-counterpart-baseline.mjs --tag <component-vX.Y.Z> --repository <owner/repo>");
  }
  return { tag: values.get("--tag"), repository: values.get("--repository") };
}

async function main(args) {
  const { tag, repository } = parseArguments(args);
  const { component } = parseReleaseTag(tag);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = path.join(root, "e2e/qualification/counterpart-baselines.json");
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-counterpart-update-"));
  try {
    command("gh", ["release", "download", tag, "--repo", repository, "--dir", directory]);
    const commit = resolveTagCommit(repository, tag);
    const verified = await verifyMarketplaceRelease({ directory, component, tag, repository, commit });
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    const updated = updateCounterpartManifest(current, verified);
    await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8" });
    return { component, tag, commit, baseline: updated[component] };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
