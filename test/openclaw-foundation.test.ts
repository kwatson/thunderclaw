import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assessFoundationCloseout, assessFoundationMigration, validateFoundationManifest } from "../scripts/verify-openclaw-foundation.mjs";

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
