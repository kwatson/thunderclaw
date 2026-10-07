import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyClawHubRelease } from "./verify-marketplace-notes.mjs";
import { verifyPluginPublicationResume } from "./verify-plugin-publication-resume.mjs";

// Exercises production evidence admission and HTTP verification together. The
// only network destination is a server we bind ourselves on the loopback host.
export async function rehearseReleaseOperations() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-release-operations-"));
  const bytes = Buffer.from("synthetic qualified plugin archive; no product package");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const repository = "synthetic/thunderclaw";
  const tag = "openclaw-plugin-v1.2.3";
  const commit = "a".repeat(40);
  const notes = "Synthetic compatibility release.\n";
  const artifact = path.join(directory, "synthetic.tgz");
  const notesFile = path.join(directory, "notes.md");
  const evidence = {
    repository, tag, commit, runId: 123, bytes,
    run: { id: 123, repository: { full_name: repository }, event: "push",
      path: ".github/workflows/release-openclaw-plugin.yml", head_sha: commit, head_branch: tag,
      status: "completed", conclusion: "failure" },
    jobs: ["Select fail-closed release lane", "Validate and build plugin once", "Qualify exact plugin archive",
      "Qualify exact plugin with pinned extension / Protected real-agent pair qualification", "Create plugin GitHub release"]
      .map((name) => ({ name, status: "completed", conclusion: "success" })),
    state: { phase: "tagged", outputs: { preparation: { tag }, merge: { mergeSha: commit },
      qualification: { candidateArtifactSha256: sha256 } } },
    provenance: { format: "thunderclaw-release-provenance-v2", component: "openclaw-plugin",
      source: { repository: `https://github.com/${repository}`, tag, commit },
      build: { workflow: `${repository}/.github/workflows/release-openclaw-plugin.yml@refs/tags/${tag}`,
        run: `https://github.com/${repository}/actions/runs/123`, attempt: 1 },
      artifacts: [{ name: "thunderclaw-openclaw-plugin-1.2.3.tgz", sha256, size: bytes.length }] },
  };
  const payload = { package: { name: "@thunderclaw/openclaw-plugin" }, version: { version: "1.2.3", changelog: notes,
    artifact: { sha256, size: bytes.length }, verification: { sourceRepo: repository,
      sourceTag: `refs/tags/${tag}`, sourceCommit: commit, scanStatus: "clean" } } };
  let mode = "pending-then-published";
  let reads = 0;
  let mutations = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET") { mutations += 1; response.writeHead(405).end(); return; }
    reads += 1;
    if (mode === "pending" || (mode === "pending-then-published" && reads === 1)) {
      response.writeHead(404).end(); return;
    }
    const base = "/api/v1/packages/%40thunderclaw%2Fopenclaw-plugin/versions/1.2.3";
    if (request.url === `${base}/artifact/download`) {
      response.writeHead(200, { "content-type": "application/octet-stream" })
        .end(mode === "tampered-download" ? Buffer.from("different archive") : bytes);
      return;
    }
    if (request.url !== base) { response.writeHead(404).end(); return; }
    const publicVersion = structuredClone(payload);
    if (mode === "wrong-source") publicVersion.version.verification.sourceTag = "refs/heads/main";
    if (mode === "unclean-scan") publicVersion.version.verification.scanStatus = "rejected";
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(publicVersion));
  });
  try {
    await writeFile(artifact, bytes);
    await writeFile(notesFile, notes);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const options = { packageName: payload.package.name, version: "1.2.3", artifact, notesFile,
      repository, tag, commit, apiBase: `http://127.0.0.1:${address.port}`, pollIntervalMs: 1, timeoutMs: 2_000 };
    const admitted = verifyPluginPublicationResume(evidence);
    assert.equal(admitted.sha256, sha256);
    const verified = await verifyClawHubRelease(options);
    assert.equal(verified.artifactVerified, true);
    assert.equal(verified.sourceVerified, true);
    assert.ok(reads >= 3, "pending submission must be polled before verification completes");
    const cases = ["accepted-pending-then-verified"];
    for (const [scenario, error] of [
      ["pending", /HTTP 404/u], ["tampered-download", /served artifact bytes/u],
      ["wrong-source", /public source/u], ["unclean-scan", /source or scan state/u],
    ]) {
      mode = scenario;
      await assert.rejects(verifyClawHubRelease({ ...options, timeoutMs: 0 }), error);
      cases.push(scenario);
    }
    for (const conclusion of ["cancelled", "failure", "skipped"]) {
      const rejected = structuredClone(evidence);
      rejected.jobs[3].conclusion = conclusion;
      const before = reads;
      assert.throws(() => verifyPluginPublicationResume(rejected), /Required release gate/u);
      assert.equal(reads, before, "invalid qualification must not reach publication verification");
      cases.push(`qualification-${conclusion}`);
    }
    assert.equal(mutations, 0);
    return { format: "thunderclaw-release-operations-rehearsal-v1", cases,
      networkScope: "loopback-only", externalMutations: mutations,
      productArtifactsBuilt: 0, productTagsCreated: 0, secretsRequired: false };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await rehearseReleaseOperations(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
