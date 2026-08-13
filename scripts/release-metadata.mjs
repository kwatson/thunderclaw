import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const sectionPattern = /^## \[((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\](?: - (\d{4}-\d{2}-\d{2}))?$/u;

export function versionFromTag(tag) {
  if (typeof tag !== "string" || !releaseTagPattern.test(tag)) {
    throw new Error(`Release tag must have canonical form vX.Y.Z: ${String(tag)}`);
  }
  return tag.slice(1);
}

export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== "string") throw new TypeError("Changelog must be text");
  if (!releaseTagPattern.test(`v${version}`)) {
    throw new Error(`Version must have canonical form X.Y.Z: ${String(version)}`);
  }

  const normalized = changelog.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = sectionPattern.exec(lines[index]);
    const bracketedVersion = /^## \[([^\]]+)\]/u.exec(lines[index])?.[1];
    if (bracketedVersion !== version) continue;
    if (!match) throw new Error(`CHANGELOG.md has a malformed ## [${version}] release heading`);
    if (match[2]) {
      const parsedDate = new Date(`${match[2]}T00:00:00Z`);
      if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== match[2]) {
        throw new Error(`CHANGELOG.md has an invalid date for ## [${version}]`);
      }
    }
    matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one ## [${version}] release section`);
  }

  const start = matches[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  const notes = lines.slice(start, end).join("\n").trim();
  if (!notes) throw new Error(`CHANGELOG.md release section ${version} is empty`);
  return `${notes}\n`;
}

export function validateManifestVersions(version, manifests) {
  const mismatches = Object.entries(manifests)
    .filter(([, actual]) => actual !== version)
    .map(([name, actual]) => `${name}=${JSON.stringify(actual)}`);
  if (mismatches.length > 0) {
    throw new Error(`Release ${version} does not match all manifest versions: ${mismatches.join(", ")}`);
  }
}

async function readJsonVersion(root, relative) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root, relative), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${relative}: ${error.message}`, { cause: error });
  }
  return parsed.version;
}

export async function prepareRelease({ root, tag, notesOutput }) {
  const version = versionFromTag(tag);
  let lockfile;
  try {
    lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read package-lock.json: ${error.message}`, { cause: error });
  }
  const manifests = {
    "package.json": await readJsonVersion(root, "package.json"),
    "packages/openclaw-plugin/package.json": await readJsonVersion(root, "packages/openclaw-plugin/package.json"),
    "packages/thunderbird-extension/package.json": await readJsonVersion(root, "packages/thunderbird-extension/package.json"),
    "packages/thunderbird-extension/src/manifest.json": await readJsonVersion(root, "packages/thunderbird-extension/src/manifest.json"),
    "package-lock.json": lockfile.version,
    "package-lock.json packages['']": lockfile.packages?.[""]?.version,
    "package-lock.json plugin workspace": lockfile.packages?.["packages/openclaw-plugin"]?.version,
    "package-lock.json extension workspace": lockfile.packages?.["packages/thunderbird-extension"]?.version,
  };
  validateManifestVersions(version, manifests);
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const notes = extractChangelogSection(changelog, version);
  if (notesOutput) await writeFile(notesOutput, notes, { encoding: "utf8", flag: "wx" });
  return { tag, version, notes, manifests };
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--tag", "--notes-output"].includes(option) || value === undefined || values.has(option)) {
      throw new Error("Usage: release-metadata.mjs --tag vX.Y.Z --notes-output <new-file>");
    }
    values.set(option, value);
  }
  if (values.size !== 2) throw new Error("Usage: release-metadata.mjs --tag vX.Y.Z --notes-output <new-file>");
  return { tag: values.get("--tag"), notesOutput: values.get("--notes-output") };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = await prepareRelease({ root, ...parseArguments(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify({ tag: result.tag, version: result.version })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
