import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile, mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runBlocks(workflow: string): string[] {
  const lines = workflow.split("\n");
  const blocks: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)run: \|\s*$/u.exec(line);
    if (!match) continue;
    const keyIndent = match[1].length;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const indentation = /^(\s*)/u.exec(lines[cursor])?.[1].length ?? 0;
      if (lines[cursor].trim() && indentation <= keyIndent) break;
      body.push(lines[cursor].slice(Math.min(lines[cursor].length, keyIndent + 2)));
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function verifyPinnedActionsAndShell(workflow: string, name: string) {
  for (const reference of workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/gu)) {
    assert.match(reference[1], /^[a-f0-9]{40}$/u, `${name} action is not pinned: ${reference[0]}`);
  }
  for (const script of runBlocks(workflow)) {
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, `${name} contains invalid shell:\n${result.stderr}`);
  }
}

test("qualification cleanup keeps Compose configuration until shutdown and always removes credentials", async () => {
  const workflow = await readFile(new URL("../.github/workflows/qualify-openclaw-autopilot.yml", import.meta.url), "utf8");
  const cleanup = runBlocks(workflow).find((script) => script.includes("docker compose -f compose.spike.yaml down"));
  assert.ok(cleanup);
  const directory = await mkdtemp(join(tmpdir(), "thunderclaw-cleanup-"));
  try {
    await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "bin/docker"), '#!/bin/bash\ntest -f .env.openclaw.local || exit 42\nexit "${FAKE_DOCKER_EXIT:-0}"\n', { mode: 0o755 });
    for (const exit of [0, 9]) {
      await writeFile(join(directory, ".env.openclaw.local"), "SYNTHETIC_TEST_VALUE=placeholder\n");
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-o", "pipefail", "-c", cleanup], {
        cwd: directory, encoding: "utf8",
        env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, FAKE_DOCKER_EXIT: String(exit) },
      });
      assert.equal(result.status, exit, result.stderr);
      await assert.rejects(stat(join(directory, ".env.openclaw.local")), { code: "ENOENT" });
    }
    const absent = spawnSync("bash", ["-e", "-c", cleanup], { cwd: directory, encoding: "utf8" });
    assert.equal(absent.status, 0, absent.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("autopilot qualification checks out only an explicit candidate and exposes only its dedicated provider secret", async () => {
  const workflow = await readFile(new URL("../.github/workflows/qualify-openclaw-autopilot.yml", import.meta.url), "utf8");
  assert.match(workflow, /source_ref:[\s\S]*source_sha:[\s\S]*source_tree:/u);
  const checkoutCount = [...workflow.matchAll(/uses: actions\/checkout@/gu)].length;
  const explicitCheckoutCount = [...workflow.matchAll(/uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: \$\{\{ inputs\.source_sha \}\}[\s\S]*?persist-credentials: false/gu)].length;
  assert.equal(explicitCheckoutCount, checkoutCount);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/u);
  assert.match(workflow, /test "\$actual_tree" = "\$EXPECTED_TREE"/u);
  assert.match(workflow, /git show "refs\/remotes\/origin\/openclaw-autopilot-state:state\.json"/u);
  assert.match(workflow, /\.outputs\.qualificationDispatch\.requestId == \$requestId/u);
  assert.match(workflow, /CANDIDATE_ARTIFACT_SHA256: \$\{\{ needs\.deterministic\.outputs\.candidate_artifact_sha256 \}\}/u);
  assert.match(workflow, /environment:\n\s+name: openclaw-autopilot-qualification/u);
  assert.match(workflow, /DEEPSEEK_API_KEY: \$\{\{ secrets\.DEEPSEEK_API_KEY \}\}/u);
  assert.match(workflow, /gateway_token=\$\(openssl rand -hex 32\)/u);
  assert.doesNotMatch(workflow, /secrets\.(?:OPENCLAW_GATEWAY_TOKEN|CLAWHUB_TOKEN|AUTOPILOT_APP_PRIVATE_KEY)/u);
  assert.match(workflow, /permissions:\n\s+contents: read/u);
  verifyPinnedActionsAndShell(workflow, "qualify-openclaw-autopilot.yml");
});

