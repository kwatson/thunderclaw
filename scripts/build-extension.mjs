import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "thunderbird-extension", "src");
const argumentsList = process.argv.slice(2);
const defaultOutputRoot = path.join(root, "build", "extension");
const defaultOutput = path.join(root, "build", "thunderclaw-extension.xpi");
let outputRoot = defaultOutputRoot;
let output = defaultOutput;
let isolated = false;
let buildLock;
let buildLockPath;
if (argumentsList.length !== 0) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--isolated-parent") {
    throw new Error("Usage: build-extension.mjs [--isolated-parent <existing-temporary-directory>]");
  }
  const requestedParent = path.resolve(argumentsList[1]);
  const parent = await fs.realpath(requestedParent);
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) throw new Error("Isolated extension build parent must be an existing directory");
  const isolatedRoot = await fs.mkdtemp(path.join(parent, "thunderclaw-extension-build-"));
  outputRoot = path.join(isolatedRoot, "extension");
  output = path.join(isolatedRoot, "thunderclaw-extension.xpi");
  isolated = true;
}
if (!isolated) {
  await fs.mkdir(path.dirname(defaultOutput), { recursive: true });
  buildLockPath = path.join(path.dirname(defaultOutput), ".thunderclaw-extension-build.lock");
  const deadline = Date.now() + 30_000;
  while (!buildLock) {
    try {
      buildLock = await fs.open(buildLockPath, "wx", 0o600);
      await buildLock.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      if (error.code === "EEXIST") {
        const owner = Number.parseInt((await fs.readFile(buildLockPath, "utf8").catch(() => "")).trim(), 10);
        if (Number.isSafeInteger(owner) && owner > 1) {
          try { process.kill(owner, 0); } catch (ownerError) {
            if (ownerError.code === "ESRCH") {
              await fs.unlink(buildLockPath).catch((unlinkError) => {
                if (unlinkError.code !== "ENOENT") throw unlinkError;
              });
              continue;
            }
          }
        }
      }
      if (error.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error("Another default ThunderClaw extension build holds the build lock", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
const cleanupBuildLock = () => {
  if (!buildLockPath) return;
  try { unlinkSync(buildLockPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};
process.once("exit", cleanupBuildLock);
const runtimeFiles = [
  "manifest.json",
  "compose.js",
  "message-display.js",
  "message-popup.html",
  "message-popup.js",
  "options.html",
  "options.css",
  "popup.css",
  "popup.html",
  "popup.js",
  "icons/thunderclaw-16.png",
  "icons/thunderclaw-20.png",
  "icons/thunderclaw-24.png",
  "icons/thunderclaw-32.png",
  "icons/thunderclaw-48.png",
  "icons/thunderclaw-64.png",
  "icons/thunderclaw-96.png",
  "icons/thunderclaw-128.png",
];
const legalFiles = ["LICENSE", "NOTICE"];

const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
const extensionPackage = JSON.parse(await fs.readFile(path.join(root, "packages", "thunderbird-extension", "package.json"), "utf8"));
if (manifest.version !== extensionPackage.version) {
  throw new Error("ThunderClaw extension package and manifest versions must match");
}
if (manifest.browser_specific_settings?.gecko?.id !== "thunderclaw@addons.thunderbird.net") {
  throw new Error("ThunderClaw extension must have the stable reviewed ID");
}
const requiredOptionalPermissions = ["https://*/*", "http://127.0.0.1/*", "http://[::1]/*"];
const requiredPermissions = ["compose", "messagesRead", "scripting", "sensitiveDataUpload", "storage"];
if (JSON.stringify([...(manifest.permissions ?? [])].sort()) !== JSON.stringify(requiredPermissions)
    || !manifest.compose_action || !manifest.message_display_action
    || manifest.compose_scripts !== undefined) {
  throw new Error("ThunderClaw extension has invalid required permissions, actions, or compose-script declarations");
}
if (JSON.stringify(manifest.optional_permissions) !== JSON.stringify(requiredOptionalPermissions)
    || manifest.options_ui?.page !== "options.html" || manifest.options_ui?.open_in_tab !== true) {
  throw new Error("ThunderClaw extension must declare the exact approved optional host permissions and options page");
}

if (!isolated) {
  // Default builds may replace only ThunderClaw's two known repository outputs.
  await fs.rm(defaultOutputRoot, { recursive: true, force: true });
  await fs.rm(defaultOutput, { force: true });
}
await fs.mkdir(outputRoot, { recursive: true });
for (const relative of runtimeFiles) {
  const destination = path.join(outputRoot, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(path.join(source, relative), destination);
}
for (const relative of legalFiles) {
  await fs.copyFile(path.join(root, relative), path.join(outputRoot, relative));
}
const buildResult = await build({
  entryPoints: [path.join(source, "background-entry.ts")],
  outfile: path.join(outputRoot, "background.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox128",
  treeShaking: false,
  sourcemap: false,
  metafile: true,
  legalComments: "none",
  logLevel: "silent",
});
const optionsBuildResult = await build({
  entryPoints: [path.join(source, "options-entry.ts")],
  outfile: path.join(outputRoot, "options.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox128",
  treeShaking: false,
  sourcemap: false,
  metafile: true,
  legalComments: "none",
  logLevel: "silent",
});
for (const input of [...Object.keys(buildResult.metafile.inputs), ...Object.keys(optionsBuildResult.metafile.inputs)]) {
  if (/^(?:node:|https?:)/u.test(input)) throw new Error(`Extension bundle contains a forbidden runtime import: ${input}`);
}
const bundledBackground = await fs.readFile(path.join(outputRoot, "background.js"), "utf8");
const bundledOptions = await fs.readFile(path.join(outputRoot, "options.js"), "utf8");
if (/\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\bnode:/u.test(`${bundledBackground}\n${bundledOptions}`)) {
  throw new Error("Extension bundles contain dynamic loading, evaluation, or a Node built-in");
}
const packagedFiles = (await fs.readdir(outputRoot, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(outputRoot, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"))
  .sort();
const expectedFiles = [...runtimeFiles, ...legalFiles, "background.js", "options.js"].sort();
if (JSON.stringify(packagedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`Extension package contains unexpected runtime files: ${packagedFiles.join(", ")}`);
}
// ZIP records timestamps and modes. Normalize both and pass an already sorted
// file list so builds from different clean directories have identical bytes.
// Use the second UTC day so the local DOS timestamp cannot fall before ZIP's
// 1980 epoch in negative-offset time zones.
const zipEpoch = new Date("1980-01-02T00:00:00.000Z");
for (const relative of packagedFiles) {
  const packaged = path.join(outputRoot, relative);
  await fs.chmod(packaged, 0o644);
  await fs.utimes(packaged, zipEpoch, zipEpoch);
}
execFileSync("zip", ["-X", "-q", output, ...packagedFiles], {
  cwd: outputRoot,
  env: { ...process.env, TZ: "UTC" },
  stdio: "inherit",
});
if (buildLock) {
  await buildLock.close();
  cleanupBuildLock();
  process.removeListener("exit", cleanupBuildLock);
}
process.stdout.write(`${output}\n`);
