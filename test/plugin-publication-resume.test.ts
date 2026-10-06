import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyPluginPublicationResume } from "../scripts/verify-plugin-publication-resume.mjs";

function fixture() {
  const repository = "owner/repo";
  const tag = "openclaw-plugin-v1.2.3";
  const commit = "a".repeat(40);
  const runId = 123;
  const bytes = Buffer.from("qualified synthetic archive");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const jobs = ["Select fail-closed release lane", "Validate and build plugin once", "Qualify exact plugin archive",
    "Qualify exact plugin with pinned extension / Protected real-agent pair qualification", "Create plugin GitHub release"]
    .map((name) => ({ name, status: "completed", conclusion: "success" }));
  return { repository, tag, commit, runId, bytes, jobs,
    run: { id: runId, repository: { full_name: repository }, event: "push", path: ".github/workflows/release-openclaw-plugin.yml",
      head_sha: commit, head_branch: tag, status: "completed", conclusion: "failure" },
    state: { phase: "tagged", outputs: { preparation: { tag }, merge: { mergeSha: commit },
      qualification: { candidateArtifactSha256: sha256 } } },
    provenance: { format: "thunderclaw-release-provenance-v2", component: "openclaw-plugin",
      source: { repository: `https://github.com/${repository}`, tag, commit },
      build: { workflow: `${repository}/.github/workflows/release-openclaw-plugin.yml@refs/tags/${tag}`,
        run: `https://github.com/${repository}/actions/runs/${runId}`, attempt: 1 },
      artifacts: [{ name: "thunderclaw-openclaw-plugin-1.2.3.tgz", sha256, size: bytes.length }] } };
}

test("publication resumes failed downstream jobs after every product gate passed, without rebuilding", () => {
  const input = fixture();
  assert.equal(verifyPluginPublicationResume(input).sha256, input.provenance.artifacts[0].sha256);
  input.state.phase = "complete";
  assert.equal(verifyPluginPublicationResume(input).size, input.bytes.length);
});

test("publication resume rejects missing, failed, running, or ambiguous qualification gates", () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    const input = fixture(); input.jobs[3].conclusion = conclusion;
    assert.throws(() => verifyPluginPublicationResume(input), /Required release gate/u);
  }
  const running = fixture(); running.jobs[3].status = "in_progress";
  assert.throws(() => verifyPluginPublicationResume(running), /Required release gate/u);
  const missing = fixture(); missing.jobs.splice(3, 1);
  assert.throws(() => verifyPluginPublicationResume(missing), /Required release gate/u);
  const duplicate = fixture(); duplicate.jobs.push(duplicate.jobs[3]);
  assert.throws(() => verifyPluginPublicationResume(duplicate), /Required release gate/u);
});

test("publication resume binds original run, protected tag, reservation, provenance and qualified bytes", () => {
  const mutations: Array<(input: ReturnType<typeof fixture>) => void> = [
    (input) => { input.run.event = "workflow_dispatch"; },
    (input) => { input.run.repository.full_name = "other/repo"; },
    (input) => { input.run.head_sha = "b".repeat(40); },
    (input) => { input.run.head_branch = "main"; },
    (input) => { input.run.path = ".github/workflows/ci.yml"; },
    (input) => { input.state.outputs.preparation.tag = "openclaw-plugin-v1.2.4"; },
    (input) => { input.state.outputs.merge.mergeSha = "b".repeat(40); },
    (input) => { input.state.phase = "blocked"; },
    (input) => { input.provenance.source.commit = "b".repeat(40); },
    (input) => { input.provenance.build.run = "https://github.com/owner/repo/actions/runs/124"; },
    (input) => { input.provenance.artifacts[0].size += 1; },
    (input) => { input.bytes = Buffer.from("unqualified replacement archive"); },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    assert.throws(() => verifyPluginPublicationResume(input));
  }
});
