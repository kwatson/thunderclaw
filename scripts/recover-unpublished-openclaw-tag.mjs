import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = "kwatson/thunderclaw";
const stateRef = "refs/heads/automation/openclaw-autopilot-state";

import { authenticateUnpublishedRecovery } from "./openclaw-unpublished-tag-recovery.mjs";

function api(route) {
  const result = spawnSync("gh", ["api", "--include", `repos/${repository}/${route}`], { encoding: "utf8" });
  const status = Number(/^HTTP\/\S+ (\d+)/u.exec(result.stdout ?? "")?.[1]);
  if (![200, 404].includes(status)) throw new Error(`Cannot establish GitHub evidence for ${route}: HTTP ${status || "unknown"}`);
  const body = result.stdout.split(/\r?\n\r?\n/u).slice(1).join("\n\n");
  return { status, data: JSON.parse(body) };
}
const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

async function audit(runId, requireTagAbsent) {
  const stateCommit = api(`git/ref/${stateRef.slice(5)}`).data.object.sha;
  const state = JSON.parse(Buffer.from(api(`contents/state.json?ref=${stateCommit}`).data.content, "base64").toString());
  const { validateReleaseState } = await import("./openclaw-release-state.mjs");
  validateReleaseState(state);
  if (state.phase !== "tagged") throw new Error("Only an unpublished tagged reservation can recover");
  const { tag, commit } = state.outputs.tagged;
  const source = api(`actions/runs/${runId}`).data;
  const releaseRuns = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp",
    `repos/${repository}/actions/workflows/release-openclaw-plugin.yml/runs?per_page=100`], { encoding: "utf8" }))
    .flatMap((page) => page.workflow_runs).filter((run) => run.head_branch === tag);
  if (releaseRuns.length !== 1 || releaseRuns[0].id !== source.id) throw new Error("Unpublished recovery requires exactly one original tag run");
  const jobs = api(`actions/runs/${runId}/attempts/${source.run_attempt}/jobs?per_page=100`).data;
  const ref = api(`git/ref/tags/${tag}`);
  if (ref.status === 200) {
    if (ref.data.object.type !== "tag" || api(`git/tags/${ref.data.object.sha}`).data.object.sha !== commit) {
      throw new Error("Existing tag differs from the active annotated identity");
    }
  }
  if (requireTagAbsent && ref.status !== 404) throw new Error("Maintainer must remove the audited unpublished tag before recovery");
  const runs = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp",
    `repos/${repository}/actions/workflows/publish-clawhub.yml/runs?per_page=100`], { encoding: "utf8" }));
  const marketplace = await fetch(`https://clawhub.ai/api/v1/packages/%40thunderclaw%2Fopenclaw-plugin/versions/${tag.slice("openclaw-plugin-v".length)}`,
    { signal: AbortSignal.timeout(15_000) });
  const attestation = api(`attestations/sha256:${state.outputs.qualification.candidateArtifactSha256}`);
  const evidence = {
    repository, tag, commit, qualifiedArtifactSha256: state.outputs.qualification.candidateArtifactSha256,
    run: Object.fromEntries(["id", "run_attempt", "event", "path", "head_sha", "head_branch", "status", "conclusion", "repository"].map((key) =>
      [key, key === "repository" ? { full_name: source.repository?.full_name } : source[key]])),
    jobCount: jobs.total_count,
    githubReleaseAbsent: api(`releases/tags/${tag}`).status === 404,
    attestationsAbsent: attestation.status === 404 || attestation.data.attestations?.length === 0,
    marketplaceVersionAbsent: marketplace.status === 404,
    publisherRunsAbsent: !runs.flatMap((page) => page.workflow_runs).some((run) =>
      run.head_branch === tag || run.display_title?.startsWith(`Publish ClawHub ${tag} (`)),
    tagAbsent: ref.status === 404,
  };
  // Preparation may audit an existing exact tag; application requires its absence.
  authenticateUnpublishedRecovery(state, { ...evidence, tagAbsent: requireTagAbsent ? evidence.tagAbsent : true });
  return { state, stateCommit, evidence, tagObjectSha: ref.status === 200 ? ref.data.object.sha : null };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, runId] = process.argv.slice(2);
    if (!["audit", "apply"].includes(command) || !/^[1-9][0-9]*$/u.test(runId ?? "")) throw new Error("Usage: recover-unpublished-openclaw-tag.mjs <audit|apply> FAILED_RUN_ID");
    if (git(["remote", "get-url", "origin"]) !== "git@github.com:kwatson/thunderclaw.git"
        && git(["remote", "get-url", "origin"]) !== "https://github.com/kwatson/thunderclaw.git") throw new Error("Unexpected repository origin");
    const { state, stateCommit, evidence, tagObjectSha } = await audit(runId, command === "apply");
    if (command === "audit") console.log(JSON.stringify({ stateCommit, evidence, tagObjectSha }, null, 2));
    else {
      git(["fetch", "--no-tags", "origin", stateCommit, "+refs/heads/main:refs/remotes/origin/main"]);
      const baseSha = git(["rev-parse", "HEAD"]);
      if (baseSha !== git(["rev-parse", "origin/main"]) || git(["status", "--porcelain"])) throw new Error("Recovery must run from clean reviewed main");
      const manifest = JSON.parse(readFileSync("packages/openclaw-plugin/package.json", "utf8"));
      if (manifest.version !== state.baseline.current.pluginVersion) throw new Error("Main must restore the last-published product metadata before a fresh reservation");
      const preflight = JSON.parse(execFileSync(process.execPath, ["scripts/preflight-openclaw-upgrade.mjs", "--version", state.identity.version], { encoding: "utf8" }));
      const intent = { format: "thunderclaw-openclaw-autopilot-intent-v1", intentId: `recover-unpublished-${runId}-${state.revision}`,
        expectedRevision: state.revision, type: "recover-unpublished-tag", at: new Date().toISOString(),
        payload: { evidence, preflight, reservationId: randomBytes(16).toString("hex"), baseSha } };
      const { persistReleaseState } = await import("./persist-openclaw-release-state.mjs");
      const { assertOpenClawAutopilotEnabled } = await import("./assert-openclaw-autopilot-enabled.mjs");
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
      const result = await persistReleaseState({ state, intent, expectedCommit: stateCommit,
        message: `Recover unpublished ${evidence.tag} after startup failure ${runId}; all gates require fresh bytes`, token,
        assertEnabled: () => assertOpenClawAutopilotEnabled({ repository, token,
          rolloutEnabled: api("actions/variables/OPENCLAW_AUTOPILOT_ENABLED").data.value }) });
      console.log(JSON.stringify({ decision: result.decision, commit: result.commit, phase: result.state.phase }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
