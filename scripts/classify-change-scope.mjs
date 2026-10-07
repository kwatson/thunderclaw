import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Only reviewed internal tooling is exempt. Unknown paths affect both products.
const internalScripts = new Set([
  "assert-openclaw-autopilot-enabled.d.mts",
  "assert-openclaw-autopilot-enabled.mjs",
  "bootstrap-spike.sh",
  "cancel-spike.ts",
  "check-dco.d.mts",
  "check-dco.mjs",
  "classify-openclaw-qualification-failure.d.mts",
  "classify-openclaw-qualification-failure.mjs",
  "classify-openclaw-release.d.mts",
  "classify-openclaw-release.mjs",
  "classify-openclaw-upgrade.d.mts",
  "classify-openclaw-upgrade.mjs",
  "deepseek-capture-proxy.mjs",
  "install-native-thunderbird.ps1",
  "install-native-thunderbird.sh",
  "openclaw-qualification.d.mts",
  "openclaw-qualification.mjs",
  "openclaw-release-state.d.mts",
  "openclaw-release-state.mjs",
  "openclaw-upgrade-policy.d.mts",
  "openclaw-upgrade-policy.mjs",
  "patch-clawhub-publisher.d.mts",
  "patch-clawhub-publisher.mjs",
  "preflight-openclaw-upgrade.d.mts",
  "preflight-openclaw-upgrade.mjs",
  "prepare-openclaw-upgrade.d.mts",
  "prepare-openclaw-upgrade.mjs",
  "qualify-native-filesystem.ts",
  "qualify-pairing-recovery.ts",
  "qualify-pairing.ts",
  "rehearse-openclaw-autopilot.d.mts",
  "rehearse-openclaw-autopilot.mjs",
  "release-channel-dispatch.d.mts",
  "release-channel-dispatch.mjs",
  "release-metadata.d.mts",
  "release-metadata.mjs",
  "run-openclaw-ci.sh",
  "run-thunderbird-e2e.sh",
  "run-thunderbird-rich-compose-e2e.sh",
  "run-thunderbird-upgrade-e2e.sh",
  "spike-client.ts",
  "spike-plugin-config.json",
  "sqlite-backup-file-set.ts",
  "stage-openclaw-provider.d.mts",
  "stage-openclaw-provider.mjs",
  "submit-thunderbird-addon.d.mts",
  "submit-thunderbird-addon.mjs",
  "update-counterpart-baseline.d.mts",
  "update-counterpart-baseline.mjs",
  "validate-candidate-artifact.mjs",
  "validate-release-baselines.d.mts",
  "validate-release-baselines.mjs",
  "verify-atn-release.d.mts",
  "verify-atn-release.mjs",
  "verify-atn-xpi-payload.d.mts",
  "verify-atn-xpi-payload.mjs",
  "verify-counterpart-baseline.d.mts",
  "verify-counterpart-baseline.mjs",
  "verify-legacy-clawhub-release.mjs",
  "verify-legacy-marketplace-release.d.mts",
  "verify-legacy-marketplace-release.mjs",
  "verify-marketplace-notes.d.mts",
  "verify-marketplace-notes.mjs",
  "verify-marketplace-release-v1.d.mts",
  "verify-marketplace-release-v1.mjs",
  "verify-marketplace-release.d.mts",
  "verify-marketplace-release.mjs",
  "verify-openclaw-autopilot-result.d.mts",
  "verify-openclaw-autopilot-result.mjs",
  "verify-openclaw-foundation.d.mts",
  "verify-openclaw-foundation.mjs",
  "verify-openclaw-qualification.mjs",
  "verify-plugin-publication-resume.d.mts",
  "verify-plugin-publication-resume.mjs",
  "clawhub-publication-recovery.mjs",
  "clawhub-publication-recovery.d.mts",
  "openclaw-controller-recovery.mjs",
  "openclaw-controller-recovery.d.mts",
  "rehearse-release-operations.mjs",
  "rehearse-release-operations.d.mts",
  "release-automation-fingerprint.mjs",
  "release-automation-fingerprint.d.mts",
  "openclaw-qualification-reconciliation.mjs",
  "openclaw-qualification-reconciliation.d.mts",
  "reconcile-openclaw-authorized-tag.mjs",
  "reconcile-openclaw-authorized-tag.d.mts",
  "persist-openclaw-release-state.mjs",
  "persist-openclaw-release-state.d.mts",
  "classify-change-scope.mjs",
  "classify-change-scope.d.mts"
]);
const pluginPackaging = new Set(["scripts/package-openclaw-plugin.mjs", "scripts/sync-package-legal.mjs", "scripts/generate-package-assets.mjs"]);
const extensionPackaging = new Set(["scripts/build-extension.mjs", "scripts/package-extension-source.mjs", "SOURCE_REVIEW.md"]);

export function classifyChangeScope(files) {
  const plugin = []; const extension = []; const internal = []; const documentation = [];
  for (const file of files) {
    // Product inputs take precedence over documentation and tooling exemptions.
    if (file.startsWith("packages/openclaw-plugin/") || pluginPackaging.has(file)
        || file === "docs/brand/assets/raster/icons/thunderclaw-openclaw-plugin-icon-256.png"
        || file === "openclaw-qualification.json") plugin.push(file);
    else if (file.startsWith("packages/thunderbird-extension/") || extensionPackaging.has(file)) extension.push(file);
    else if (file.startsWith(".github/") || file.startsWith("test/") || file.startsWith("fixtures/")
        || file.startsWith("e2e/") || file.startsWith("site/") || file === "scripts/build-pages.mjs"
        || file === "openclaw-autopilot-foundation.json"
        || (file.startsWith("scripts/") && internalScripts.has(file.slice(8)))) internal.push(file);
    else if (file.startsWith("docs/") || (!file.includes("/") && file.endsWith(".md"))) documentation.push(file);
    else { plugin.push(file); extension.push(file); }
  }
  return { plugin, extension, internal, documentation,
    runChecks: plugin.length + extension.length + internal.length > 0,
    qualifyPlugin: plugin.length > 0, qualifyExtension: extension.length > 0 };
}

export function changedFiles(root, base, target) {
  // Include both names of renames and fail on missing history; never hide an error as an empty diff.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, target],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

export function assessPublishedPluginChanges(root, tag, base) {
  execFileSync("git", ["merge-base", "--is-ancestor", tag, base], { cwd: root, stdio: "pipe" });
  const scope = classifyChangeScope(changedFiles(root, tag, base));
  return { ...scope, findings: scope.plugin.map((file) => `unreleased plugin input: ${file}`) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === "--published-plugin") {
    const [, tag, base] = process.argv.slice(2);
    const assessment = assessPublishedPluginChanges(process.cwd(), tag, base);
    process.stdout.write(`${JSON.stringify(assessment)}\n`);
    if (assessment.findings.length) process.exitCode = 1;
  } else {
    const [base, target] = process.argv.slice(2);
    // Dispatches deliberately request broad validation. Missing push history also fails closed.
    const scope = base && target && !/^0+$/u.test(base)
      ? classifyChangeScope(changedFiles(process.cwd(), base, target))
      : { runChecks: true, qualifyPlugin: true, qualifyExtension: true };
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `run_full=${scope.runChecks}\nqualify_plugin=${scope.qualifyPlugin}\nqualify_extension=${scope.qualifyExtension}\n`);
    process.stdout.write(`${JSON.stringify(scope)}\n`);
  }
}
