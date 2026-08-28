import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateReleaseBaselines } from "./validate-release-baselines.mjs";

export const releaseComponents = ["openclaw-plugin", "thunderbird-extension"];
const releaseTagPattern = /^(openclaw-plugin|thunderbird-extension)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const componentLabels = {
  "openclaw-plugin": "OpenClaw plugin",
  "thunderbird-extension": "Thunderbird extension",
};
const sectionPattern = /^## (OpenClaw plugin|Thunderbird extension) \[((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\](?: - (\d{4}-\d{2}-\d{2}))?$/u;

export function parseReleaseTag(tag) {
  const match = typeof tag === "string" ? releaseTagPattern.exec(tag) : null;
  if (!match) {
    throw new Error(
      `Release tag must have canonical form openclaw-plugin-vX.Y.Z or thunderbird-extension-vX.Y.Z: ${String(tag)}`,
    );
  }
  return { component: match[1], version: `${match[2]}.${match[3]}.${match[4]}`, tag };
}

export function versionFromTag(tag) {
  return parseReleaseTag(tag).version;
}

export function extractChangelogSection(changelog, component, version) {
  if (typeof changelog !== "string") throw new TypeError("Changelog must be text");
  if (!releaseComponents.includes(component)) throw new Error(`Unknown release component: ${String(component)}`);
  if (typeof version !== "string" || !versionPattern.test(version)) {
    throw new Error(`Version must have canonical form X.Y.Z: ${String(version)}`);
  }

  const componentLabel = componentLabels[component];
  const lines = changelog.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n").split("\n");
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = sectionPattern.exec(lines[index]);
    const candidate = /^## ([^\[]+) \[([^\]]+)\]/u.exec(lines[index]);
    if (candidate?.[1].trim() !== componentLabel || candidate?.[2] !== version) continue;
    if (!match) throw new Error(`Changelog has a malformed ${componentLabel} [${version}] release heading`);
    if (match[3]) {
      const parsedDate = new Date(`${match[3]}T00:00:00Z`);
      if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== match[3]) {
        throw new Error(`Changelog has an invalid date for ${componentLabel} [${version}]`);
      }
    }
    matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`Changelog must contain exactly one ${componentLabel} [${version}] release section`);
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
  if (!notes) throw new Error(`Changelog release section ${componentLabel} ${version} is empty`);
  return `${notes}\n`;
}

export function validateManifestVersions(version, manifests) {
  const mismatches = Object.entries(manifests)
    .filter(([, actual]) => actual !== version)
    .map(([name, actual]) => `${name}=${JSON.stringify(actual)}`);
  if (mismatches.length > 0) {
    throw new Error(`Release ${version} does not match component manifest versions: ${mismatches.join(", ")}`);
  }
}

async function readJson(root, relative) {
  try {
    return JSON.parse(await readFile(path.join(root, relative), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${relative}: ${error.message}`, { cause: error });
  }
}

export async function prepareRelease({ root, tag, notesOutput }) {
  const { component, version } = parseReleaseTag(tag);
  if (notesOutput && path.basename(notesOutput) !== "release-notes.md") {
    throw new Error("Release notes output must use the canonical filename release-notes.md");
  }

  const lockfile = await readJson(root, "package-lock.json");
  const rootPackage = await readJson(root, "package.json");
  const baselines = validateReleaseBaselines(await readJson(root, "release-baselines.json"));
  if (baselines.releases?.some((release) => release?.component === component && release?.version === version)) {
    throw new Error(`Release ${component} ${version} is reserved by the immutable legacy baseline ledger`);
  }
  if (rootPackage.version !== undefined || lockfile.version !== undefined || lockfile.packages?.[""]?.version !== undefined) {
    throw new Error("The private workspace root must not declare a shared release version");
  }

  const componentPath = `packages/${component}`;
  const componentPackage = await readJson(root, `${componentPath}/package.json`);
  const manifests = {
    [`${componentPath}/package.json`]: componentPackage.version,
    [`package-lock.json ${component} workspace`]: lockfile.packages?.[componentPath]?.version,
  };
  if (component === "thunderbird-extension") {
    manifests[`${componentPath}/src/manifest.json`] = (await readJson(root, `${componentPath}/src/manifest.json`)).version;
  }
  validateManifestVersions(version, manifests);

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const notes = extractChangelogSection(changelog, component, version);
  if (notesOutput) await writeFile(notesOutput, notes, { encoding: "utf8", flag: "wx" });
  return { component, tag, version, notes, manifests };
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--tag", "--notes-output"].includes(option) || value === undefined || values.has(option)) {
      throw new Error("Usage: release-metadata.mjs --tag <component-vX.Y.Z> --notes-output <path>/release-notes.md");
    }
    values.set(option, value);
  }
  if (values.size !== 2) {
    throw new Error("Usage: release-metadata.mjs --tag <component-vX.Y.Z> --notes-output <path>/release-notes.md");
  }
  return { tag: values.get("--tag"), notesOutput: values.get("--notes-output") };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = await prepareRelease({ root, ...parseArguments(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify({ component: result.component, tag: result.tag, version: result.version })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