test("autopilot qualification result binds exact run, attempt, tree, counterpart, and unwaived gates", async () => {
  const workflow = await readFile(new URL("../.github/workflows/qualify-openclaw-autopilot.yml", import.meta.url), "utf8");
  for (const binding of [
    "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
    "SOURCE_REF", "SOURCE_SHA", "SOURCE_TREE", "COUNTERPART_TAG", "COUNTERPART_NAME",
    "COUNTERPART_SHA256", "COUNTERPART_SIZE",
  ]) assert.match(workflow, new RegExp(`\\$${binding}`, "u"));
  assert.match(workflow, /for result in "\$BIND_SOURCE"[\s\S]*test "\$result" = success/u);
  assert.match(workflow, /"native-windows":"success","native-macos":"success"/u);
  assert.match(workflow, /sha256sum \.github\/workflows\/release-openclaw-plugin\.yml \.github\/workflows\/publish-clawhub\.yml/u);
  assert.doesNotMatch(workflow, /continue-on-error:|allow-failure/iu);
  assert.match(workflow, /openclaw-autopilot-result-\$\{\{ inputs\.request_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  const resultJob = workflow.slice(workflow.indexOf("\n  result:\n"));
  assert.match(resultJob, /ref: \$\{\{ inputs\.source_sha \}\}/u);
  assert.ok(resultJob.indexOf("uses: actions/checkout@") < resultJob.indexOf("mise exec --"));
  assert.ok(resultJob.indexOf("uses: jdx/mise-action@") >= 0
    && resultJob.indexOf("uses: jdx/mise-action@") < resultJob.indexOf("mise exec --"),
  "the separate evidence job must install managed runtimes before validation");
});

test("autopilot controller is a short trusted-main state machine with isolated mutations", async () => {
  const workflow = await readFile(new URL("../.github/workflows/openclaw-autopilot.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:\n\s+- cron: "[^\n]+"/u);
  assert.match(workflow, /workflow_dispatch:[\s\S]*version:/u);
  assert.match(workflow, /expedite_soak:[\s\S]*type: boolean/u);
  assert.match(workflow, /EXPEDITE_SOAK: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.expedite_soak \|\| false \}\}/u);
  assert.match(workflow, /"\$EXPEDITE_SOAK" == true[\s\S]*-n "\$old_state_commit"[\s\S]*\.phase "\$work\/next\.json"\)" == observed/u);
  assert.match(workflow, /soak_waived=\$\(jq -r 'any\(\.history\[\]; \.type == "waive-soak" and \.to == "ready"\)'/u);
  assert.match(workflow, /--soak-waived "\$soak_waived"/u);
  assert.match(workflow, /reservation_id=\$\(jq -r \.reservationId "\$work\/state\.json"\)[\s\S]*branch="automation\/openclaw-\$VERSION-\$\{reservation_id:0:8\}"/u);
  assert.match(workflow, /workflow_run:[\s\S]*Qualify OpenClaw autopilot candidate/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /refs\/heads\/automation\/openclaw-autopilot-state/u);
  assert.match(workflow, /git (?:update-ref|[^\n]* push origin)/u);
  assert.match(workflow, /--force-with-lease/u);
  assert.match(workflow, /OPENCLAW_AUTOPILOT_ENABLED/u);
  assert.match(workflow, /assert-openclaw-autopilot-enabled\.mjs/u);
  assert.match(workflow, /find_run\(\)[\s\S]*Exact qualification dispatch already exists[\s\S]*dispatch_status=\$\?/u);
  assert.match(workflow, /classify-openclaw-qualification-failure\.mjs[\s\S]*record-qualification-failure/u);
  assert.match(workflow, /retry_pre_gate_failure:[\s\S]*recover-qualification-automation/u);
  assert.match(workflow, /verify-openclaw-foundation\.mjs[\s\S]*--closeout-state[\s\S]*Roll over reviewed OpenClaw foundation state/u);
  assert.match(workflow, /== qualifying \|\|[\s\S]*== qualified \|\|[\s\S]*== merged/u);
  assert.match(workflow, /gh run rerun[\s\S]*--failed/u);
  assert.match(workflow, /gh pr merge[\s\S]*--auto --squash --match-head-commit/u);
  assert.match(workflow, /actions\/create-github-app-token@[a-f0-9]{40}/u);
  assert.equal((workflow.match(/uses: actions\/create-github-app-token@/gu) ?? []).length,
    (workflow.match(/permission-actions: (?:read|write)/gu) ?? []).length,
    "every App token that can mutate must also be able to re-read the live guard");
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/git\/tags/u);
  assert.match(workflow, /ref="refs\/tags\/\$tag"/u);
  assert.ok((workflow.match(/assert-openclaw-autopilot-enabled\.mjs/gu) ?? []).length >= 16,
    "each controller mutation must re-read the live controller workflow");
  assert.doesNotMatch(workflow, /sleep\s+(?:[6-9]\d|[1-9]\d{2,})/u);

  const mutationJobs = [...workflow.matchAll(/^  (prepare|merge-and-tag):\n([\s\S]*?)(?=^  [a-z][a-z-]+:\n|(?![\s\S]))/gmu)];
  assert.equal(mutationJobs.length, 2);
  for (const [, name, job] of mutationJobs) {
    assert.match(job, /AUTOPILOT_APP_PRIVATE_KEY/u, `${name} must use the narrow App`);
    assert.doesNotMatch(job, /DEEPSEEK_API_KEY|CLAWHUB_TOKEN|npm test|npm run|scripts\/bootstrap-spike/u);
    assert.match(job, /persist-credentials: false/u);
  }
  verifyPinnedActionsAndShell(workflow, "openclaw-autopilot.yml");
});

test("merged counterpart closeout completes only the exact durable reservation", async () => {
  const workflow = await readFile(new URL("../.github/workflows/complete-openclaw-autopilot-closeout.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:\n\s+types: \[closed\]/u);
  assert.match(workflow, /github\.event\.pull_request\.merged == true/u);
  assert.match(workflow, /ref: main/u);
  assert.match(workflow, /refs\/heads\/automation\/openclaw-autopilot-state/u);
  assert.match(workflow, /\.outputs\.closeout/u);
  assert.match(workflow, /complete-closeout/u);
  assert.match(workflow, /--force-with-lease/u);
  assert.match(workflow, /openclaw-autopilot-mutation/u);
  assert.match(workflow, /vars\.OPENCLAW_AUTOPILOT_ENABLED == 'true'/u);
  assert.match(workflow, /assert-openclaw-autopilot-enabled\.mjs/u);
  assert.match(workflow, /permission-actions: read/u);
  verifyPinnedActionsAndShell(workflow, "complete-openclaw-autopilot-closeout.yml");
});

test("every automatic mutation workflow carries explicit rollout admission to the live guard", async () => {
  for (const filename of ["openclaw-autopilot.yml", "release-openclaw-plugin.yml", "publish-clawhub.yml", "complete-openclaw-autopilot-closeout.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8");
    assert.match(workflow, /^env:\n  OPENCLAW_AUTOPILOT_ENABLED: \$\{\{ vars\.OPENCLAW_AUTOPILOT_ENABLED \}\}/mu, filename);
  }
});
