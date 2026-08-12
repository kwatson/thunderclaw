import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const spikeRoot = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(spikeRoot, "../../..");
const source = path.join(spikeRoot, "source");
const outputRoot = path.join(repository, "build", "rich-compose-spike");
const staging = path.join(outputRoot, "xpi-root");
const output = path.join(outputRoot, "thunderclaw-rich-compose-r0-0.0.1.xpi");
const files = ["background.js", "compose.js", "manifest.json", "popup.css", "popup.html", "popup.js"];

export async function assertAllowedSourceFiles(directory, allowedFiles = files) {
  const actual = (await fs.readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowedFiles)) {
    throw new Error(`Rich-compose spike source allowlist mismatch: ${actual.join(", ")}`);
  }
  for (const file of allowedFiles) {
    const metadata = await fs.lstat(path.join(directory, file));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Rich-compose spike source must be a regular non-symlink file: ${file}`);
    }
  }
}

export async function buildRichComposeSpike() {
  await assertAllowedSourceFiles(source);
  const zipVersion = execFileSync("zip", ["-v"], { encoding: "utf8" });
  if (!/This is Zip 3\.0 \(July 5th 2008\)/u.test(zipVersion)) {
    throw new Error("Rich-compose spike builds require the reviewed Info-ZIP 3.0 toolchain");
  }
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  for (const file of files) {
    const target = path.join(staging, file);
    await fs.copyFile(path.join(source, file), target);
    await fs.chmod(target, 0o644);
    await fs.utimes(target, new Date("2026-08-09T00:00:00Z"), new Date("2026-08-09T00:00:00Z"));
  }
  execFileSync("zip", ["-X", "-q", output, ...files], {
    cwd: staging,
    env: { ...process.env, TZ: "UTC" },
    stdio: "inherit",
  });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await buildRichComposeSpike()}\n`);
}
