import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { randomId } from "../packages/thunderbird-extension/src/random-id.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("random IDs use 16 Web Crypto bytes and canonical UUID version/variant bits", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let requestedLength = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        assert.ok(array instanceof Uint8Array);
        requestedLength = array.byteLength;
        for (let index = 0; index < array.length; index += 1) array[index] = index;
        return array;
      },
    },
  });
  try {
    assert.equal(randomId(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.equal(requestedLength, 16);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("built XPI contains only the runtime allowlist and a classic browser IIFE", async () => {
  execFileSync(process.execPath, [path.join(root, "scripts/build-extension.mjs")], { cwd: root, stdio: "pipe" });
  const xpi = path.join(root, "build/thunderclaw-extension.xpi");
  const names = execFileSync("unzip", ["-Z1", xpi], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/u)
    .filter((name) => name.length > 0 && !name.endsWith("/"))
    .sort();
  const expected = [
    "LICENSE",
    "NOTICE",
    "background.js",
    "compose.js",
    "icons/thunderclaw-128.png",
    "icons/thunderclaw-16.png",
    "icons/thunderclaw-20.png",
    "icons/thunderclaw-24.png",
    "icons/thunderclaw-32.png",
    "icons/thunderclaw-48.png",
    "icons/thunderclaw-64.png",
    "icons/thunderclaw-96.png",
    "manifest.json",
    "message-display.js",
    "message-popup.html",
    "message-popup.js",
    "options.css",
    "options.html",
    "options.js",
    "popup.css",
    "popup.html",
    "popup.js",
  ].sort();
  assert.deepEqual(names, expected);
  assert.equal(names.some((name) => /(?:\.tsx?|\.map)$/u.test(name)), false);
  assert.match(execFileSync("unzip", ["-p", xpi, "LICENSE"], { encoding: "utf8" }), /Apache License/u);
  assert.match(execFileSync("unzip", ["-p", xpi, "NOTICE"], { encoding: "utf8" }), /ThunderClaw/u);

  const background = execFileSync("unzip", ["-p", xpi, "background.js"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.match(background, /^(?:"use strict";\n)?\(\(\) => \{/u);
  assert.match(background, /ThunderClawDirectClient/u);
  assert.doesNotMatch(background, /^\s*(?:import|export)\s/mu);
  assert.doesNotMatch(background, /\b(?:require|eval)\s*\(/u);
  assert.doesNotMatch(background, /\bnew\s+Function\s*\(/u);
  assert.doesNotMatch(background, /\bimport\s*\(/u);
  assert.doesNotMatch(background, /\bnode:/u);
  assert.doesNotMatch(background, /\b(?:process\.|Buffer\.|__dirname|__filename)\b/u);
  assert.doesNotMatch(background, /\/\/[#@]\s*sourceMappingURL=/u);
  assert.match(background, /composeScripts/u);
  assert.match(background, /compose\.js/u);

  const packagedManifest = JSON.parse(execFileSync("unzip", ["-p", xpi, "manifest.json"], { encoding: "utf8" })) as {
    permissions?: string[];
    compose_scripts?: unknown;
  };
  assert.deepEqual([...(packagedManifest.permissions ?? [])].sort(), ["compose", "messagesRead", "scripting", "storage"]);
  assert.equal(packagedManifest.compose_scripts, undefined,
    "Thunderbird 128 does not support the manifest compose_scripts key");
  const packagedJavaScript = names.filter((name) => name.endsWith(".js"))
    .map((name) => execFileSync("unzip", ["-p", xpi, name], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }))
    .join("\n");

  const builtBackground = await readFile(path.join(root, "build/extension/background.js"), "utf8");
  assert.equal(builtBackground, background);

  const options = execFileSync("unzip", ["-p", xpi, "options.js"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.match(options, /^(?:"use strict";\n)?\(\(\) => \{/u);
  assert.doesNotMatch(options, /^\s*(?:import|export)\s/mu);
  assert.doesNotMatch(options, /\b(?:require|eval)\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(|\bnode:/u);
  assert.doesNotMatch(options, /\b(?:process\.|Buffer\.|__dirname|__filename)\b/u);
  assert.doesNotMatch(options, /\/\/[#@]\s*sourceMappingURL=/u);
  assert.equal(await readFile(path.join(root, "build/extension/options.js"), "utf8"), options);
});

test("isolated extension builds leave default artifacts and sentinels untouched", async () => {
  const defaultXpi = path.join(root, "build/thunderclaw-extension.xpi");
  const defaultBackground = path.join(root, "build/extension/background.js");
  const sentinel = path.join(root, "build/extension/isolated-build-sentinel.txt");
  const beforeXpi = await readFile(defaultXpi);
  const beforeBackground = await readFile(defaultBackground);
  await writeFile(sentinel, "do not touch", "utf8");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-isolated-build-"));
  const parentSentinel = path.join(temporary, "parent-sentinel.txt");
  await writeFile(parentSentinel, "parent survives", "utf8");
  try {
    for (const rejectedArguments of [
      ["--output-root", path.join(temporary, "staging")],
      ["--output", path.join(temporary, "artifact.xpi")],
      ["--isolated-parent", temporary, "--output", path.join(temporary, "artifact.xpi")],
    ]) {
      assert.throws(() => execFileSync(process.execPath, [path.join(root, "scripts/build-extension.mjs"), ...rejectedArguments], { cwd: root, stdio: "pipe" }));
    }
    const firstOutput = execFileSync(process.execPath, [
      path.join(root, "scripts/build-extension.mjs"),
      "--isolated-parent", temporary,
    ], { cwd: root, encoding: "utf8" }).trim();
    const secondOutput = execFileSync(process.execPath, [
      path.join(root, "scripts/build-extension.mjs"),
      "--isolated-parent", temporary,
    ], { cwd: root, encoding: "utf8" }).trim();
    assert.notEqual(firstOutput, secondOutput);
    assert.equal(path.dirname(path.dirname(firstOutput)), temporary);
    assert.equal(path.dirname(path.dirname(secondOutput)), temporary);
    assert.equal(await readFile(parentSentinel, "utf8"), "parent survives");
    assert.equal((await readFile(sentinel, "utf8")), "do not touch");
    assert.deepEqual(await readFile(defaultXpi), beforeXpi);
    assert.deepEqual(await readFile(defaultBackground), beforeBackground);
    const names = execFileSync("unzip", ["-Z1", firstOutput], { encoding: "utf8" });
    assert.match(names, /^background\.js$/mu);
    assert.doesNotMatch(names, /(?:\.tsx?|\.map)$/mu);
    const isolatedBackground = await readFile(path.join(path.dirname(firstOutput), "extension/background.js"), "utf8");
    assert.doesNotMatch(isolatedBackground, /\bnew\s+Function\s*\(/u);
  } finally {
    await rm(sentinel, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test("default extension build preserves unrelated build siblings", async () => {
  const sentinel = path.join(root, "build/default-build-unrelated-sentinel.txt");
  await writeFile(sentinel, "unrelated", "utf8");
  try {
    const output = execFileSync(process.execPath, [path.join(root, "scripts/build-extension.mjs")], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(output, path.join(root, "build/thunderclaw-extension.xpi"));
    assert.equal(await readFile(sentinel, "utf8"), "unrelated");
  } finally {
    await rm(sentinel, { force: true });
  }
});
