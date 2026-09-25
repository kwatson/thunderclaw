import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyPreparedUpgrade, regenerateLockfile, snapshotGitRange } from "./classify-openclaw-upgrade.mjs";
import { validateReleaseState } from "./openclaw-release-state.mjs";
import { verifyAutopilotQualificationResult } from "./verify-openclaw-autopilot-result.mjs";

const sha40 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const automaticPhases = new Set(["tagged", "github-published", "clawhub-verified", "closeout-open", "complete"]);
const automationPaths = {
  controllerWorkflowSha: ".github/workflows/openclaw-autopilot.yml",
  qualificationWorkflowSha: ".github/workflows/qualify-openclaw-autopilot.yml",
};
const publicationWorkflowPaths = [".github/workflows/release-openclaw-plugin.yml", ".github/workflows/publish-clawhub.yml"];
const verifierPaths = ["scripts/classify-openclaw-release.mjs", "scripts/classify-openclaw-upgrade.mjs",
  "scripts/prepare-openclaw-upgrade.mjs", "scripts/openclaw-upgrade-policy.mjs", "scripts/openclaw-release-state.mjs",
  "scripts/verify-openclaw-autopilot-result.mjs", "scripts/openclaw-qualification.mjs"];

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function same(left, right) {
  return isDeepStrictEqual(left, right);
}

function requireEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) throw new Error(`${label} does not match the active reservation`);
}

function workflowPath(value) {
  return typeof value === "string" ? value.split("@")[0] : "";
}

export function classifyOpenClawRelease({ state: stateValue, stateCommit, result: resultValue, resultSha256,
  run, context, classification, automation, counterpart }) {
  const state = validateReleaseState(stateValue);
  if (!sha40.test(stateCommit)) throw new Error("durable state ref commit is malformed");
  if (!automaticPhases.has(state.phase) || state.blockers.length !== 0) {
    throw new Error("durable state has no active tagged automatic release");
  }
  const preparation = state.outputs.preparation;
  const dispatch = state.outputs.qualificationDispatch;
  const qualification = state.outputs.qualification;
  const merge = state.outputs.merge;
  const tagged = state.outputs.tagged;
  if (!preparation || !dispatch || !qualification || !merge || !tagged) throw new Error("durable state is missing release authorization outputs");
  requireEqual(preparation.reservationId, state.reservationId, "prepared reservation id");
  requireEqual(preparation.baseSha, state.baseSha, "prepared base commit");
  requireEqual(dispatch.requestId, qualification.requestId, "qualification request id");
  requireEqual(dispatch.workflow, qualification.workflow, "qualification workflow");
  requireEqual(dispatch.workflowCommit, qualification.workflowCommit, "qualification workflow commit");
  requireEqual(dispatch.workflowSha256, qualification.workflowSha256, "qualification workflow digest");
  requireEqual(qualification.headSha, preparation.candidateSha, "qualification candidate commit");
  requireEqual(qualification.headBranch, preparation.branch, "qualification candidate branch");
  requireEqual(merge.mergeTree, preparation.candidateTree, "merged candidate tree");
  requireEqual(merge.tag, preparation.tag, "reserved merge tag");
  requireEqual(tagged.tag, merge.tag, "created tag");
  requireEqual(tagged.commit, merge.mergeSha, "tagged merge commit");
  requireEqual(tagged.tree, merge.mergeTree, "tagged merge tree");
  if (!sha256.test(resultSha256) || qualification.evidenceSha256 !== resultSha256) {
    throw new Error("qualification artifact digest does not match durable state");
  }
  requireEqual(context.repository, resultValue.repository, "repository");
  requireEqual(context.repositoryId, resultValue.repositoryId, "repository id");
  requireEqual(context.tag, tagged.tag, "release tag");
  requireEqual(context.commit, tagged.commit, "release commit");
  requireEqual(context.tree, tagged.tree, "release tree");
  requireEqual(context.tree, preparation.candidateTree, "pre-qualified tree");
  requireEqual(context.pluginVersion, preparation.pluginVersion, "plugin version");
  requireEqual(context.tag, `openclaw-plugin-v${preparation.pluginVersion}`, "expected plugin tag");

  if (run === null || typeof run !== "object" || Array.isArray(run)) throw new Error("qualification run record is malformed");
  requireEqual(run.id, qualification.runId, "qualification run id");
  requireEqual(run.run_attempt, qualification.runAttempt, "qualification run attempt");
  requireEqual(run.event, "workflow_dispatch", "qualification run event");
  requireEqual(run.status, "completed", "qualification run status");
  requireEqual(run.conclusion, "success", "qualification run conclusion");
  requireEqual(run.head_sha, qualification.workflowCommit, "qualification workflow commit");
  requireEqual(run.head_sha, resultValue.workflowCommit, "qualification result workflow commit");
  requireEqual(run.head_branch, "main", "qualification workflow branch");
  requireEqual(workflowPath(run.path), ".github/workflows/qualify-openclaw-autopilot.yml", "qualification workflow path");
  requireEqual(run.repository?.full_name, context.repository, "qualification run repository");
  requireEqual(run.repository?.id, context.repositoryId, "qualification run repository id");

  if (classification?.decision !== "compatibility-only" || classification.findings?.length !== 0) {
    throw new Error("independent field-level classification is not compatibility-only");
  }
  requireEqual(qualification.workflow, ".github/workflows/qualify-openclaw-autopilot.yml", "reserved qualification workflow");
  requireEqual(qualification.workflowSha256, preparation.automation.qualificationWorkflowSha, "qualification workflow digest");
  requireEqual(qualification.event, "workflow_dispatch", "reserved qualification event");
  requireEqual(qualification.conclusion, "success", "reserved qualification conclusion");
  requireEqual(classification.evidenceSha256, preparation.classificationEvidenceSha256, "prepared classification evidence");
  requireEqual(classification.evidenceSha256, qualification.classificationEvidenceSha256, "qualification classification evidence");
  if (!same(automation, preparation.automation)) throw new Error("trusted automation changed after reservation");
  if (!same(counterpart, preparation.counterpart) || !same(counterpart, qualification.counterpart)) {
    throw new Error("qualified counterpart differs from the committed pin");
  }

  const expected = {
    repository: context.repository,
    repositoryId: String(context.repositoryId),
    workflowCommit: qualification.workflowCommit,
    workflowSha256: qualification.workflowSha256,
    runId: String(qualification.runId),
    runAttempt: String(qualification.runAttempt),
    requestId: qualification.requestId,
    reservationId: state.reservationId,
    version: state.identity.version,
    identitySha256: state.identitySha256,
    baseSha: state.baseSha,
    tag: tagged.tag,
    candidateArtifactSha256: qualification.candidateArtifactSha256,
    candidateRef: preparation.branch,
    candidateSha: preparation.candidateSha,
    candidateTree: preparation.candidateTree,
    counterpartRepository: counterpart.repository,
    counterpartTag: counterpart.tag,
    counterpartName: counterpart.name,
    counterpartSha256: counterpart.sha256,
    counterpartSize: String(counterpart.size),
    classificationSha256: classification.evidenceSha256,
    controllerWorkflowSha256: automation.controllerWorkflowSha,
    qualificationWorkflowSha256: automation.qualificationWorkflowSha,
    releaseWorkflowSha256: automation.releaseWorkflowSha,
    classifierSha256: automation.classifierSha,
  };
  verifyAutopilotQualificationResult(resultValue, expected);
  return { releaseLane: "automatic", reservationId: state.reservationId, stateCommit, phase: state.phase };
}

