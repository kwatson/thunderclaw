import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "packages", "openclaw-plugin");
await Promise.all([
  copyFile(path.join(root, "LICENSE"), path.join(pluginRoot, "LICENSE")),
  copyFile(path.join(root, "NOTICE"), path.join(pluginRoot, "NOTICE")),
]);
