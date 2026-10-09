import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assessPublishedPluginChanges, changedFiles, classifyChangeScope } from "../scripts/classify-change-scope.mjs";
import { CLASSIFIER_PATHS } from "../scripts/release-automation-fingerprint.mjs";

test("internal automation repair requires checks without product qualification", () => {
  const scope = classifyChangeScope([".github/workflows/publish-clawhub.yml", "scripts/patch-clawhub-publisher.mjs",
    "scripts/classify-change-scope.mjs", "test/publisher.test.ts", "e2e/qualification/real-agent/run.mjs",
    "e2e/qualification/counterpart-baselines.json", "docs/release.md",
    ".github/workflows/complete-plugin-publication.yml", "scripts/verify-plugin-publication-resume.mjs",
    "scripts/verify-plugin-publication-resume.d.mts", "scripts/clawhub-publication-recovery.mjs",
    "scripts/openclaw-controller-recovery.mjs", "scripts/rehearse-release-operations.mjs",
    "scripts/clawhub-publication-recovery.d.mts", "scripts/openclaw-controller-recovery.d.mts",
    "scripts/rehearse-release-operations.d.mts", "scripts/release-automation-fingerprint.mjs",
    "scripts/release-automation-fingerprint.d.mts", "scripts/openclaw-qualification-reconciliation.mjs",
    "scripts/openclaw-qualification-reconciliation.d.mts"]);
  assert.equal(scope.runChecks, true);
  assert.equal(scope.qualifyPlugin, false);
  assert.equal(scope.qualifyExtension, false);
  assert.equal(classifyChangeScope(["docs/release.md", "README.md"]).runChecks, false);
});

test("runtime, compatibility, packaging, and unknown inputs retain component gates", () => {
  for (const file of ["packages/openclaw-plugin/src/http.ts", "packages/openclaw-plugin/README.md",
    "scripts/package-openclaw-plugin.mjs", "scripts/sync-package-legal.mjs", "openclaw-qualification.json",
    "docs/brand/assets/raster/icons/thunderclaw-openclaw-plugin-icon-256.png"]) {
    const scope = classifyChangeScope([file]);
    assert.equal(scope.qualifyPlugin, true, file);
    assert.equal(scope.qualifyExtension, false, file);
  }
  for (const file of ["packages/thunderbird-extension/src/manifest.json", "scripts/build-extension.mjs",
    "scripts/package-extension-source.mjs", "SOURCE_REVIEW.md"]) {
    const scope = classifyChangeScope([file]);
    assert.equal(scope.qualifyPlugin, false, file);
    assert.equal(scope.qualifyExtension, true, file);
  }
  for (const file of ["package.json", "package-lock.json", ".mise.toml", "tsconfig.json", "LICENSE",
    "compose.spike.yaml", "scripts/new-build-tool.mjs", "new-runtime/input.ts"]) {
    const scope = classifyChangeScope([file]);
    assert.equal(scope.qualifyPlugin, true, file);
    assert.equal(scope.qualifyExtension, true, file);
  }
});

test("every fingerprinted release verifier remains classified as reviewed internal machinery", () => {
  const files = [...CLASSIFIER_PATHS, "scripts/openclaw-unpublished-tag-recovery.d.mts"];
  const scope = classifyChangeScope(files);
  assert.deepEqual(scope.plugin, []);
  assert.deepEqual(scope.extension, []);
  assert.deepEqual(scope.internal, files);
  assert.equal(scope.runChecks, true);
});

test("published product comparison permits reviewed machinery changes but catches renames and missing ancestry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  try {
    git("init"); git("config", "user.name", "Synthetic"); git("config", "user.email", "synthetic@invalid");
    await writeFile(path.join(root, "LICENSE"), "synthetic packaged input\n");
    const published = commit("published");
    await writeFile(path.join(root, "README.md"), "internal documentation\n");
    const reviewed = commit("reviewed docs");
    assert.deepEqual(assessPublishedPluginChanges(root, published, reviewed).findings, []);
    git("mv", "LICENSE", "internal.md");
    const renamed = commit("move product input");
    assert.ok(changedFiles(root, reviewed, renamed).includes("LICENSE"));
    assert.match(assessPublishedPluginChanges(root, published, renamed).findings.join("\n"), /LICENSE/u);
    assert.throws(() => assessPublishedPluginChanges(root, renamed, published));
    assert.throws(() => changedFiles(root, "missing-ref", reviewed));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scope policy participates in every reserved verifier fingerprint and CI never publishes", async () => {
  for (const file of ["scripts/classify-openclaw-release.mjs", "scripts/rehearse-openclaw-autopilot.mjs",
    ".github/workflows/openclaw-autopilot.yml", ".github/workflows/qualify-openclaw-autopilot.yml",
    ".github/workflows/release-openclaw-plugin.yml"]) {
    assert.match(await readFile(file, "utf8"), /release-automation-fingerprint\.mjs/u, file);
  }
  assert.ok(CLASSIFIER_PATHS.includes("scripts/classify-change-scope.mjs"));
  assert.ok(CLASSIFIER_PATHS.includes("scripts/release-automation-fingerprint.mjs"));
  const controller = await readFile(".github/workflows/openclaw-autopilot.yml", "utf8");
  const admission = controller.indexOf("node scripts/classify-change-scope.mjs --published-plugin");
  assert.ok(admission > 0);
  assert.ok(admission < controller.indexOf("node scripts/prepare-openclaw-upgrade.mjs"));
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /node scripts\/classify-change-scope\.mjs/u);
  assert.match(ci, /needs\.checks\.outputs\.qualify_plugin == 'true'/u);
  assert.doesNotMatch(ci, /contents: write|id-token: write|gh release create|git tag|clawhub publish/u);
});
