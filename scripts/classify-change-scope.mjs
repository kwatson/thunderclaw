import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Only reviewed development tooling is exempt from extension packaging checks.
// Unknown paths conservatively affect the standalone extension.
const internalScripts = new Set([
  "bootstrap-spike.sh", "cancel-spike.ts", "check-dco.d.mts", "check-dco.mjs",
  "classify-change-scope.d.mts", "classify-change-scope.mjs", "deepseek-capture-proxy.mjs",
  "generate-package-assets.mjs", "install-native-thunderbird.ps1", "install-native-thunderbird.sh",
  "npm-pack-output.d.mts", "npm-pack-output.mjs", "openclaw-qualification.d.mts", "openclaw-qualification.mjs",
  "package-openclaw-plugin.mjs", "qualify-gateway-startup.ts", "qualify-native-filesystem.ts",
  "qualify-pairing.ts", "qualify-pairing-recovery.ts", "qualification-readiness.ts",
  "qualification-diagnostics.d.mts", "qualification-diagnostics.mjs",
  "release-channel-dispatch.d.mts", "release-channel-dispatch.mjs", "release-metadata.d.mts", "release-metadata.mjs",
  "run-openclaw-ci.sh", "run-thunderbird-e2e.sh", "run-thunderbird-rich-compose-e2e.sh", "run-thunderbird-upgrade-e2e.sh",
  "spike-client.ts", "spike-plugin-config.json", "sqlite-backup-file-set.ts",
  "stage-openclaw-provider.d.mts", "stage-openclaw-provider.mjs", "sync-package-legal.mjs",
  "submit-thunderbird-addon.d.mts", "submit-thunderbird-addon.mjs",
  "update-counterpart-baseline.d.mts", "update-counterpart-baseline.mjs", "validate-candidate-artifact.mjs",
  "validate-release-baselines.d.mts", "validate-release-baselines.mjs",
  "verify-atn-release.d.mts", "verify-atn-release.mjs", "verify-atn-xpi-payload.d.mts", "verify-atn-xpi-payload.mjs",
  "verify-counterpart-baseline.d.mts", "verify-counterpart-baseline.mjs",
  "verify-marketplace-notes.d.mts", "verify-marketplace-notes.mjs",
  "verify-marketplace-release.d.mts", "verify-marketplace-release.mjs",
]);
const extensionPackaging = new Set([
  ".mise.toml", "scripts/build-extension.mjs", "scripts/package-extension-source.mjs", "SOURCE_REVIEW.md",
  // The reviewer source archive includes the workspace manifest for npm ci.
  "packages/openclaw-plugin/package.json",
]);

export function classifyChangeScope(files) {
  const extension = []; const internal = []; const documentation = [];
  for (const file of files) {
    if (file.startsWith("packages/thunderbird-extension/") || extensionPackaging.has(file)) extension.push(file);
    else if (file.startsWith("packages/openclaw-plugin/") || file === "openclaw-qualification.json"
        || file === "compose.spike.yaml" || file.startsWith(".github/") || file.startsWith("test/")
        || file.startsWith("fixtures/") || file.startsWith("e2e/") || file.startsWith("site/")
        || file === "scripts/build-pages.mjs"
        || (file.startsWith("scripts/") && internalScripts.has(file.slice(8)))) internal.push(file);
    else if (file.startsWith("docs/") || (!file.includes("/") && file.endsWith(".md"))) documentation.push(file);
    else extension.push(file);
  }
  return { extension, internal, documentation,
    runChecks: extension.length + internal.length > 0,
    qualifyExtension: extension.length > 0 };
}

export function changedFiles(root, base, target) {
  // Include both names of renames and fail on missing history; never hide an error as an empty diff.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, target],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [base, target] = process.argv.slice(2);
  // Dispatches deliberately request broad validation. Missing push history also fails closed.
  const scope = base && target && !/^0+$/u.test(base)
    ? classifyChangeScope(changedFiles(process.cwd(), base, target))
    : { runChecks: true, qualifyExtension: true };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `run_full=${scope.runChecks}\nqualify_extension=${scope.qualifyExtension}\n`);
  process.stdout.write(`${JSON.stringify(scope)}\n`);
}
