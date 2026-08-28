import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyClawHubRelease } from "./verify-marketplace-notes.mjs";

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--package", "--version", "--artifact", "--repository", "--tag", "--commit", "--api-base"].includes(key)
        || !value || values.has(key)) {
      throw new Error("Usage: verify-legacy-clawhub-release.mjs --package <name> --version X.Y.Z --artifact <path> --repository owner/repo --tag <tag> --commit <sha> [--api-base <url>]");
    }
    values.set(key, value);
  }
  for (const required of ["--package", "--version", "--artifact", "--repository", "--tag", "--commit"]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  const tag = values.get("--tag");
  const version = values.get("--version");
  if (!["v0.1.0", "v0.1.1"].includes(tag) || tag !== `v${version}`) {
    throw new Error("Legacy ClawHub verification is limited to immutable v0.1.0 and v0.1.1 releases");
  }
  return {
    packageName: values.get("--package"), version, artifact: values.get("--artifact"),
    repository: values.get("--repository"), tag, commit: values.get("--commit"),
    ...(values.has("--api-base") ? { apiBase: values.get("--api-base") } : {}),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyClawHubRelease(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ...result, historicalChangelogStatus: "not-retroactively-repairable" })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
