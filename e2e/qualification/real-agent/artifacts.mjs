import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function createQualificationArtifacts(repositoryRoot, runId) {
  const parent = join(repositoryRoot, "build/e2e/product-real-agent/153.0.3");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const artifacts = join(parent, runId);
  await mkdir(artifacts, { recursive: false, mode: 0o700 });
  return artifacts;
}
