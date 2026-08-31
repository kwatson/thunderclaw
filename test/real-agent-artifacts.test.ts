import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQualificationArtifacts } from "../e2e/qualification/real-agent/artifacts.mjs";

test("real-agent evidence starts in a genuinely fresh workspace and rejects run collisions", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "thunderclaw-real-agent-artifacts-"));
  const runId = "qualification-fresh-state-test";
  try {
    const artifacts = await createQualificationArtifacts(repositoryRoot, runId);
    assert.equal(
      artifacts,
      join(repositoryRoot, "build/e2e/product-real-agent/153.0.3", runId),
    );
    assert.equal((await stat(artifacts)).isDirectory(), true);
    await assert.rejects(createQualificationArtifacts(repositoryRoot, runId), { code: "EEXIST" });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
