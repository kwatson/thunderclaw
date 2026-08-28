import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const signatureGroups = [
  new Set(["META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa"]),
  new Set(["META-INF/cose.manifest", "META-INF/cose.sig"]),
];
const allowedSignatureEntries = new Set(["META-INF/", ...signatureGroups.flatMap((group) => [...group])]);

function listEntries(archive) {
  const output = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  const entries = output.replace(/\r\n?/gu, "\n").split("\n").filter(Boolean);
  if (entries.length === 0) throw new Error("XPI must not be empty");
  const seen = new Set();
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/u.test(entry)
        || entry.includes("\\") || entry.includes("//")
        || entry.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error(`XPI contains an unsafe entry: ${entry}`);
    }
    if (seen.has(entry)) throw new Error(`XPI contains a duplicate entry: ${entry}`);
    seen.add(entry);
  }
  return seen;
}

function readEntry(archive, entry) {
  return execFileSync("unzip", ["-p", archive, entry], { maxBuffer: 16 * 1024 * 1024 });
}

function validateSignatureEntries(extras, publicXpi) {
  if (extras.size === 0) throw new Error("A changed ATN XPI must add complete Mozilla signature metadata");
  for (const entry of extras) {
    if (!allowedSignatureEntries.has(entry)) throw new Error(`ATN XPI contains an unexpected added entry: ${entry}`);
  }
  let completeGroup = false;
  for (const group of signatureGroups) {
    const present = [...group].filter((entry) => extras.has(entry));
    if (present.length !== 0 && present.length !== group.size) {
      throw new Error("ATN XPI contains an incomplete Mozilla signature metadata group");
    }
    if (present.length === group.size) completeGroup = true;
  }
  if (!completeGroup) throw new Error("ATN XPI does not contain a complete Mozilla signature metadata group");
  for (const entry of extras) {
    if (entry.endsWith("/")) continue;
    const bytes = readEntry(publicXpi, entry);
    if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) {
      throw new Error(`ATN signature metadata has an invalid size: ${entry}`);
    }
  }
}

export async function verifyAtnXpiPayload({ qualifiedXpi, publicXpi }) {
  const [qualifiedPath, publicPath] = await Promise.all([realpath(qualifiedXpi), realpath(publicXpi)]);
  const [qualifiedStat, publicStat] = await Promise.all([stat(qualifiedPath), stat(publicPath)]);
  if (!qualifiedStat.isFile() || !publicStat.isFile()) throw new Error("Qualified and public XPIs must be regular files");
  const qualifiedEntries = listEntries(qualifiedPath);
  const publicEntries = listEntries(publicPath);
  const [qualifiedBytes, publicBytes] = await Promise.all([readFile(qualifiedPath), readFile(publicPath)]);
  const qualifiedSha256 = createHash("sha256").update(qualifiedBytes).digest("hex");
  const publicSha256 = createHash("sha256").update(publicBytes).digest("hex");
  if (qualifiedSha256 === publicSha256) {
    return { mode: "byte-identical", qualifiedSha256, publicSha256, signatureEntries: [] };
  }
  for (const entry of qualifiedEntries) {
    if (!publicEntries.has(entry)) throw new Error(`ATN XPI removed a qualified entry: ${entry}`);
    if (!entry.endsWith("/") && !readEntry(qualifiedPath, entry).equals(readEntry(publicPath, entry))) {
      throw new Error(`ATN XPI changed qualified payload bytes: ${entry}`);
    }
  }
  const extras = new Set([...publicEntries].filter((entry) => !qualifiedEntries.has(entry)));
  validateSignatureEntries(extras, publicPath);
  return {
    mode: "signature-metadata-added",
    qualifiedSha256,
    publicSha256,
    signatureEntries: [...extras].filter((entry) => !entry.endsWith("/")).sort(),
  };
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--qualified", "--public"].includes(key) || !value || values.has(key)) {
      throw new Error("Usage: verify-atn-xpi-payload.mjs --qualified <xpi> --public <xpi>");
    }
    values.set(key, value);
  }
  if (!values.has("--qualified") || !values.has("--public")) {
    throw new Error("Both --qualified and --public are required");
  }
  return { qualifiedXpi: values.get("--qualified"), publicXpi: values.get("--public") };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await verifyAtnXpiPayload(parseArguments(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
