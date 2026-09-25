import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PREPARATION_FILES } from "./prepare-openclaw-upgrade.mjs";
import { verifyFoundationMigration } from "./verify-openclaw-foundation.mjs";

const classifierPaths = ["scripts/classify-openclaw-release.mjs", "scripts/classify-openclaw-upgrade.mjs",
  "scripts/prepare-openclaw-upgrade.mjs", "scripts/openclaw-upgrade-policy.mjs", "scripts/openclaw-release-state.mjs",
  "scripts/verify-openclaw-autopilot-result.mjs", "scripts/openclaw-qualification.mjs",
  "scripts/assert-openclaw-autopilot-enabled.mjs", "scripts/classify-openclaw-qualification-failure.mjs",
  "scripts/verify-openclaw-foundation.mjs"];
const releasePaths = [".github/workflows/release-openclaw-plugin.yml", ".github/workflows/publish-clawhub.yml"];

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`);
  return typeof result.stdout === "string" ? result.stdout.trim() : result.stdout;
}

export function sanitizedRehearsalEnvironment(source = process.env) {
  const environment = { ...source };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "OPENCLAW_AUTOPILOT_APP_PRIVATE_KEY", "CLAWHUB_TOKEN",
    "DEEPSEEK_API_KEY", "OPENCLAW_GATEWAY_TOKEN"]) delete environment[name];
  environment.CI = "true";
  environment.OPENCLAW_AUTOPILOT_ENABLED = "false";
  return environment;
}

export function parseIndependentClassification({ status, stdout = "", stderr = "" }) {
  const output = stdout.trim();
  if (![0, 1].includes(status) || !output) {
    throw new Error(`independent classification failed to execute: ${stderr.trim() || "no structured result"}`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`independent classification returned malformed evidence: ${stderr.trim() || "invalid JSON"}`);
  }
}

async function overlayWorkingTree(root, worktree) {
  const patch = spawnSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (patch.status !== 0) throw new Error("could not snapshot the working tree for rehearsal");
  if (patch.stdout.length > 0) run("git", ["apply", "--binary", "-"], { cwd: worktree, input: patch.stdout, encoding: null });
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root }).split("\0").filter(Boolean);
  for (const file of untracked) {
    await mkdir(path.dirname(path.join(worktree, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(worktree, file));
  }
}

async function combinedDigest(root, files) {
  const lines = [];
  for (const file of files) lines.push(`${createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")}  ${file}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

async function automationFingerprint(root) {
  return {
    controllerWorkflowSha256: createHash("sha256").update(await readFile(path.join(root, ".github/workflows/openclaw-autopilot.yml"))).digest("hex"),
    qualificationWorkflowSha256: createHash("sha256").update(await readFile(path.join(root, ".github/workflows/qualify-openclaw-autopilot.yml"))).digest("hex"),
    classifierSha256: await combinedDigest(root, classifierPaths),
    releaseWorkflowSha256: await combinedDigest(root, releasePaths),
  };
}

export async function rehearseOpenClawAutopilot({ root, baselineFile, preflightFile, soakWaived = false }) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-autopilot-rehearsal-"));
  const worktree = path.join(parent, "source");
  const environment = sanitizedRehearsalEnvironment();
  try {
    run("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: root });
    await overlayWorkingTree(root, worktree);
    run("git", ["add", "-A"], { cwd: worktree });
    const originalHead = run("git", ["rev-parse", "HEAD"], { cwd: worktree });
    const sourceTree = run("git", ["write-tree"], { cwd: worktree });
    const originalTree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: worktree });
    const sourceCommit = sourceTree === originalTree ? originalHead : run("git", ["commit-tree", sourceTree, "-p", originalHead,
      "-m", "Rehearsal source snapshot"], { cwd: worktree, env: { ...environment,
      GIT_AUTHOR_NAME: "thunderclaw-rehearsal", GIT_AUTHOR_EMAIL: "rehearsal@invalid",
      GIT_COMMITTER_NAME: "thunderclaw-rehearsal", GIT_COMMITTER_EMAIL: "rehearsal@invalid" } });
    run("git", ["reset", "--mixed", sourceCommit], { cwd: worktree });
    const expectedBinding = await automationFingerprint(worktree);
    const baseline = path.join(parent, "baseline.json"); const preflight = path.join(parent, "preflight.json");
    await copyFile(baselineFile, baseline); await copyFile(preflightFile, preflight);
    const proposed = JSON.parse(await readFile(preflight, "utf8"));
    const preparedDate = proposed.proposed.upstream.publishedAt.slice(0, 10);
    const prepareOutput = run("mise", ["exec", "--", "node", "scripts/prepare-openclaw-upgrade.mjs",
      "--baseline", baseline, "--preflight", preflight, "--root", worktree, "--date", preparedDate,
      "--soak-waived", String(soakWaived)], { cwd: worktree, env: environment });
    const prepared = JSON.parse(prepareOutput);
    const classificationRun = spawnSync("mise", ["exec", "--", "node", "scripts/classify-openclaw-upgrade.mjs",
      "--preflight", preflight, "--root", worktree, "--date", preparedDate],
    { cwd: worktree, env: environment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const classification = parseIndependentClassification(classificationRun);
    if (!new Set(["compatibility-only", "blocked"]).has(classification.decision)
        || (classification.decision === "compatibility-only") !== (classification.findings.length === 0)) {
      throw new Error("independent candidate classification returned an inconsistent decision");
    }
    run("mise", ["exec", "--", "npm", "ci"], { cwd: worktree, env: environment });
    run("mise", ["exec", "--", "npm", "test"], { cwd: worktree, env: environment });
    run("mise", ["exec", "--", "npm", "run", "typecheck"], { cwd: worktree, env: environment });
    run("mise", ["exec", "--", "npm", "run", "pack:plugin"], { cwd: worktree, env: environment });
    const artifact = path.join(worktree, "build", `thunderclaw-openclaw-plugin-${prepared.pluginVersion}.tgz`);
    const artifactReport = JSON.parse(run("mise", ["exec", "--", "node", "scripts/validate-candidate-artifact.mjs", "plugin-tgz", artifact],
      { cwd: worktree, env: environment }));
    run("git", ["add", "--", ...PREPARATION_FILES], { cwd: worktree });
    const candidateTree = run("git", ["write-tree"], { cwd: worktree });
    const baseSha = sourceCommit;
    const candidateSha = run("git", ["commit-tree", candidateTree, "-p", baseSha, "-m", `Rehearse OpenClaw ${proposed.proposed.version}`], {
      cwd: worktree, env: { ...environment, GIT_AUTHOR_NAME: "thunderclaw-rehearsal", GIT_AUTHOR_EMAIL: "rehearsal@invalid",
        GIT_COMMITTER_NAME: "thunderclaw-rehearsal", GIT_COMMITTER_EMAIL: "rehearsal@invalid" },
    });
    const foundation = await verifyFoundationMigration({ root: worktree,
      tag: `openclaw-plugin-v${prepared.pluginVersion}`, commit: candidateSha });
    const sourceBinding = await automationFingerprint(worktree);
    if (JSON.stringify(sourceBinding) !== JSON.stringify(expectedBinding)
        || run("git", ["show", "-s", "--format=%T", candidateSha], { cwd: worktree }) !== candidateTree) {
      throw new Error("candidate source or trusted automation fingerprint changed across rehearsal stages");
    }
    return {
      format: "thunderclaw-openclaw-autopilot-rehearsal-v1", mutationCredentialsAvailable: false,
      candidate: { openclawVersion: proposed.proposed.version, pluginVersion: prepared.pluginVersion,
        baseSha, sha: candidateSha, tree: candidateTree, artifactSha256: artifactReport.sha256 },
      classification: { decision: classification.decision, findings: classification.findings,
        evidenceSha256: classification.evidenceSha256 },
      sourceBinding,
      releaseAdmission: foundation,
      checks: { lockfileRegeneratedIndependently: true, sourceBindingVerified: true,
        failureCancellationReplayContracts: "success", tests: "success", typecheck: "success",
        artifactValidated: true, externalMutations: 0 },
    };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, encoding: "utf8" });
    await rm(parent, { recursive: true, force: true });
  }
}

function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const root = path.resolve(option(process.argv, "--root") ?? ".");
    const baselineFile = option(process.argv, "--baseline"); const preflightFile = option(process.argv, "--preflight");
    if (!baselineFile || !preflightFile) throw new Error("Usage: rehearse-openclaw-autopilot.mjs --baseline FILE --preflight FILE [--root PATH] [--soak-waived true|false]");
    const soak = option(process.argv, "--soak-waived") ?? "false";
    if (!new Set(["true", "false"]).has(soak)) throw new Error("--soak-waived must be true or false");
    process.stdout.write(`${JSON.stringify(await rehearseOpenClawAutopilot({ root, baselineFile: path.resolve(baselineFile),
      preflightFile: path.resolve(preflightFile), soakWaived: soak === "true" }), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
