import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkCommands, runChecks } from "../scripts/check.mjs";
import { prepareNextRelease } from "../scripts/release-prepare.mjs";
import { releaseStatus } from "../scripts/release-status.mjs";
import { extractChangelogSection } from "../scripts/release-metadata.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-release-helper-"));
  await mkdir(path.join(root, "packages/thunderbird-extension/src"), { recursive: true });
  await writeFile(path.join(root, "packages/thunderbird-extension/package.json"), '{"name":"@thunderclaw/thunderbird-extension","version":"1.2.3"}\n');
  await writeFile(path.join(root, "packages/thunderbird-extension/src/manifest.json"), '{"version":"1.2.3","name":"ThunderClaw"}\n');
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "": { name: "thunderclaw" }, "packages/thunderbird-extension": { version: "1.2.3" } } }));
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Thunderbird extension [1.2.3]\n\nPrevious notes.\n");
  return root;
}

const paths = ["packages/thunderbird-extension/package.json", "packages/thunderbird-extension/src/manifest.json", "package-lock.json", "CHANGELOG.md"];
const snapshot = (root: string) => Promise.all(paths.map((file) => readFile(path.join(root, file), "utf8")));

test("check runs sequentially and stops at the failing command", () => {
  assert.deepEqual(checkCommands(), [["test"], ["run", "typecheck"], ["run", "build:extension"], ["run", "pack:source"], ["run", "build:site"]]);
  assert.deepEqual(checkCommands("internal"), [["test"], ["run", "typecheck"]]);
  assert.deepEqual(checkCommands("site"), [["run", "build:site"]]);
  const calls: string[][] = [];
  assert.throws(() => runChecks("all", (args) => { calls.push(args); return calls.length === 2 ? 7 : 0; }), /typecheck failed \(exit 7\)/u);
  assert.deepEqual(calls, [["test"], ["run", "typecheck"]]);
  assert.throws(() => checkCommands("typo"), /Scope/u);
});

