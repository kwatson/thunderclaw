import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureOne,
  forbidPattern,
  validateOpenClawQualification,
  verifyDigestPinningSources,
  verifyOpenClawQualification,
} from "../scripts/openclaw-qualification.mjs";
import { sha512Integrity } from "../scripts/stage-openclaw-provider.mjs";

test("retained OpenClaw qualification validates immutable local runtime pins", async (context) => {
  const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const root = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-legacy-qualification-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const qualification = JSON.parse(await readFile(new URL("../openclaw-qualification.json", import.meta.url), "utf8"));
  const files = ["openclaw-qualification.json", "package.json", "package-lock.json", "packages/openclaw-plugin/package.json", "compose.spike.yaml", "scripts/run-openclaw-ci.sh", "scripts/bootstrap-spike.sh", "scripts/qualify-pairing.ts", "e2e/qualification/real-agent/run.mjs", "packages/openclaw-plugin/src/compatibility-fingerprint.ts", "scripts/stage-openclaw-provider.mjs", "packages/openclaw-plugin/src/openclaw-agent-sessions.d.ts"];
  const contents: Record<string, string> = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(path.join(repositoryRoot, file), "utf8")] as const)));
  for (const [file, text] of Object.entries(contents)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  const result = await verifyOpenClawQualification({ root });
  assert.equal(result.stableVersion, qualification.stableVersion);
  assert.equal(result.supportedRange, qualification.supportedRange);
  assert.ok(result.checkedFiles >= files.length);
  await writeFile(path.join(root, "compose.spike.yaml"), contents["compose.spike.yaml"].replace(qualification.image.linuxAmd64Digest, `sha256:${"0".repeat(64)}`));
  await assert.rejects(verifyOpenClawQualification({ root }), /active qualification value/u);
});

test("OpenClaw qualification validation rejects range and identity drift", async () => {
  const manifest = JSON.parse(await readFile(new URL("../openclaw-qualification.json", import.meta.url), "utf8"));
  const stableParts = manifest.stableVersion.split(".").map(Number);
  const invalidNextReleaseFloor = `${stableParts[0]}.${stableParts[1]}.${stableParts[2] + 2}-0`;
  assert.throws(() => validateOpenClawQualification({ ...manifest, supportedRange: ">=2026.7.2-beta.7" }),
    /supported range must be/u);
  assert.throws(() => validateOpenClawQualification({
    ...manifest,
    supportedRange: `${manifest.supportedRange.replace(manifest.nextReleaseFloor, invalidNextReleaseFloor)}`,
    nextReleaseFloor: invalidNextReleaseFloor,
  }), /next release floor must be/u);
  assert.throws(() => validateOpenClawQualification({ ...manifest, upstream: { ...manifest.upstream, releaseTag: "vwrong" } }),
    /upstream qualification is malformed/u);

  const root = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-openclaw-manifest-test-"));
  await writeFile(path.join(root, "openclaw-qualification.json"), `${JSON.stringify({ ...manifest, format: "unknown" })}\n`);
  await assert.rejects(verifyOpenClawQualification({ root }), /strict v1 schema/u);
});

test("OpenClaw drift checks reject stale active pins hidden by expected comments", () => {
  assert.throws(() => captureOne("fixture.yml", "  image: example:old\n  # image: example:new\n",
    /^\s+image: (\S+)\s*$/gmu, "example:new"), /active qualification value/u);
  assert.throws(() => forbidPattern("fixture.sh", "# old registry pin example:2026.1.1\n",
    /example:\d{4}\./u, "image version"), /retains a hard-coded image version/u);
});

test("OpenClaw drift checks require immutable digest use in protected qualification paths", () => {
  const digestExpression = "+ `@${openClawQualification.image.linuxAmd64Digest}`;";
  const repoDigestExpression = "`${openClawQualification.image.repository}@${openClawQualification.image.linuxAmd64Digest}`";
  const repoDigestAssertion = "parsedGatewayRepoDigests.includes(qualifiedGatewayRepoDigest)";
  assert.doesNotThrow(() => verifyDigestPinningSources({
    pairing: digestExpression,
    realAgent: `${digestExpression}\n${repoDigestExpression}\n${repoDigestAssertion}`,
  }));
  assert.throws(() => verifyDigestPinningSources({
    pairing: "const qualifiedGatewayImage = openClawQualification.image.repository;",
    realAgent: `${digestExpression}\n${repoDigestExpression}\n${repoDigestAssertion}`,
  }), /qualify-pairing\.ts does not contain/u);
  assert.throws(() => verifyDigestPinningSources({
    pairing: digestExpression,
    realAgent: `${digestExpression}\n${repoDigestExpression}`,
  }), /run\.mjs does not contain/u);
});

test("provider staging computes canonical SHA-512 subresource integrity", () => {
  assert.equal(sha512Integrity(Buffer.from("ThunderClaw", "utf8")),
    "sha512-SIyVC0pmzEQSUIh5nrVUK+2VYiZTZAc0vx3TD7hxn5xy8QA5uCJUFgrK7+E21TR/Tj3uSPWhyUGXQFdY5Xy69A==");
});
