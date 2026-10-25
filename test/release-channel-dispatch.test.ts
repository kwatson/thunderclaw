import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dispatchRelease } from "../scripts/release-channel-dispatch.mjs";

test("the active dispatcher accepts only the standalone extension publication channel", () => {
  assert.deepEqual(dispatchRelease("thunderbird-extension-v0.2.4"), {
    tag: "thunderbird-extension-v0.2.4", version: "0.2.4", layout: "independent-v2",
    verifier: "verify-marketplace-release.mjs", channels: ["thunderbird-extension"],
  });
  assert.deepEqual(dispatchRelease("thunderbird-extension-v2.0.0", "thunderbird-extension").channels, ["thunderbird-extension"]);
  assert.throws(() => dispatchRelease("thunderbird-extension-v1.2.3", "openclaw-plugin" as "thunderbird-extension"), /only the thunderbird-extension/u);
  assert.throws(() => dispatchRelease("thunderbird-extension-v1.2.3", "both" as "thunderbird-extension"), /only the thunderbird-extension/u);
});

test("retired plugin and combined tags and noncanonical identities cannot dispatch publication", () => {
  for (const tag of ["openclaw-plugin-v1.2.3", "v0.1.0", "v0.1.1", "v0.1.2", "main", "refs/tags/thunderbird-extension-v1.2.3", "thunderbird-extension-v01.2.3", "thunderbird-extension-v1.2.3-beta.1", "thunderbird-extension-v1.2.3\n"]) {
    assert.throws(() => dispatchRelease(tag), /Unsupported release tag/u);
  }
});

test("the dispatcher CLI rejects obsolete publication channels", () => {
  const script = new URL("../scripts/release-channel-dispatch.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, "--tag", "thunderbird-extension-v1.2.3", "--channel", "both"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /only the thunderbird-extension/u);
});