test("release preparation changes only extension versions and adds a gated changelog draft", async () => {
  const root = await fixture();
  try {
    const result = await prepareNextRelease({ root, version: "1.3.0", inspect: async () => ({ exists: false }), date: "2026-10-24" });
    assert.equal(result.tag, "thunderbird-extension-v1.3.0");
    const [workspace, manifest, lock, changelog] = await snapshot(root);
    assert.equal(JSON.parse(workspace).version, "1.3.0");
    assert.equal(JSON.parse(manifest).version, "1.3.0");
    assert.equal(JSON.parse(lock).packages["packages/thunderbird-extension"].version, "1.3.0");
    assert.equal(JSON.parse(lock).packages[""].version, undefined);
    assert.match(changelog, /Previous notes\./u);
    assert.throws(() => extractChangelogSection(changelog, "thunderbird-extension", "1.3.0"), /still a release:prepare draft/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release preparation refuses existing, decreasing, published, unknown, or inconsistent identities without edits", async () => {
  const root = await fixture();
  try {
    const original = await snapshot(root);
    for (const version of ["1.2.3", "1.2.2", "01.3.0", "1.3.0-rc.1"]) {
      await assert.rejects(prepareNextRelease({ root, version, inspect: async () => ({ exists: false }) }), /increase|canonical form/u);
      assert.deepEqual(await snapshot(root), original);
    }
    await assert.rejects(prepareNextRelease({ root, version: "1.3.0", inspect: async () => ({ exists: true, evidence: "public ATN version" }) }), /identity already exists/u);
    await assert.rejects(prepareNextRelease({ root, version: "1.3.0", inspect: async () => { throw new Error("publication unavailable"); } }), /publication unavailable/u);
    assert.deepEqual(await snapshot(root), original);
    await writeFile(path.join(root, "CHANGELOG.md"), `${original[3]}\n## Thunderbird extension [1.3.0]\n\nAlready prepared.\n`);
    const duplicate = await snapshot(root);
    await assert.rejects(prepareNextRelease({ root, version: "1.3.0", inspect: async () => ({ exists: false }) }), /already contains/u);
    assert.deepEqual(await snapshot(root), duplicate);
    await writeFile(path.join(root, "packages/thunderbird-extension/src/manifest.json"), '{"version":"1.2.4"}\n');
    const inconsistent = await snapshot(root);
    await assert.rejects(prepareNextRelease({ root, version: "1.4.0", inspect: async () => ({ exists: false }) }), /does not match component manifest/u);
    assert.deepEqual(await snapshot(root), inconsistent);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release status distinguishes unavailable evidence from absence and upload from verified public smoke", async () => {
  const tag = "thunderbird-extension-v1.2.3";
  const unavailable = await releaseStatus({ tag, query: () => ({ state: "unknown" }), fetchImpl: async () => { throw new Error("offline"); } });
  for (const key of ["built", "qualified", "github", "atnAcceptance", "atn", "publicVerification"]) assert.equal(unavailable[key].state, "unknown");
  const missing = await releaseStatus({ tag, query: () => ({ state: "absent" }), fetchImpl: async () => Response.json({ results: [] }) });
  assert.equal(missing.github.state, "absent");
  assert.equal(missing.atn.state, "absent");
  assert.equal(missing.built.state, "unknown");
  const pending = await releaseStatus({ tag, query: () => ({ state: "unknown" }), fetchImpl: async () => Response.json({ results: [], next: "another-page" }) });
  assert.equal(pending.atn.state, "unknown");
  const calls: string[] = [];
  const query = (endpoint: string) => {
    calls.push(endpoint);
    const observed = (data: unknown) => ({ state: "observed", data });
    if (endpoint.includes("/releases/tags/")) return observed({ html_url: "https://github.com/kwatson/thunderclaw/releases/tag/synthetic", draft: false, body: "Expected notes." });
    if (endpoint.includes("/release.yml/runs?")) return observed({ workflow_runs: [{ id: 1, head_branch: tag, run_attempt: 2, html_url: "build" }] });
    if (endpoint.includes("/runs/1/attempts/2/jobs")) return observed({ jobs: ["Validate and build once", "Qualify prebuilt Thunderbird extension", "Native Thunderbird qualification (Windows)", "Reproduce XPI from reviewer source"].map((name) => ({ name, status: "completed", conclusion: "success" })) });
    if (endpoint.includes("/publish-thunderbird-addons.yml/runs?")) return observed({ workflow_runs: [{ id: 2, run_attempt: 1, conclusion: "success", html_url: "verification" }] });
    if (endpoint.includes("/runs/2/artifacts")) return observed({ artifacts: [{ name: "thunderclaw-atn-submission-1.2.3", expired: false }] });
    if (endpoint.includes("/runs/2/attempts/1/jobs")) return observed({ jobs: [{ steps: ["Verify and download public ATN XPI and report release notes", "Verify public XPI is identical or adds only signature metadata", "Smoke-test the exact public ATN-signed XPI"].map((name) => ({ name, conclusion: "success" })) }] });
    return { state: "unknown" };
  };
  const published = await releaseStatus({ tag, query, fetchImpl: async () => Response.json({ results: [{ version: "1.2.3", files: [{ status: "public" }] }] }) });
  assert.equal(published.built.state, "observed"); assert.equal(published.qualified.state, "observed");
  assert.equal(published.atn.state, "observed"); assert.equal(published.atn.releaseNotes, "missing");
  assert.equal(published.publicVerification.state, "observed");
  const uploadOnly = await releaseStatus({ tag, query: (endpoint) => endpoint.includes("/runs/2/attempts/1/jobs") ? { state: "observed", data: { jobs: [{ steps: [{ name: "Submit exact XPI to ATN signing", conclusion: "success" }] }] } } : query(endpoint), fetchImpl: async () => Response.json({ results: [] }) });
  assert.equal(uploadOnly.publicVerification.state, "unknown");
  assert.equal(uploadOnly.atnAcceptance.state, "observed");
  const failedAfterUpload = await releaseStatus({ tag, query: (endpoint) => endpoint.includes("/publish-thunderbird-addons.yml/runs?") ? { state: "observed", data: { workflow_runs: [{ id: 2, run_attempt: 1, conclusion: "failure", html_url: "failed-later" }] } } : endpoint.includes("/runs/2/attempts/1/jobs") ? { state: "observed", data: { jobs: [{ steps: [{ name: "Submit exact XPI to ATN signing", conclusion: "success" }] }] } } : query(endpoint), fetchImpl: async () => Response.json({ results: [] }) });
  assert.equal(failedAfterUpload.atnAcceptance.state, "observed");
  assert.equal(failedAfterUpload.publicVerification.state, "unknown");
  assert.ok(calls.every((endpoint) => !endpoint.includes("jwt")));
});

test("release preparation leaves originals intact when staging or replacement fails", async () => {
  const { rename } = await import("node:fs/promises");
  for (const failure of ["stage", "replace"] as const) {
    const root = await fixture();
    try {
      const original = await snapshot(root);
      let replacements = 0;
      const io = {
        writeFile: (async (file: Parameters<typeof writeFile>[0], ...args: [any, any?]) => {
          if (failure === "stage" && String(file).endsWith("next-1")) {
            await writeFile(file, "partial staged contents", args[1]);
            throw new Error("synthetic staging failure");
          }
          return writeFile(file, ...args);
        }) as typeof writeFile,
        rename: (async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1]) => {
          if (String(source).includes("next-") && ++replacements === 2) throw new Error("synthetic replacement failure");
          return rename(source, destination);
        }) as typeof rename,
      };
      await assert.rejects(prepareNextRelease({ root, version: "1.3.0", inspect: async () => ({ exists: false }), io }), /synthetic (?:staging|replacement) failure/u);
      assert.deepEqual(await snapshot(root), original, `${failure} failed after a partially written transaction`);
      const { readdir } = await import("node:fs/promises");
      assert.equal((await readdir(root)).some((file) => file.startsWith(".thunderclaw-release-prepare-")), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});


test("release preparation keeps introductory prose outside new release notes with or without existing sections", async () => {
  for (const existingSection of ["\n## Thunderbird extension [1.2.3]\n\nPrevious notes.\n", ""]) {
    const root = await fixture();
    try {
      const preamble = "# Changelog\n\nThunderClaw releases are component scoped.\n";
      await writeFile(path.join(root, "CHANGELOG.md"), `${preamble}${existingSection}`);
      await prepareNextRelease({ root, version: "1.3.0", inspect: async () => ({ exists: false }) });
      const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
      assert.ok(changelog.indexOf("ThunderClaw releases are component scoped.") < changelog.indexOf("## Thunderbird extension [1.3.0]"));
      const reviewed = changelog.replace(/<!-- release:prepare draft[^>]*-->\n\n- TODO: describe the shipped extension change\./u, "Reviewed new notes.");
      assert.equal(extractChangelogSection(reviewed, "thunderbird-extension", "1.3.0"), "Reviewed new notes.\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
