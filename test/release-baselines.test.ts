import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateReleaseBaselines } from "../scripts/validate-release-baselines.mjs";

test("legacy baseline ledger reserves both shared versions for both components", async () => {
  const ledger = JSON.parse(await readFile(new URL("../release-baselines.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateReleaseBaselines(ledger));
  assert.deepEqual(
    ledger.releases.map((release: { component: string; version: string }) => `${release.component}@${release.version}`).sort(),
    ["openclaw-plugin@0.1.0", "openclaw-plugin@0.1.1", "thunderbird-extension@0.1.0", "thunderbird-extension@0.1.1"],
  );
  const malformed = structuredClone(ledger);
  malformed.releases[0].assets[0].sha256 = "not-a-digest";
  assert.throws(() => validateReleaseBaselines(malformed), /invalid pinned asset/u);
});
