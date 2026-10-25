import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Only reviewed development tooling is exempt from extension packaging checks.
// Unknown paths conservatively affect the standalone extension.
const internalScripts = new Set([
  "check.mjs", "check.d.mts", "check-dco.mjs", "check-dco.d.mts",
  "classify-change-scope.mjs", "classify-change-scope.d.mts",
  "install-native-thunderbird.ps1", "install-native-thunderbird.sh",
  "provider-trials.ts", "release-prepare.mjs", "release-prepare.d.mts",
  "release-status.mjs", "release-status.d.mts",
  "release-channel-dispatch.mjs", "release-channel-dispatch.d.mts",
  "release-metadata.mjs", "release-metadata.d.mts",
  "run-thunderbird-e2e.sh", "run-thunderbird-rich-compose-e2e.sh",
  "submit-thunderbird-addon.mjs", "submit-thunderbird-addon.d.mts",
  "validate-candidate-artifact.mjs",
  "verify-atn-release.mjs", "verify-atn-release.d.mts",
  "verify-atn-xpi-payload.mjs", "verify-atn-xpi-payload.d.mts",
  "verify-marketplace-notes.mjs", "verify-marketplace-notes.d.mts",
  "verify-marketplace-release.mjs", "verify-marketplace-release.d.mts",
]);
const extensionPackaging = new Set([
  ".mise.toml", "scripts/build-extension.mjs", "scripts/package-extension-source.mjs", "SOURCE_REVIEW.md",
]);

export function classifyChangeScope(files) {
  const extension = []; const internal = []; const documentation = [];
  for (const file of files) {
    if (file.startsWith("packages/thunderbird-extension/") || extensionPackaging.has(file)) extension.push(file);
    else if (file.startsWith(".github/") || file.startsWith("test/")
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
