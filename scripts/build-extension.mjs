import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
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
const repositoryPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const pluginPackage = JSON.parse(await fs.readFile(path.join(root, "packages", "openclaw-plugin", "package.json"), "utf8"));
const extensionPackage = JSON.parse(await fs.readFile(path.join(root, "packages", "thunderbird-extension", "package.json"), "utf8"));
if (new Set([manifest.version, repositoryPackage.version, pluginPackage.version, extensionPackage.version]).size !== 1) {
  throw new Error("ThunderClaw repository, plugin, extension, and manifest versions must match");
}
if (manifest.browser_specific_settings?.gecko?.id !== "thunderclaw@addons.thunderbird.net") {
  throw new Error("ThunderClaw extension must have the stable reviewed ID");
}
const requiredOptionalPermissions = ["https://*/*", "http://127.0.0.1/*", "http://[::1]/*"];
const requiredPermissions = ["compose", "messagesRead", "scripting", "storage"];
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
execFileSync("zip", ["-X", "-q", "-r", output, "."], { cwd: outputRoot, stdio: "inherit" });
process.stdout.write(`${output}\n`);
