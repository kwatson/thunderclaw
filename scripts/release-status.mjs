import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseState } from "./openclaw-release-state.mjs";
import { expectedArtifactNames, verifyMarketplaceRelease } from "./verify-marketplace-release.mjs";
import { verifyClawHubRelease } from "./verify-marketplace-notes.mjs";
import { verifyPluginPublicationResume } from "./verify-plugin-publication-resume.mjs";
import { validateCounterpartBaselines } from "./verify-counterpart-baseline.mjs";
import { selectOriginalClawHubPublisher } from "./clawhub-publication-recovery.mjs";
import { verifyAutopilotQualificationResult } from "./verify-openclaw-autopilot-result.mjs";

const execute = promisify(execFile);
const REPOSITORY = "kwatson/thunderclaw";
const QUALIFICATION_JOBS = ["Bind immutable source and trusted workflow", "Deterministic tests, types, and packages",
  "Pinned OpenClaw integration", "Thunderbird Linux qualification", "Native Windows qualification",
  "Native macOS qualification", "Protected exact-pair real-agent qualification", "Bind successful qualification result"];
const WORKFLOWS = ["openclaw-autopilot.yml", "qualify-openclaw-autopilot.yml", "release-openclaw-plugin.yml",
  "publish-clawhub.yml", "complete-plugin-publication.yml", "complete-openclaw-autopilot-closeout.yml"];
const safeId = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const statusValue = (value) => ["queued", "in_progress", "completed", "waiting", "pending", "requested"].includes(value) ? value : "unknown";
const conclusionValue = (value) => value === null || ["success", "failure", "cancelled", "timed_out", "action_required", "skipped", "neutral", "stale", "startup_failure"].includes(value) ? value : "unknown";
const refValue = (value) => typeof value === "string" && /^(main|openclaw-plugin-v\d+\.\d+\.\d+|automation\/openclaw-\d{4}\.\d{1,2}\.\d+(?:-[a-f0-9]{8})?)$/u.test(value) ? value : "unknown";
const tagValue = (value) => typeof value === "string" && /^openclaw-plugin-v\d+\.\d+\.\d+$/u.test(value) ? value : "unknown";
const CHECK_NAMES = ["Tests, types, and packages", "Signoffs", "Release automation validation"];
const OTHER_JOBS = ["Select fail-closed release lane", "Validate and build plugin once", "Qualify exact plugin archive",
  "Qualify exact plugin with pinned extension / Protected real-agent pair qualification", "Create plugin GitHub release",
  "Promote manually qualified plugin to ClawHub", "Complete automatic plugin publication",
  "Complete automatic plugin publication / Authenticate existing qualified release",
  "Complete automatic plugin publication / Dispatch and verify tokenless ClawHub promotion",
  "Complete automatic plugin publication / Open exact counterpart baseline closeout",
  "Native qualification on ${{ matrix.platform }}", "Thunderbird ${{ matrix.thunderbird }}", "Pinned qualified OpenClaw integration",
  "Verify merged closeout and complete durable state"];
const runSummary = (run) => ({ id: safeId(run.id) ? run.id : undefined, attempt: safeId(run.run_attempt) ? run.run_attempt : undefined,
  source: sha(run.head_sha) ? run.head_sha : "unknown", branch: refValue(run.head_branch),
  workflow: WORKFLOWS.map((name) => `.github/workflows/${name}`).includes(run.path?.split("@")[0]) ? run.path.split("@")[0] : "unknown",
  status: statusValue(run.status), conclusion: conclusionValue(run.conclusion),
  url: safeId(run.id) ? `https://github.com/${REPOSITORY}/actions/runs/${run.id}` : undefined });
const jobSummary = (jobs) => jobs.map(({ name, status, conclusion }) => ({
  name: [...QUALIFICATION_JOBS, ...CHECK_NAMES, ...OTHER_JOBS].includes(name) ? name : "unrecognized job",
  status: statusValue(status), conclusion: conclusionValue(conclusion) }));

