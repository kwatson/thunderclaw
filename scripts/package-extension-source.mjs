import { mkdtemp, mkdir, cp, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages", "thunderbird-extension", "src", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
  throw new Error("Thunderbird manifest must contain a release version");
}

// This is the complete, explicit source-review boundary. Keep it narrow so
// local state, evidence, unrelated tooling, and generated artifacts can never
// enter the archive through a broad repository copy.
const sourceEntries = [
  ".mise.toml",
  "LICENSE",
  "NOTICE",
  "SOURCE_REVIEW.md",
  "package-lock.json",
  "package.json",
  "packages/openclaw-plugin/package.json",
  "packages/thunderbird-extension/package.json",
  "packages/thunderbird-extension/src",
  "packages/thunderbird-extension/tsconfig.json",
  "scripts/build-extension.mjs",
];

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "thunderclaw-extension-source-"));
const stagingRoot = path.join(temporaryRoot, `thunderclaw-extension-source-${manifest.version}`);
const outputRoot = path.join(root, "build");
const output = path.join(outputRoot, `thunderclaw-extension-source-${manifest.version}.zip`);

try {
  await mkdir(stagingRoot, { recursive: true });
  for (const relative of sourceEntries) {
    const source = path.join(root, relative);
    const archiveRelative = relative === "SOURCE_REVIEW.md" ? "README.md" : relative;
    const destination = path.join(stagingRoot, archiveRelative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, preserveTimestamps: true });
  }
  await mkdir(outputRoot, { recursive: true });
  await rm(output, { force: true });
  execFileSync("zip", ["-X", "-q", "-r", output, path.basename(stagingRoot)], {
    cwd: temporaryRoot,
    stdio: "inherit",
  });

  const archived = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" })
    .trim().split("\n").filter((entry) => entry && !entry.endsWith("/"))
    .map((entry) => entry.slice(path.basename(stagingRoot).length + 1)).sort();
  const collect = async (directory, prefix = "") => {
    const collected = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collected.push(...await collect(path.join(directory, entry.name), relative));
      else if (entry.isFile()) collected.push(relative);
      else throw new Error(`Source archive staging contains a non-file entry: ${relative}`);
    }
    return collected;
  };
  const expected = (await collect(stagingRoot)).sort();
  if (JSON.stringify(archived) !== JSON.stringify(expected)) {
    throw new Error("Mozilla source-review archive does not match its explicit source allowlist");
  }
  process.stdout.write(`${output}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
