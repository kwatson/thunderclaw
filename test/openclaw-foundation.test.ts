import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assessFoundationCloseout, assessFoundationCloseoutHistory, assessFoundationMigration, validateFoundationManifest } from "../scripts/verify-openclaw-foundation.mjs";

const manifest = JSON.parse(await readFile(new URL("../openclaw-autopilot-foundation.json", import.meta.url), "utf8"));
const liveBaselines = JSON.parse(await readFile(new URL("../e2e/qualification/counterpart-baselines.json", import.meta.url), "utf8"));
const sourceBaselines = structuredClone(liveBaselines);
sourceBaselines["openclaw-plugin"] = {
  tag: manifest.from.tag,
  name: manifest.from.artifactName,
  sha256: manifest.from.artifactSha256,
  size: manifest.from.artifactSize,
};
const sha = (value: string) => value.repeat(40);

function fixture() {
  return { manifest, baselines: sourceBaselines, plugin: { version: "0.1.11" }, qualification: { stableVersion: "2026.9.6" },
    tag: "openclaw-plugin-v0.1.11", commit: sha("a"), tree: sha("b"), sourceTagCommit: manifest.from.commit,
    manifestAbsentAtSource: true };
}

test("foundation migration is exact, one-patch, human-reviewed, and rooted at the published 0.1.10 anchor", () => {
  assert.equal(validateFoundationManifest(manifest), manifest);
  assert.deepEqual(assessFoundationMigration(fixture()), {
    releaseLane: "foundation", humanReviewRequired: true, counterpartCloseoutRequired: true,
    fromTag: "openclaw-plugin-v0.1.10", tag: "openclaw-plugin-v0.1.11", pluginVersion: "0.1.11",
    openclawVersion: "2026.9.6", commit: sha("a"), tree: sha("b"),
  });
});

async function successorFixture(closeout = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-foundation-history-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = async (file: string, value: unknown) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify(value));
  };
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); };
  git("init", "-b", "main");
  git("config", "user.name", "Synthetic test"); git("config", "user.email", "test@invalid");
  await write("packages/openclaw-plugin/package.json", { version: "0.1.11" });
  await write("openclaw-qualification.json", { stableVersion: "2026.9.6" });
  await write("e2e/qualification/counterpart-baselines.json", sourceBaselines);
  commit("Foundation"); git("tag", "openclaw-plugin-v0.1.11");
  if (closeout) {
    await write("e2e/qualification/counterpart-baselines.json", { "openclaw-plugin": {
      tag: "openclaw-plugin-v0.1.11", name: "thunderclaw-openclaw-plugin-0.1.11.tgz", sha256: "c".repeat(64), size: 123,
    } });
    commit("Close out exact foundation");
  }
  await write("packages/openclaw-plugin/package.json", { version: "0.1.12" });
  commit("Published successor"); git("tag", "openclaw-plugin-v0.1.12");
  const baselines = { "openclaw-plugin": {
    tag: "openclaw-plugin-v0.1.12", name: "thunderclaw-openclaw-plugin-0.1.12.tgz", sha256: "d".repeat(64), size: 456,
  } };
  await write("e2e/qualification/counterpart-baselines.json", baselines); commit("Close out successor");
  const state = {
    ...manifest.retireState, identity: { version: manifest.foundation.openclawVersion },
    baseline: { current: { pluginVersion: manifest.from.pluginVersion } },
  };
  return { root, git, input: { root, manifest, baselines, plugin: { version: "0.1.12" },
    qualification: { stableVersion: "2026.9.6" }, state } };
}

test("later published anchors preserve exact foundation retirement through historical closeout", async () => {
  const { root, git, input } = await successorFixture();
  try {
    assert.equal(assessFoundationCloseoutHistory(input).rolloverAllowed, true);
    assert.throws(() => assessFoundationCloseoutHistory({ ...input,
      state: { ...input.state, reservationId: "f".repeat(32) } }), /exact reviewed/u);
    assert.throws(() => assessFoundationCloseoutHistory({ ...input,
      plugin: { version: "0.1.13" } }), /successor does not match/u);
    assert.throws(() => assessFoundationCloseoutHistory({ ...input,
      qualification: { stableVersion: "2026.9.5" } }), /successor does not match/u);
    git("tag", "-f", "openclaw-plugin-v0.1.12", "openclaw-plugin-v0.1.11");
    assert.throws(() => assessFoundationCloseoutHistory(input), /tag does not match/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a successor pin cannot substitute for the foundation closeout or its ancestry", async () => {
  const { root, git, input } = await successorFixture(false);
  try {
    assert.throws(() => assessFoundationCloseoutHistory(input), /no exact foundation counterpart closeout/u);
    git("checkout", "--orphan", "unrelated"); git("commit", "-m", "Unrelated successor");
    git("tag", "-f", "openclaw-plugin-v0.1.12");
    assert.throws(() => assessFoundationCloseoutHistory(input), /not rooted/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("foundation migration cannot be reused, retargeted, or admitted from a different anchor", () => {
  for (const mutate of [
    (value: any) => { value.baselines["openclaw-plugin"].tag = "openclaw-plugin-v0.1.11"; },
    (value: any) => { value.tag = "openclaw-plugin-v0.1.12"; },
    (value: any) => { value.plugin.version = "0.1.12"; },
    (value: any) => { value.qualification.stableVersion = "2026.9.7"; },
    (value: any) => { value.sourceTagCommit = sha("c"); },
    (value: any) => { value.manifestAbsentAtSource = false; },
  ]) {
    const value = structuredClone(fixture()); mutate(value);
    assert.throws(() => assessFoundationMigration(value), /anchor|rooted|identity/u);
  }
});

test("foundation closeout retires only the exact reviewed durable state after the counterpart advances", () => {
  const closedBaselines = structuredClone(sourceBaselines);
  closedBaselines["openclaw-plugin"] = {
    tag: manifest.foundation.tag,
    name: `thunderclaw-openclaw-plugin-${manifest.foundation.pluginVersion}.tgz`,
    sha256: "c".repeat(64),
    size: 123,
  };
  const state = {
    revision: manifest.retireState.revision,
    phase: manifest.retireState.phase,
    reservationId: manifest.retireState.reservationId,
    identitySha256: manifest.retireState.identitySha256,
    identity: { version: manifest.foundation.openclawVersion },
    baseline: { current: { pluginVersion: manifest.from.pluginVersion } },
  };
  const input = { manifest, baselines: closedBaselines, plugin: { version: manifest.foundation.pluginVersion },
    qualification: { stableVersion: manifest.foundation.openclawVersion }, state };
  assert.deepEqual(assessFoundationCloseout(input), {
    rolloverAllowed: true,
    retiredReservationId: manifest.retireState.reservationId,
    retiredIdentitySha256: manifest.retireState.identitySha256,
    foundationTag: manifest.foundation.tag,
  });
  assert.throws(() => assessFoundationCloseout({ ...input, baselines: sourceBaselines }), /closeout has not advanced/u);
  assert.throws(() => assessFoundationCloseout({ ...input, state: { ...state, revision: state.revision + 1 } }), /exact reviewed/u);
});