// No exception text, raw state, logs, environment, or publisher payload is emitted.
// Each read has a deadline; bounded pagination fails closed rather than hiding history.
export function createGitHubStatusClient() {
  const command = async (args, options = {}) => (await execute("gh", args,
    { timeout: 45_000, maxBuffer: 20 * 1024 * 1024, ...options })).stdout;
  const json = async (endpoint) => JSON.parse(await command(["api", `repos/${REPOSITORY}/${endpoint}`]));
  const content = async (file, ref) => {
    const data = await json(`contents/${file}?ref=${encodeURIComponent(ref)}`);
    if (data.encoding !== "base64" || typeof data.content !== "string") throw new Error("Invalid content");
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  };
  const list = async (endpoint, key) => {
    const entries = [];
    for (let page = 1; page <= 5; page += 1) {
      const data = await json(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const items = data[key];
      if (!Array.isArray(items)) throw new Error("Invalid list");
      entries.push(...items);
      if (entries.length >= data.total_count || items.length < 100) return entries;
    }
    throw new Error("History exceeds bounded inspection");
  };
  return {
    state: () => content("state.json", "automation/openclaw-autopilot-state"),
    workflows: () => list("actions/workflows", "workflows"),
    rollout: async () => (await json("actions/variables/OPENCLAW_AUTOPILOT_ENABLED")).value === "true",
    rules: () => json("rules/branches/main"),
    run: (id, attempt) => json(`actions/runs/${id}${attempt ? `/attempts/${attempt}` : ""}`),
    jobs: (id, attempt) => list(`actions/runs/${id}/attempts/${attempt}/jobs`, "jobs"),
    runs: (workflow, tag) => list(`actions/workflows/${workflow}/runs?branch=${encodeURIComponent(tag)}`, "workflow_runs"),
    release: (tag) => json(`releases/tags/${encodeURIComponent(tag)}`),
    pullRequest: (id) => json(`pulls/${id}`),
    baseline: () => content("e2e/qualification/counterpart-baselines.json", "main"),
    main: async () => (await json("git/ref/heads/main")).object.sha,
    checks: (commit) => list(`commits/${commit}/check-runs`, "check_runs"),
    artifacts: (id) => list(`actions/runs/${id}/artifacts`, "artifacts"),
    artifactText: async (artifact, member) => {
      if (!["clawhub-publish.json", "result.json"].includes(member) || !safeId(artifact.id)) throw new Error("Invalid artifact member");
      const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-status-submission-"));
      try {
        const archive = path.join(directory, "submission.zip");
        await writeFile(archive, await command(["api", `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { encoding: "buffer", maxBuffer: 1024 * 1024 }));
        // Read exactly one known member, without extracting any paths.
        const { stdout } = await execute("unzip", ["-p", archive, member], { timeout: 5_000, maxBuffer: 64 * 1024 });
        return stdout;
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    verifyPublic: async ({ state, release }) => {
      const tag = state.outputs.preparation.tag;
      const commit = state.outputs.merge.mergeSha;
      const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-status-public-"));
      try {
        const names = [...expectedArtifactNames("openclaw-plugin", state.outputs.preparation.pluginVersion),
          "SHA256SUMS", "release-notes.md", "release-provenance.json"].sort();
        if (release.draft || release.prerelease || release.tag_name !== tag
            || JSON.stringify(release.assets.map((asset) => asset.name).sort()) !== JSON.stringify(names)
            || release.assets.some((asset) => asset.size > 20 * 1024 * 1024)) throw new Error("Invalid public asset set");
        await command(["release", "download", tag, "--repo", REPOSITORY, "--dir", directory,
          ...names.flatMap((name) => ["--pattern", name])]);
        const verified = await verifyMarketplaceRelease({ directory, component: "openclaw-plugin", tag, repository: REPOSITORY, commit });
        const tagRef = await json(`git/ref/tags/${encodeURIComponent(tag)}`);
        let object = tagRef.object;
        for (let depth = 0; object?.type === "tag" && depth < 2; depth += 1) {
          if (!sha(object.sha)) throw new Error("Invalid tag object");
          object = (await json(`git/tags/${object.sha}`)).object;
        }
        if (object?.type !== "commit" || object.sha !== commit) throw new Error("Public tag identity mismatch");
        const provenance = JSON.parse(await readFile(path.join(directory, "release-provenance.json"), "utf8"));
        const runId = Number(provenance.build.run.split("/").at(-1));
        const run = await json(`actions/runs/${runId}/attempts/${provenance.build.attempt}`);
        const jobs = await list(`actions/runs/${runId}/attempts/${provenance.build.attempt}/jobs`, "jobs");
        if (run.run_attempt !== provenance.build.attempt) throw new Error("Attempt mismatch");
        const artifact = path.join(directory, verified.artifacts[0].name);
        verifyPluginPublicationResume({ repository: REPOSITORY, tag, commit, runId, run, jobs, state, provenance, bytes: await readFile(artifact) });
        await command(["attestation", "verify", artifact, "--repo", REPOSITORY,
          "--signer-workflow", `${REPOSITORY}/.github/workflows/release-openclaw-plugin.yml`,
          "--source-ref", `refs/tags/${tag}`, "--source-digest", commit]);
        await verifyClawHubRelease({ packageName: "@thunderclaw/openclaw-plugin", version: verified.version,
          notesFile: path.join(directory, "release-notes.md"), artifact, repository: REPOSITORY, tag, commit,
          timeoutMs: 0, requestTimeoutMs: 10_000 });
        return { verified: true, artifact: verified.artifacts[0], releaseRun: runSummary(run), jobs: jobSummary(jobs),
          githubUrl: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
          clawhubUrl: "https://clawhub.ai/thunderclaw/plugins/openclaw-plugin" };
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}

export async function collectReleaseStatus(client = createGitHubStatusClient()) {
  const report = { format: "thunderclaw-release-status-v1", repository: REPOSITORY, inspectedAt: new Date().toISOString(),
    assessment: "unknown", issues: [], evidence: {}, nextActions: [] };
  const read = async (label, action) => {
    try { return await action(); } catch { report.issues.push(`${label}: unavailable or invalid`); return undefined; }
  };
  const [state, workflows, rollout, rules] = await Promise.all([
    read("durable state", async () => validateReleaseState(await client.state())),
    read("workflow metadata", () => client.workflows()), read("rollout switch", () => client.rollout()),
    read("main protection", () => client.rules()),
  ]);
  if (workflows) {
    report.evidence.workflows = WORKFLOWS.map((name) => {
      const matches = workflows.filter((workflow) => workflow.path === `.github/workflows/${name}`);
      if (matches.length !== 1) { report.issues.push(`workflow ${name}: missing or ambiguous`); return { path: name, state: "unknown" }; }
      return { id: safeId(matches[0].id) ? matches[0].id : undefined, path: matches[0].path,
        state: ["active", "disabled_manually", "disabled_inactivity", "disabled_fork", "deleted"].includes(matches[0].state) ? matches[0].state : "unknown" };
    });
  }
  report.evidence.rolloutEnabled = rollout;
  const required = rules?.filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? []);
  const protectedMain = rules?.some((rule) => rule.type === "pull_request") && required?.length > 0;
  if (required?.some((check) => !CHECK_NAMES.includes(check.context))) report.issues.push("main protection: unrecognized required check");
  report.evidence.mainProtection = { pullRequestRequired: rules?.some((rule) => rule.type === "pull_request"),
    requiredChecks: required?.map(({ context, integration_id }) => ({ context: CHECK_NAMES.includes(context) ? context : "unrecognized check",
      integrationId: safeId(integration_id) ? integration_id : undefined })) };
  if (!state) { report.nextActions = ["Restore read access and inspect missing evidence; do not mutate release state."]; return report; }
  const { preparation, qualification, qualificationDispatch, closeout, completion } = state.outputs;
  report.evidence.state = { phase: state.phase, revision: state.revision, reservationId: state.reservationId,
    openclawVersion: state.identity.version, baseSha: state.baseSha, soakCompletesAt: state.soakCompletesAt,
    tag: preparation ? tagValue(preparation.tag) : undefined, candidateSha: preparation?.candidateSha,
    qualificationRequestId: /^[a-f0-9]{32}$/u.test(qualificationDispatch?.requestId) ? qualificationDispatch.requestId : undefined,
    workflowCommit: qualificationDispatch?.workflowCommit,
    candidateArtifactSha256: qualification?.candidateArtifactSha256 };
  if (qualification && safeId(qualification.runId) && safeId(qualification.runAttempt)) {
    const result = await read("exact qualification attempt", async () => {
      const [run, jobs] = await Promise.all([client.run(qualification.runId, qualification.runAttempt), client.jobs(qualification.runId, qualification.runAttempt)]);
      if (run.id !== qualification.runId || run.run_attempt !== qualification.runAttempt
          || run.head_sha !== qualification.workflowCommit || run.head_branch !== "main"
          || run.event !== "workflow_dispatch" || run.path?.split("@")[0] !== qualification.workflow
          || run.repository?.full_name !== REPOSITORY) throw new Error("Qualification identity mismatch");
      const passed = run.status === "completed" && run.conclusion === "success" && QUALIFICATION_JOBS.every((name) => {
        const matches = jobs.filter((job) => job.name === name);
        return matches.length === 1 && matches[0].status === "completed" && matches[0].conclusion === "success";
      });
      const artifacts = await client.artifacts(qualification.runId);
      const matches = artifacts.filter((artifact) => !artifact.expired
        && artifact.name === `openclaw-autopilot-result-${qualification.requestId}-${qualification.runAttempt}`);
      if (matches.length !== 1) throw new Error("Qualification result missing or ambiguous");
      const contents = await client.artifactText(matches[0], "result.json");
      if (createHash("sha256").update(contents).digest("hex") !== qualification.evidenceSha256) throw new Error("Evidence digest mismatch");
      verifyAutopilotQualificationResult(JSON.parse(contents), {
        repository: REPOSITORY, repositoryId: String(run.repository.id),
        workflowCommit: qualification.workflowCommit, workflowSha256: qualification.workflowSha256,
        runId: String(qualification.runId), runAttempt: String(qualification.runAttempt), requestId: qualification.requestId,
        reservationId: state.reservationId, version: String(state.identity.version), identitySha256: state.identitySha256,
        baseSha: state.baseSha, tag: preparation.tag, candidateArtifactSha256: qualification.candidateArtifactSha256,
        candidateRef: preparation.branch, candidateSha: preparation.candidateSha, candidateTree: preparation.candidateTree,
        counterpartRepository: preparation.counterpart.repository, counterpartTag: preparation.counterpart.tag,
        counterpartName: preparation.counterpart.name, counterpartSha256: preparation.counterpart.sha256,
        counterpartSize: String(preparation.counterpart.size), classificationSha256: preparation.classificationEvidenceSha256,
        controllerWorkflowSha256: preparation.automation.controllerWorkflowSha,
        qualificationWorkflowSha256: preparation.automation.qualificationWorkflowSha,
        releaseWorkflowSha256: preparation.automation.releaseWorkflowSha, classifierSha256: preparation.automation.classifierSha,
      });
      return { run: runSummary(run), jobs: jobSummary(jobs), passed };
    });
    if (result) report.evidence.qualification = result;
  }
  if (preparation?.tag && state.outputs.merge?.mergeSha) {
    const tag = preparation.tag;
    const [releaseRuns, publishers, release] = await Promise.all([
      read("original release runs", () => client.runs("release-openclaw-plugin.yml", tag)),
      read("original publisher runs", () => client.runs("publish-clawhub.yml", tag)),
      read("GitHub release", () => client.release(tag)),
    ]);
    if (releaseRuns) {
      report.evidence.releaseRuns = releaseRuns.map(runSummary);
      // No recommendation to delete/move a tag. The narrow automated audit requires
      // exactly one original run; even one failed run does not itself authorize recovery.
      report.evidence.originalReleaseRunCount = releaseRuns.length;
      const currentSourceRuns = releaseRuns.filter((run) => run.head_sha === state.outputs.merge.mergeSha
        && run.head_branch === tag && run.event === "push" && run.repository?.full_name === REPOSITORY
        && run.path?.split("@")[0] === ".github/workflows/release-openclaw-plugin.yml");
      report.evidence.currentSourceReleaseRunCount = currentSourceRuns.length;
      if (currentSourceRuns.length !== 1) report.issues.push("current source release run identity: missing or ambiguous");
    }
    if (publishers) {
      const publisher = await read("publisher identity", async () => selectOriginalClawHubPublisher(publishers,
        { repository: REPOSITORY, tag, commit: state.outputs.merge.mergeSha }));
      report.evidence.publisherRuns = publishers.map(runSummary);
      if (publisher) {
        const artifacts = await read("publisher artifacts", () => client.artifacts(publisher.id));
        const matches = artifacts?.filter((artifact) => artifact.name === `thunderclaw-clawhub-publication-${preparation.pluginVersion}` && !artifact.expired);
        if (matches?.length === 1) {
          const submission = await read("retained submission", async () => JSON.parse(await client.artifactText(matches[0], "clawhub-publish.json")));
          if (submission && submission.name === "@thunderclaw/openclaw-plugin" && submission.version === preparation.pluginVersion
              && ["pending", "published"].includes(submission.publicationStatus)
              && typeof submission.attemptId === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(submission.attemptId)) {
            report.evidence.submission = { status: submission.publicationStatus, attemptId: submission.attemptId };
          } else if (submission) report.issues.push("retained submission: incomplete or rejected; inspect original evidence");
        } else if (publisher.conclusion !== "success") report.issues.push("retained submission: unavailable or ambiguous");
      }
    }
    if (release) {
      const verified = await read("public bytes, provenance, attestation, source, notes and scans", () => client.verifyPublic({ state, release }));
      if (verified) report.evidence.publication = verified;
    }
  }
  if (safeId(closeout?.prNumber)) {
    const baseline = await read("baseline closeout and CI", async () => {
      const [pr, baselines, mainSha] = await Promise.all([client.pullRequest(closeout.prNumber), client.baseline(), client.main()]);
      validateCounterpartBaselines(baselines);
      const record = baselines["openclaw-plugin"];
      const expected = closeout.baseline;
      const baselineMatches = ["tag", "name", "sha256", "size"].every((key) => record[key] === expected[key]);
      if (pr.number !== closeout.prNumber || pr.base?.ref !== "main" || pr.base?.repo?.full_name !== REPOSITORY
          || pr.head?.sha !== closeout.headSha || !sha(mainSha)) throw new Error("Baseline identity mismatch");
      const [checks, prChecks] = await Promise.all([client.checks(mainSha), client.checks(closeout.headSha)]);
      const passedCheck = (source, requiredCheck) => {
        const matches = source.filter((check) => check.name === requiredCheck.context
          && (requiredCheck.integration_id === null || requiredCheck.integration_id === undefined || check.app?.id === requiredCheck.integration_id));
        // Historical successes never mask a newer rerun; ambiguity is not success.
        return matches.length === 1 && matches[0].status === "completed" && matches[0].conclusion === "success";
      };
      // Signoffs run on the PR, whereas ordinary CI also runs after merging.
      const ciPassed = protectedMain && required.every((check) => passedCheck(prChecks, check)
        && (check.context === "Signoffs" || passedCheck(checks, check)));
      return { prNumber: pr.number, url: `https://github.com/${REPOSITORY}/pull/${pr.number}`, merged: pr.merged === true,
        mergeSha: pr.merge_commit_sha, mainSha, baselineMatches, ciPassed: Boolean(ciPassed),
        completionMatches: pr.merge_commit_sha === completion?.mergeSha,
        checks: jobSummary(checks), prChecks: jobSummary(prChecks) };
    });
    if (baseline) report.evidence.baseline = baseline;
  }
  const automationEnabled = rollout === true && report.evidence.workflows?.length === WORKFLOWS.length
    && report.evidence.workflows.every((workflow) => workflow.state === "active");
  report.evidence.automationEnabled = Boolean(automationEnabled);
  const complete = state.phase === "complete" && report.evidence.qualification?.passed
    && report.evidence.publication?.verified === true && report.evidence.baseline?.merged
    && report.evidence.baseline.baselineMatches && report.evidence.baseline.completionMatches && report.evidence.baseline.ciPassed;
  report.assessment = report.issues.length ? "unknown" : complete ? "verified-complete" : "incomplete";
  if (state.phase === "cancelled" || state.phase === "blocked") report.assessment = "blocked";
  if (complete && !report.issues.length) report.nextActions = [automationEnabled
    ? "No release action required; automation is enabled." : "Release is verified; review disabled automation settings before expecting the next scheduled release."];
  else if (report.evidence.submission?.status === "pending" && report.evidence.publication?.verified !== true) report.nextActions = ["Track the accepted attempt and verify public bytes; do not upload another submission."];
  else if (["cancelled", "blocked"].includes(state.phase)) report.nextActions = ["Inspect retained failure evidence and obtain explicit recovery authorization; preserve qualified bytes and tag identity."];
  else if (state.phase === "observed") report.nextActions = [`Wait until ${state.soakCompletesAt} for observation policy; the controller must revalidate upstream before advancing.`];
  else if (state.phase === "complete") report.nextActions = ["Durable completion alone is insufficient; inspect missing or failed public, baseline, and CI evidence."];
  else report.nextActions = ["Inspect the exact run and missing evidence before choosing the runbook recovery path; do not retry publication blindly."];
  report.nextActions.push("Unpublished-tag recovery requires exactly one original run: a completed startup failure with zero jobs, or the runbook's exact seven-job qualification failure before publication. Affirmative absence evidence and maintainer authorization are required; this command never authorizes tag replacement.");
  return report;
}

export function formatReleaseStatus(report) {
  const state = report.evidence.state;
  return [`ThunderClaw release: ${report.assessment}`, ...(state ? [
    `OpenClaw ${state.openclawVersion}; ${state.tag ?? "candidate not prepared"}; durable phase ${state.phase} (revision ${state.revision})`,
    `Reservation: ${state.reservationId}`, `Candidate: ${state.candidateSha ?? "not prepared"}`,
    `Qualified SHA-256: ${state.candidateArtifactSha256 ?? "not recorded"}`] : []),
  ...(report.evidence.qualification ? [`Qualification: ${report.evidence.qualification.run.url} (attempt ${report.evidence.qualification.run.attempt})`] : []),
  ...(report.evidence.publication ? [`GitHub: ${report.evidence.publication.githubUrl}`, `ClawHub: ${report.evidence.publication.clawhubUrl}`] : []),
  `Automation enabled: ${report.evidence.automationEnabled === true ? "yes" : "no or unknown"}`,
  ...report.issues.map((issue) => `Evidence gap: ${issue}`), ...report.nextActions.map((action) => `Next: ${action}`)].join("\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).some((argument) => argument !== "--json") || process.argv.length > 3) {
    process.stderr.write("Usage: release-status.mjs [--json]\n"); process.exitCode = 2;
  } else {
    const report = await collectReleaseStatus();
    process.stdout.write(`${process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReleaseStatus(report)}\n`);
    if (report.assessment === "unknown" || report.assessment === "blocked") process.exitCode = 1;
  }
}
