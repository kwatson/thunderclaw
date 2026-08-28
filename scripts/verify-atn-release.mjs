import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyMarketplaceNotes } from "./verify-marketplace-notes.mjs";

function english(value) {
  if (typeof value === "string") return value;
  return value?.["en-US"] ?? value?.en_US ?? value?.en;
}

export async function verifyAtnRelease({ version, notesFile, xpi, downloadOutput, apiBase = "https://addons.thunderbird.net/api/v4", fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiBase.replace(/\/$/u, "")}/addons/addon/thunderclaw%40addons.thunderbird.net/versions/`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`ATN public API returned HTTP ${response.status}`);
  const payload = await response.json();
  const record = payload?.results?.find((candidate) => candidate?.version === version);
  if (!record) throw new Error(`ATN public API did not return Thunderbird extension ${version}`);
  verifyMarketplaceNotes(await readFile(notesFile, "utf8"), english(record.release_notes), "ATN");
  const qualifiedBytes = await readFile(xpi);
  const qualifiedSha256 = createHash("sha256").update(qualifiedBytes).digest("hex");
  const file = record.files?.find((candidate) => candidate?.status === "public");
  if (!/^sha256:[a-f0-9]{64}$/u.test(file?.hash) || !Number.isSafeInteger(file?.size) || file.size <= 0) {
    throw new Error("ATN public XPI metadata is invalid");
  }
  const downloadUrl = new URL(file.url);
  if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "addons.thunderbird.net") {
    throw new Error("ATN returned an untrusted public XPI URL");
  }
  const download = await fetchImpl(downloadUrl, { headers: { accept: "application/x-xpinstall" } });
  if (!download.ok) throw new Error(`ATN public XPI download returned HTTP ${download.status}`);
  const downloaded = Buffer.from(await download.arrayBuffer());
  const signedSha256 = createHash("sha256").update(downloaded).digest("hex");
  if (downloaded.byteLength !== file.size || `sha256:${signedSha256}` !== file.hash) {
    throw new Error("ATN served XPI bytes do not match its public metadata");
  }
  if (downloadOutput) await writeFile(downloadOutput, downloaded, { flag: "wx" });
  return {
    version,
    releaseNotesVerified: true,
    signedXpiVerified: true,
    qualifiedXpiSha256: qualifiedSha256,
    signedXpiSha256: signedSha256,
    signedXpiSize: downloaded.byteLength,
    reviewerSourceVerification: "manual",
    reviewerTestingNotesVerification: "manual",
  };
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--version", "--notes-file", "--xpi", "--download-output", "--api-base"].includes(key) || !value || values.has(key)) {
      throw new Error("Usage: verify-atn-release.mjs --version X.Y.Z --notes-file <path> --xpi <path> [--download-output <path>] [--api-base <url>]");
    }
    values.set(key, value);
  }
  for (const required of ["--version", "--notes-file", "--xpi"]) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    version: values.get("--version"),
    notesFile: values.get("--notes-file"),
    xpi: values.get("--xpi"),
    ...(values.has("--download-output") ? { downloadOutput: values.get("--download-output") } : {}),
    ...(values.has("--api-base") ? { apiBase: values.get("--api-base") } : {}),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await verifyAtnRelease(parseArguments(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
