import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { changedFiles, classifyChangeScope } from "../scripts/classify-change-scope.mjs";

test("reviewed tooling and retained plugin source require checks without extension packaging", () => {
  const files = [".github/workflows/ci.yml", "scripts/classify-change-scope.mjs",
    "scripts/submit-thunderbird-addon.mjs", "test/extension.test.ts", "e2e/thunderbird/run_compose.py",
    "e2e/qualification/counterpart-baselines.json", "site/index.html", "scripts/build-pages.mjs",
    "packages/openclaw-plugin/src/http.ts", "packages/openclaw-plugin/README.md",
    "scripts/package-openclaw-plugin.mjs", "openclaw-qualification.json", "compose.spike.yaml"];
  const scope = classifyChangeScope(files);
  assert.deepEqual(scope.internal, files);
  assert.deepEqual(scope.extension, []);
  assert.equal(scope.runChecks, true);
  assert.equal(scope.qualifyExtension, false);
  assert.equal("qualifyPlugin" in scope, false);
});

test("extension runtime, reviewer-source inputs, dependencies and unknown paths retain package checks", () => {
  for (const file of ["packages/thunderbird-extension/src/manifest.json", "scripts/build-extension.mjs",
    "scripts/package-extension-source.mjs", "SOURCE_REVIEW.md", ".mise.toml", "packages/openclaw-plugin/package.json",
    "package.json", "package-lock.json", "tsconfig.json", "LICENSE", "NOTICE",
    "scripts/new-build-tool.mjs", "new-runtime/input.ts"]) {
    const scope = classifyChangeScope([file]);
    assert.deepEqual(scope.extension, [file]);
    assert.equal(scope.runChecks, true, file);
    assert.equal(scope.qualifyExtension, true, file);
  }
});

test("documentation-only changes skip checks and mixed changes retain their required gates", () => {
  const documentation = ["docs/release.md", "README.md", "CHANGELOG.md"];
  assert.deepEqual(classifyChangeScope(documentation), {
    extension: [], internal: [], documentation, runChecks: false, qualifyExtension: false,
  });
  assert.equal(classifyChangeScope([...documentation, "test/extension.test.ts"]).runChecks, true);
  assert.equal(classifyChangeScope([...documentation, "packages/thunderbird-extension/README.md"]).qualifyExtension, true);
});

test("changed paths include removed names and CLI emits only standalone CI outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  const classifier = fileURLToPath(new URL("../scripts/classify-change-scope.mjs", import.meta.url));
  try {
    git("init"); git("config", "user.name", "Synthetic"); git("config", "user.email", "synthetic@invalid");
    await writeFile(path.join(root, "LICENSE"), "synthetic packaged input\n");
    const base = commit("synthetic input");
    git("mv", "LICENSE", "internal.md");
    const target = commit("rename input");
    assert.deepEqual(changedFiles(root, base, target).sort(), ["LICENSE", "internal.md"]);
    assert.throws(() => changedFiles(root, "missing-ref", target));
    const output = path.join(root, "github-output");
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [classifier, ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output }, stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(run(base, target).qualifyExtension, true);
    assert.deepEqual(run(), { runChecks: true, qualifyExtension: true });
    assert.deepEqual(run("0".repeat(40), target), { runChecks: true, qualifyExtension: true });
    assert.equal(await readFile(output, "utf8"), "run_full=true\nqualify_extension=true\n".repeat(3));
    assert.throws(() => run("missing-ref", target));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CI runs ordinary checks and gates exact-byte Linux and Windows trials behind dispatch", async () => {
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.deepEqual([...ci.matchAll(/^  ([a-z0-9-]+):\n    name:/gmu)].map((match) => match[1]),
    ["checks", "thunderbird-e2e", "native-platform"]);
  assert.match(ci, /node scripts\/classify-change-scope\.mjs/u);
  assert.match(ci, /if: steps\.changes\.outputs\.run_full == 'true'\n        run: mise exec -- npm test/u);
  assert.match(ci, /if: steps\.changes\.outputs\.run_full == 'true'\n        run: mise exec -- npm run typecheck/u);
  assert.match(ci, /if: steps\.changes\.outputs\.qualify_extension == 'true'\n        run: mise exec -- npm run build:extension && mise exec -- npm run pack:source/u);
  assert.equal((ci.match(/npm run build:extension/gu) ?? []).length, 1);
  for (const job of ["thunderbird-e2e", "native-platform"]) {
    const block = ci.split(`  ${job}:`)[1].split(/^  [a-z0-9-]+:/mu)[0];
    assert.match(block, /if: github\.event_name == 'workflow_dispatch' && inputs\.release_qualification == true && needs\.checks\.outputs\.qualify_extension == 'true'/u);
    assert.match(block, /name: thunderclaw-ci-candidate/u);
    assert.ok(block.indexOf("Verify candidate XPI digest") < block.indexOf(job === "thunderbird-e2e" ? "Run real Thunderbird tests" : "Run native Thunderbird qualification"));
  }
  assert.match(ci, /runner: windows-2025/u);
  assert.match(ci, /sha256sum thunderclaw-extension\.xpi > thunderclaw-extension\.xpi\.sha256/u);
  assert.doesNotMatch(ci, /macos|macOS|qualify_plugin|legacy_plugin_qualification|OPENCLAW_AUTOPILOT|pack:plugin|test:integration:openclaw|qualify:native-filesystem/u);
  assert.doesNotMatch(ci, /secrets\.|environment:|contents: write|id-token: write|gh release create|git tag|clawhub publish/u);
  for (const match of ci.matchAll(/uses: ([^\n]+)/gu)) assert.match(match[1], /@[a-f0-9]{40}(?:\s|$)/u);
  for (const match of ci.matchAll(/        run: \|\n((?:          [^\n]*\n|\n)+)/gu)) {
    const shell = match[1].replace(/^          /gmu, "").replace(/\$\{\{[^}]+\}\}/gu, "synthetic");
    execFileSync("bash", ["-n"], { input: shell });
  }
});

test("documentation-only CI still reports the required checks context", async () => {
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const checks = ci.split("  checks:")[1].split("  thunderbird-e2e:")[0];
  assert.match(checks, /^\n    name: Tests, types, and packages\n    runs-on:/u);
  assert.doesNotMatch(checks.split("    steps:")[0], /if:/u);
  assert.match(checks, /name: Documentation-only change\n        if: steps\.changes\.outputs\.run_full == 'false'/u);
  assert.doesNotMatch(ci, /Release automation validation/u);
});

test("native CI digest verification rejects changed candidate bytes", async () => {
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const native = ci.split("  native-platform:")[1];
  const command = native.match(/name: Verify candidate XPI digest\n        shell: bash\n        run: \|\n          ([^\n]+)/u)?.[1];
  assert.ok(command);
  const root = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-ci-digest-"));
  try {
    await mkdir(path.join(root, "build"));
    const candidate = path.join(root, "build/thunderclaw-extension.xpi");
    const bytes = "synthetic candidate archive";
    await writeFile(candidate, bytes);
    await writeFile(`${candidate}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  thunderclaw-extension.xpi\n`);
    execFileSync("bash", ["-c", command], { cwd: root });
    await writeFile(candidate, "changed synthetic candidate archive");
    assert.throws(() => execFileSync("bash", ["-c", command], { cwd: root }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
