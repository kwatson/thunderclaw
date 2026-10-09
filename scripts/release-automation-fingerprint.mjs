import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// One reviewed list binds every admission stage to the same machinery. Include
// this file so changing the list itself invalidates existing authorization.
export const CLASSIFIER_PATHS = Object.freeze([
  "scripts/classify-openclaw-release.mjs", "scripts/classify-openclaw-upgrade.mjs",
  "scripts/prepare-openclaw-upgrade.mjs", "scripts/openclaw-upgrade-policy.mjs",
  "scripts/openclaw-release-state.mjs", "scripts/verify-openclaw-autopilot-result.mjs",
  "scripts/openclaw-qualification.mjs", "scripts/assert-openclaw-autopilot-enabled.mjs",
  "scripts/classify-openclaw-qualification-failure.mjs", "scripts/verify-openclaw-foundation.mjs",
  "scripts/classify-change-scope.mjs", "scripts/openclaw-controller-recovery.mjs",
  "scripts/clawhub-publication-recovery.mjs", "scripts/openclaw-qualification-reconciliation.mjs",
  "scripts/reconcile-openclaw-authorized-tag.mjs",
  "scripts/recover-unpublished-openclaw-tag.mjs",
  "scripts/openclaw-unpublished-tag-recovery.mjs",
  "scripts/persist-openclaw-release-state.mjs",
  "scripts/verify-marketplace-notes.mjs", "scripts/release-automation-fingerprint.mjs",
]);
export const RELEASE_PATHS = Object.freeze([
  ".github/workflows/release-openclaw-plugin.yml", ".github/workflows/publish-clawhub.yml",
  ".github/workflows/complete-plugin-publication.yml",
]);

const digest = (value) => createHash("sha256").update(value).digest("hex");
export function combinedAutomationDigest(files, read = readFileSync) {
  return digest(files.map((file) => `${digest(read(file))}  ${file}\n`).join(""));
}

export function calculateAutomationFingerprint(read = readFileSync) {
  return {
    controllerWorkflowSha256: digest(read(".github/workflows/openclaw-autopilot.yml")),
    qualificationWorkflowSha256: digest(read(".github/workflows/qualify-openclaw-autopilot.yml")),
    classifierSha256: combinedAutomationDigest(CLASSIFIER_PATHS, read),
    releaseWorkflowSha256: combinedAutomationDigest(RELEASE_PATHS, read),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [kind] = process.argv.slice(2);
    if (!["classifier", "release"].includes(kind)) throw new Error("Expected classifier or release fingerprint");
    console.log(combinedAutomationDigest(kind === "classifier" ? CLASSIFIER_PATHS : RELEASE_PATHS));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
