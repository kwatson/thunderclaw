import assert from "node:assert/strict";
import test from "node:test";
import { dispatchRelease } from "../scripts/release-channel-dispatch.mjs";

test("historical combined tags remain permanently routed through the frozen v1 verifier", () => {
  for (const tag of ["v0.1.0", "v0.1.1"]) {
    assert.deepEqual(dispatchRelease(tag, "both"), {
      tag,
      version: tag.slice(1),
      layout: "legacy-combined-v1",
      verifier: "verify-legacy-marketplace-release.mjs",
      channels: ["openclaw-plugin", "thunderbird-extension"],
    });
    assert.deepEqual(dispatchRelease(tag, "openclaw-plugin").channels, ["openclaw-plugin"]);
    assert.deepEqual(dispatchRelease(tag, "thunderbird-extension").channels, ["thunderbird-extension"]);
  }
  assert.throws(() => dispatchRelease("v0.1.1"), /requires --channel/u);
});

test("independent tags can dispatch only their named channel", () => {
  assert.deepEqual(dispatchRelease("openclaw-plugin-v0.1.2"), {
    tag: "openclaw-plugin-v0.1.2",
    version: "0.1.2",
    layout: "independent-v2",
    verifier: "verify-marketplace-release.mjs",
    channels: ["openclaw-plugin"],
  });
  assert.deepEqual(dispatchRelease("thunderbird-extension-v2.0.0", "thunderbird-extension").channels, ["thunderbird-extension"]);
  assert.throws(() => dispatchRelease("openclaw-plugin-v0.1.2", "both"), /only the openclaw-plugin/u);
  assert.throws(() => dispatchRelease("thunderbird-extension-v0.1.2", "openclaw-plugin"), /only the thunderbird-extension/u);
});

test("dispatcher rejects every unrelated or noncanonical tag", () => {
  for (const tag of ["v0.1.2", "plugin-v0.1.2", "extension-v0.1.2", "openclaw-plugin-v01.2.3", "openclaw-plugin-v1.2", "main", "refs/tags/v0.1.1"]) {
    assert.throws(() => dispatchRelease(tag, "both"), /Unsupported release tag/u);
  }
});
