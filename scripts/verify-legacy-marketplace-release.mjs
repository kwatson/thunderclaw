import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateReleaseBaselines } from "./validate-release-baselines.mjs";
import { verifyMarketplaceReleaseV1 } from "./verify-marketplace-release-v1.mjs";

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyLegacyMarketplaceRelease({ directory, tag, repository, commit, ledgerPath }) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const ledger = validateReleaseBaselines(JSON.parse(await readFile(
    ledgerPath ?? path.join(root, "release-baselines.json"), "utf8",
  )));
  if (`https://github.com/${repository}` !== ledger.repository) {
    throw new Error("Legacy release repository does not match the immutable ledger");
  }
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  const releases = ledger.releases.filter((release) => release.version === version && release.legacyTag === tag);
  if (releases.length !== 2 || releases.some((release) => release.commit !== commit)) {
    throw new Error("Legacy release tag or commit does not match the immutable ledger");
  }
  const assets = new Map();
  for (const release of releases) {
    for (const asset of release.assets) {
      const existing = assets.get(asset.name);
      if (existing && (existing.size !== asset.size || existing.sha256 !== asset.sha256)) {
        throw new Error(`Legacy ledger disagrees about ${asset.name}`);
      }
      assets.set(asset.name, asset);
    }
  }
  for (const asset of assets.values()) {
    const file = path.join(directory, asset.name);
    const details = await stat(file);
    if (!details.isFile() || details.size !== asset.size || await sha256(file) !== asset.sha256) {
      throw new Error(`Legacy release asset does not match the immutable ledger: ${asset.name}`);
    }
  }
  return verifyMarketplaceReleaseV1({ directory, tag, repository, commit });
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--directory", "--tag", "--repository", "--commit", "--ledger"].includes(key)
        || !value || values.has(key)) {
      throw new Error("Usage: verify-legacy-marketplace-release.mjs --directory <dir> --tag v0.1.<0|1> --repository owner/repo --commit <sha> [--ledger <path>]");
    }
    values.set(key, value);
  }
  for (const required of ["--directory", "--tag", "--repository", "--commit"]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    directory: values.get("--directory"), tag: values.get("--tag"),
    repository: values.get("--repository"), commit: values.get("--commit"),
    ...(values.has("--ledger") ? { ledgerPath: values.get("--ledger") } : {}),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await verifyLegacyMarketplaceRelease(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
