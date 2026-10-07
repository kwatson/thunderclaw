import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLASSIFIER_PATHS, RELEASE_PATHS, calculateAutomationFingerprint } from "../scripts/release-automation-fingerprint.mjs";

test("all admission stages share fingerprints compatible with recorded sha256sum evidence", () => {
  const fingerprint = calculateAutomationFingerprint();
  for (const [kind, files, expected] of [["classifier", CLASSIFIER_PATHS, fingerprint.classifierSha256],
    ["release", RELEASE_PATHS, fingerprint.releaseWorkflowSha256]] as const) {
    const originalEvidence = execFileSync("sha256sum", [...files]);
    assert.equal(createHash("sha256").update(originalEvidence).digest("hex"), expected);
    assert.equal(execFileSync(process.execPath, ["scripts/release-automation-fingerprint.mjs", kind],
      { encoding: "utf8" }).trim(), expected);
    for (const changed of files) {
      const modified = calculateAutomationFingerprint((file) => file === changed
        ? Buffer.concat([readFileSync(file), Buffer.from("\nchanged admission machinery\n")]) : readFileSync(file));
      assert.notEqual(kind === "classifier" ? modified.classifierSha256 : modified.releaseWorkflowSha256, expected, changed);
    }
  }
  assert.ok(CLASSIFIER_PATHS.includes("scripts/release-automation-fingerprint.mjs"), "the path list must authenticate itself");
  assert.ok(CLASSIFIER_PATHS.includes("scripts/openclaw-qualification-reconciliation.mjs"));
  assert.ok(CLASSIFIER_PATHS.includes("scripts/verify-marketplace-notes.mjs"));
  assert.equal(new Set(CLASSIFIER_PATHS).size, CLASSIFIER_PATHS.length);
  assert.throws(() => calculateAutomationFingerprint((file) => {
    if (file.endsWith("reconciliation.mjs")) throw new Error("missing trusted machinery");
    return readFileSync(file);
  }), /missing trusted machinery/u);
});
