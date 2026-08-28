import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function normalizeMarketplaceNotes(value) {
  if (typeof value !== "string") throw new Error("Marketplace release notes must be a string");
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
}

export function verifyMarketplaceNotes(expected, actual, marketplace) {
  const normalizedExpected = normalizeMarketplaceNotes(expected);
  const normalizedActual = normalizeMarketplaceNotes(actual);
  if (!normalizedExpected) throw new Error("Canonical component release notes must not be empty");
  if (normalizedActual !== normalizedExpected) {
    throw new Error(`${marketplace} release notes do not exactly match the canonical component release notes after normalization`);
  }
  return normalizedExpected;
}

export async function verifyClawHubRelease({ packageName, version, notesFile, artifact, repository, tag, commit, apiBase = "https://clawhub.ai", fetchImpl = fetch, pollIntervalMs = 5_000, timeoutMs = 5 * 60_000 }) {
  const endpoint = `${apiBase.replace(/\/$/u, "")}/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`;
  const expected = notesFile ? await readFile(notesFile, "utf8") : null;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      const response = await fetchImpl(endpoint, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`ClawHub public API returned HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.package?.name !== packageName || payload?.version?.version !== version) {
        throw new Error("ClawHub public API returned the wrong package version");
      }
      if (expected !== null) verifyMarketplaceNotes(expected, payload?.version?.changelog, "ClawHub");
      const artifactBytes = await readFile(artifact);
      const expectedSha256 = createHash("sha256").update(artifactBytes).digest("hex");
      if (payload?.version?.artifact?.sha256 !== expectedSha256
          || payload?.version?.artifact?.size !== artifactBytes.byteLength) {
        throw new Error("ClawHub public artifact does not match the qualified plugin archive");
      }
      const downloadEndpoint = `${apiBase.replace(/\/$/u, "")}/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}/artifact/download`;
      const download = await fetchImpl(downloadEndpoint, { headers: { accept: "application/octet-stream" } });
      if (!download.ok) throw new Error(`ClawHub artifact download returned HTTP ${download.status}`);
      const downloadedBytes = Buffer.from(await download.arrayBuffer());
      if (downloadedBytes.byteLength !== artifactBytes.byteLength
          || createHash("sha256").update(downloadedBytes).digest("hex") !== expectedSha256) {
        throw new Error("ClawHub served artifact bytes do not match the qualified plugin archive");
      }
      const verification = payload?.version?.verification;
      if (verification?.sourceRepo !== repository || verification?.sourceTag !== tag
          || verification?.sourceCommit !== commit || verification?.scanStatus !== "clean") {
        throw new Error("ClawHub public source or scan state does not match the qualified release");
      }
      return { packageName, version, changelogVerified: expected !== null, artifactVerified: true, sourceVerified: true, endpoint };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);
  throw lastError;
}

export async function verifyClawHubReleaseNotes(options) {
  if (!options.notesFile) throw new Error("Canonical component release notes are required");
  return verifyClawHubRelease(options);
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--package", "--version", "--notes-file", "--artifact", "--repository", "--tag", "--commit", "--api-base"].includes(key) || !value || values.has(key)) {
      throw new Error("Usage: verify-marketplace-notes.mjs --package <name> --version X.Y.Z --notes-file <path> --artifact <path> --repository owner/repo --tag <tag> --commit <sha> [--api-base <url>]");
    }
    values.set(key, value);
  }
  for (const required of ["--package", "--version", "--notes-file", "--artifact", "--repository", "--tag", "--commit"]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    packageName: values.get("--package"),
    version: values.get("--version"),
    notesFile: values.get("--notes-file"),
    artifact: values.get("--artifact"),
    repository: values.get("--repository"),
    tag: values.get("--tag"),
    commit: values.get("--commit"),
    ...(values.has("--api-base") ? { apiBase: values.get("--api-base") } : {}),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyClawHubReleaseNotes(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