function git(root, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: root, encoding, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}

async function classifyRange(root, state, releaseBaseRef, afterRef) {
  const intervening = git(root, ["diff", "--name-only", "--no-renames", releaseBaseRef, state.baseSha]).trim().split("\n").filter(Boolean);
  if (intervening.some((file) => file !== "e2e/qualification/counterpart-baselines.json")) {
    throw new Error("changes since the published trust anchor are not limited to deterministic counterpart closeout");
  }
  const snapshots = snapshotGitRange(root, state.baseSha, afterRef);
  const preparedDate = state.outputs.preparation.preparedDate;
  const expectedLockfile = await regenerateLockfile(root, snapshots, state.baseline, preparedDate);
  return classifyPreparedUpgrade({ ...snapshots, preflight: state.baseline, preparedDate, expectedLockfile });
}

function readAt(root, ref, file) {
  return git(root, ["show", `${ref}:${file}`]);
}

function parseArguments(args) {
  const names = ["state", "state-commit", "result", "run", "repository", "repository-id", "tag", "commit", "tree"];
  const optional = ["root"];
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/u, "");
    if (![...names, ...optional].includes(key) || !args[index + 1] || values.has(key)) throw new Error("Invalid release classification arguments");
    values.set(key, args[index + 1]);
  }
  if (names.some((name) => !values.has(name))) throw new Error("All release classification arguments are required");
  return Object.fromEntries(values);
}

async function main(args) {
  const options = parseArguments(args);
  const root = path.resolve(options.root ?? path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
  const [stateBytes, resultBytes, runBytes] = await Promise.all([options.state, options.result, options.run].map((file) => readFile(file)));
  const state = JSON.parse(stateBytes.toString("utf8"));
  const result = JSON.parse(resultBytes.toString("utf8"));
  const run = JSON.parse(runBytes.toString("utf8"));
  const baselines = JSON.parse(readAt(root, options.commit, "e2e/qualification/counterpart-baselines.json"));
  const releaseBaseRef = baselines["openclaw-plugin"]?.tag;
  if (typeof releaseBaseRef !== "string" || !releaseBaseRef) throw new Error("published plugin release baseline is missing");
  const classification = await classifyRange(root, state, releaseBaseRef, options.commit);
  const automation = Object.fromEntries(Object.entries(automationPaths).map(([name, file]) => [name, digest(readAt(root, options.commit, file))]));
  automation.releaseWorkflowSha = digest(publicationWorkflowPaths.map((file) => `${digest(readAt(root, options.commit, file))}  ${file}\n`).join(""));
  automation.classifierSha = digest(verifierPaths.map((file) => `${digest(readAt(root, options.commit, file))}  ${file}\n`).join(""));
  const counterpart = { repository: options.repository, ...baselines["thunderbird-extension"] };
  const plugin = JSON.parse(readAt(root, options.commit, "packages/openclaw-plugin/package.json"));
  return classifyOpenClawRelease({ state, stateCommit: options["state-commit"], result, resultSha256: digest(resultBytes), run,
    context: { repository: options.repository, repositoryId: Number(options["repository-id"]), tag: options.tag,
      commit: options.commit, tree: options.tree, pluginVersion: plugin.version }, classification, automation, counterpart });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
