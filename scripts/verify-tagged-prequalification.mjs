import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyOpenClawRelease } from "./classify-openclaw-release.mjs";
import { calculateAutomationFingerprint } from "./release-automation-fingerprint.mjs";
import { validateReleaseState } from "./openclaw-release-state.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requiredJobs = ["Bind immutable source and trusted workflow", "Deterministic tests, types, and packages", "Pinned OpenClaw integration", "Thunderbird Linux qualification", "Native Windows qualification", "Native macOS qualification", "Protected exact-pair real-agent qualification", "Bind successful qualification result"];

export function assertTaggedPrequalificationEntry({ reuseRequested, component, releaseLane, event, ref, workflowRef, repository, tag }) {
  if (reuseRequested !== true || component !== "openclaw-plugin" || releaseLane !== "automatic"
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")
      || event !== "push" || !/^openclaw-plugin-v\d+\.\d+\.\d+$/u.test(tag ?? "")
      || ref !== `refs/tags/${tag}`
      || workflowRef !== `${repository}/.github/workflows/release-openclaw-plugin.yml@refs/tags/${tag}`) {
    throw new Error("Prequalification reuse requires an explicit automatic plugin release tag push from its trusted release workflow");
  }
}

// Production lane admission remains the authority. This receipt additionally
// binds the files actually downloaded by this job and every recorded native job.
export function verifyTaggedPrequalification({ classificationInput, entry, jobs, pluginBytes, counterpartBytes, counterpartName }) {
  assertTaggedPrequalificationEntry(entry);
  if (entry.repository !== classificationInput.context.repository || entry.tag !== classificationInput.context.tag) {
    throw new Error("Prequalification entry does not match classified source identity");
  }
  const admitted = classifyOpenClawRelease(classificationInput);
  for (const name of requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`Prequalification requires exactly one successful recorded job: ${name}`);
    }
  }
  const expectedPlugin = classificationInput.state.outputs.qualification.candidateArtifactSha256;
  const actualPlugin = digest(pluginBytes);
  if (actualPlugin !== expectedPlugin) throw new Error("Downloaded plugin bytes differ from the qualified archive");
  const expectedCounterpart = classificationInput.counterpart;
  const actualCounterpart = digest(counterpartBytes);
  if (counterpartName !== expectedCounterpart.name || counterpartBytes.byteLength !== expectedCounterpart.size
      || actualCounterpart !== expectedCounterpart.sha256) {
    throw new Error("Downloaded counterpart bytes differ from the qualified pin");
  }
  return {
    format: "thunderclaw-tagged-prequalification-receipt-v1", decision: "pass", releaseLane: admitted.releaseLane,
    reservationId: admitted.reservationId, stateCommit: admitted.stateCommit,
    source: { repository: entry.repository, tag: entry.tag, commit: classificationInput.context.commit, tree: classificationInput.context.tree },
    qualification: { runId: classificationInput.run.id, runAttempt: classificationInput.run.run_attempt,
      requestId: classificationInput.result.requestId, evidenceSha256: classificationInput.resultSha256 },
    plugin: { sha256: actualPlugin, size: pluginBytes.byteLength },
    counterpart: { ...expectedCounterpart },
    gates: { ...classificationInput.result.gates },
    automation: { ...classificationInput.automation },
  };
}

async function regularBytes(file) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("Qualification inputs must be unlinked regular files");
  return readFile(file);
}

