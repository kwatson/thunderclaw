import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CLAWHUB_PUBLICATION_TIMEOUT_MS = 60 * 60_000;

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

export class ClawHubPendingError extends Error {
  constructor(message) { super(message); this.name = "ClawHubPendingError"; this.retryable = true; }
}

// Bound both the connection and body read, including injected clients that ignore abort.
async function publicRequest(fetchImpl, url, accept, requestTimeoutMs, bodyType) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let response;
        try { response = await fetchImpl(url, { headers: { accept }, signal: controller.signal }); }
        catch (error) { throw new ClawHubPendingError(`ClawHub public request unavailable: ${error.message}`); }
        if (!response.ok) {
          const message = `ClawHub public API returned HTTP ${response.status}`;
          if ([404, 408, 429].includes(response.status) || response.status >= 500) throw new ClawHubPendingError(message);
          throw new Error(message);
        }
        return response[bodyType]();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ClawHubPendingError("ClawHub public request deadline exceeded")); }, requestTimeoutMs); }),
    ]);
  } catch (error) {
    // Interrupted bodies are availability failures; malformed published JSON is terminal.
    if (error.name === "AbortError" || error instanceof TypeError) throw new ClawHubPendingError(`ClawHub public response unavailable: ${error.message}`);
    throw error;
  } finally { clearTimeout(timer); }
}

export async function verifyClawHubRelease({ packageName, version, notesFile, artifact, repository, tag, commit, apiBase = "https://clawhub.ai", fetchImpl = fetch, pollIntervalMs = 5_000, timeoutMs = CLAWHUB_PUBLICATION_TIMEOUT_MS, requestTimeoutMs = 30_000 }) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("Invalid ClawHub request timeout");
  const endpoint = `${apiBase.replace(/\/$/u, "")}/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`;
  const expected = notesFile ? await readFile(notesFile, "utf8") : null;
  const artifactBytes = await readFile(artifact);
  const expectedSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      // A zero polling budget still permits one bounded probe.
      const budget = () => Math.max(1, Math.min(requestTimeoutMs, timeoutMs === 0 ? requestTimeoutMs : deadline - Date.now()));
      const payload = await publicRequest(fetchImpl, endpoint, "application/json", budget(), "json");
      if (payload?.package?.name !== packageName || payload?.version?.version !== version) throw new Error("ClawHub public API returned the wrong package version");
      const verification = payload?.version?.verification;
      const sourceTagMatches = verification?.sourceTag === tag || verification?.sourceTag === `refs/tags/${tag}`;
      const scanPending = ["pending", "queued", "scanning", "processing"].includes(verification?.scanStatus);
      if (scanPending) {
        // Incomplete scan records may omit metadata, but known mismatches remain terminal.
        if ((verification.sourceRepo !== undefined && verification.sourceRepo !== repository)
            || (verification.sourceTag !== undefined && !sourceTagMatches)
            || (verification.sourceCommit !== undefined && verification.sourceCommit !== commit)) throw new Error("ClawHub public source or scan state does not match the qualified release");
        if (expected !== null && payload.version.changelog !== undefined) verifyMarketplaceNotes(expected, payload.version.changelog, "ClawHub");
        const publishedArtifact = payload.version.artifact;
        if ((publishedArtifact?.sha256 !== undefined && publishedArtifact.sha256 !== expectedSha256)
            || (publishedArtifact?.size !== undefined && publishedArtifact.size !== artifactBytes.byteLength)) throw new Error("ClawHub public artifact does not match the qualified plugin archive");
        throw new ClawHubPendingError("ClawHub accepted publication scan is still pending");
      }
      if (verification?.sourceRepo !== repository || !sourceTagMatches || verification?.sourceCommit !== commit) throw new Error("ClawHub public source or scan state does not match the qualified release");
      if (expected !== null) verifyMarketplaceNotes(expected, payload?.version?.changelog, "ClawHub");
      if (payload?.version?.artifact?.sha256 !== expectedSha256 || payload?.version?.artifact?.size !== artifactBytes.byteLength) throw new Error("ClawHub public artifact does not match the qualified plugin archive");
      if (verification?.scanStatus !== "clean") throw new Error("ClawHub public source or scan state does not match the qualified release");
      const downloadEndpoint = `${endpoint}/artifact/download`;
      const downloadedBytes = Buffer.from(await publicRequest(fetchImpl, downloadEndpoint, "application/octet-stream", budget(), "arrayBuffer"));
      if (downloadedBytes.byteLength !== artifactBytes.byteLength || createHash("sha256").update(downloadedBytes).digest("hex") !== expectedSha256) throw new Error("ClawHub served artifact bytes do not match the qualified plugin archive");
      return { packageName, version, changelogVerified: expected !== null, artifactVerified: true, sourceVerified: true, endpoint };
    } catch (error) {
      if (!(error instanceof ClawHubPendingError)) throw error;
      lastError = error;
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw lastError;
}

export async function verifyClawHubReleaseNotes(options) {
  if (!options.notesFile) throw new Error("Canonical component release notes are required");
  return verifyClawHubRelease(options);
}

export function parseMarketplaceVerificationArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--package", "--version", "--notes-file", "--artifact", "--repository", "--tag", "--commit", "--api-base", "--timeout-ms"].includes(key) || !value || values.has(key)) {
      throw new Error("Usage: verify-marketplace-notes.mjs --package <name> --version X.Y.Z --notes-file <path> --artifact <path> --repository owner/repo --tag <tag> --commit <sha> [--api-base <url>] [--timeout-ms <0..3600000>]");
    }
    values.set(key, value);
  }
  for (const required of ["--package", "--version", "--notes-file", "--artifact", "--repository", "--tag", "--commit"]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  const timeout = values.get("--timeout-ms");
  if (timeout !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(timeout)
      || !Number.isSafeInteger(Number(timeout)) || Number(timeout) > CLAWHUB_PUBLICATION_TIMEOUT_MS)) {
    throw new Error("ClawHub timeout must be an integer from 0 through 3600000 milliseconds");
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
    ...(timeout !== undefined ? { timeoutMs: Number(timeout) } : {}),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyClawHubReleaseNotes(parseMarketplaceVerificationArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof ClawHubPendingError ? 75 : 1;
  }
}