export async function authenticateTaggedPrequalification({ root, plugin, counterpart, output, environment = process.env, execute = execFileSync }) {
  const entry = { reuseRequested: environment.THUNDERCLAW_REUSE_PREQUALIFICATION === "true", component: environment.THUNDERCLAW_QUALIFICATION_COMPONENT,
    releaseLane: environment.RELEASE_LANE, event: environment.GITHUB_EVENT_NAME, ref: environment.GITHUB_REF,
    workflowRef: environment.GITHUB_WORKFLOW_REF, repository: environment.GITHUB_REPOSITORY, tag: environment.GITHUB_REF_NAME };
  assertTaggedPrequalificationEntry(entry);
  const invoke = (command, args, cwd = root, encoding = "utf8") => {
    try { return execute(command, args, { cwd, encoding, env: environment, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }); }
    catch { throw new Error(`Tagged prequalification evidence command failed (${command})`); }
  };
  const run = (command, args, cwd = root) => invoke(command, args, cwd).trim();
  const git = (args) => run("git", args);
  const api = (route) => JSON.parse(run("gh", ["api", `repos/${entry.repository}/${route}`]));
  const commit = environment.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/u.test(commit ?? "") || git(["rev-parse", "HEAD"]) !== commit
      || git(["rev-parse", `${entry.ref}^{commit}`]) !== commit) throw new Error("Checkout does not match the exact plugin tag source");
  const stateCommit = api("git/ref/heads/automation/openclaw-autopilot-state").object.sha;
  if (!/^[a-f0-9]{40}$/u.test(stateCommit ?? "")) throw new Error("State ref identity is malformed");
  const contents = api(`contents/state.json?ref=${stateCommit}`);
  if (contents.encoding !== "base64" || typeof contents.content !== "string") throw new Error("State contents are unavailable");
  const state = validateReleaseState(JSON.parse(Buffer.from(contents.content, "base64").toString("utf8")));
  const qualification = state.outputs.qualification;
  if (!qualification) throw new Error("State has no successful prequalification");
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-tagged-prequalification-"));
  const trusted = path.join(directory, "trusted");
  try {
    git(["worktree", "add", "--detach", trusted, state.baseSha]);
    const trustedDigest = run("mise", ["exec", "--", "node", "scripts/release-automation-fingerprint.mjs", "classifier"], trusted);
    if (trustedDigest !== state.outputs.preparation.automation.classifierSha) throw new Error("Reserved verifier machinery does not match trusted source");
    const recordedRun = api(`actions/runs/${qualification.runId}`);
    const requestId = qualification.requestId;
    const artifact = `openclaw-autopilot-result-${requestId}-${qualification.runAttempt}`;
    run("gh", ["run", "download", String(qualification.runId), "--repo", entry.repository, "--name", artifact, "--dir", path.join(directory, "result")]);
    const resultFile = path.join(directory, "result/result.json");
    const resultBytes = await regularBytes(resultFile);
    const stateFile = path.join(directory, "state.json");
    const runFile = path.join(directory, "run.json");
    await writeFile(stateFile, JSON.stringify(state));
    await writeFile(runFile, JSON.stringify(recordedRun));
    const tree = git(["show", "-s", "--format=%T", commit]);
    // The reserved verifier independently regenerates the field-level candidate
    // classification and hashes the tag's machinery before authorizing reuse.
    const proof = JSON.parse(run("mise", ["exec", "--", "node", path.join(trusted, "scripts/classify-openclaw-release.mjs"),
      "--root", root, "--state", stateFile, "--state-commit", stateCommit, "--result", resultFile, "--run", runFile,
      "--repository", entry.repository, "--repository-id", environment.GITHUB_REPOSITORY_ID,
      "--tag", entry.tag, "--commit", commit, "--tree", tree]));
    if (proof.releaseLane !== "automatic" || proof.reservationId !== state.reservationId || proof.stateCommit !== stateCommit) throw new Error("Trusted classifier did not admit this exact reservation");
    const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${entry.repository}/actions/runs/${qualification.runId}/attempts/${qualification.runAttempt}/jobs?per_page=100`]));
    const jobs = pages.flatMap((page) => page.jobs);
    const baselines = JSON.parse(git(["show", `${commit}:e2e/qualification/counterpart-baselines.json`]));
    const pluginManifest = JSON.parse(git(["show", `${commit}:packages/openclaw-plugin/package.json`]));
    // Fingerprints require exact bytes, including original trailing newlines.
    const exactFingerprint = calculateAutomationFingerprint((file) => invoke("git", ["show", `${commit}:${file}`], root, "buffer"));
    const automation = { controllerWorkflowSha: exactFingerprint.controllerWorkflowSha256, qualificationWorkflowSha: exactFingerprint.qualificationWorkflowSha256,
      releaseWorkflowSha: exactFingerprint.releaseWorkflowSha256, classifierSha: exactFingerprint.classifierSha256 };
    const [pluginBytes, counterpartBytes] = await Promise.all([regularBytes(plugin), regularBytes(counterpart)]);
    const receipt = verifyTaggedPrequalification({ entry, jobs, pluginBytes, counterpartBytes, counterpartName: path.basename(counterpart), classificationInput: {
      state, stateCommit, result: JSON.parse(resultBytes), resultSha256: digest(resultBytes), run: recordedRun,
      context: { repository: entry.repository, repositoryId: Number(environment.GITHUB_REPOSITORY_ID), tag: entry.tag, commit, tree, pluginVersion: pluginManifest.version },
      classification: { decision: "compatibility-only", findings: [], evidenceSha256: state.outputs.preparation.classificationEvidenceSha256 }, automation,
      counterpart: { repository: entry.repository, ...baselines["thunderbird-extension"] },
    } });
    if (output) await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    try { git(["worktree", "remove", "--force", trusted]); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const values = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index]?.replace(/^--/u, "");
      if (!["root", "plugin", "counterpart", "output"].includes(key) || !process.argv[index + 1] || values[key]) throw new Error("Invalid tagged prequalification arguments");
      values[key] = process.argv[index + 1];
    }
    if (!values.plugin || !values.counterpart || !values.output) throw new Error("Expected --plugin, --counterpart and --output");
    const receipt = await authenticateTaggedPrequalification({ ...values, root: path.resolve(values.root ?? ".") });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch { process.stderr.write("Tagged prequalification verification failed; exact authenticated evidence is required\n"); process.exitCode = 1; }
}
