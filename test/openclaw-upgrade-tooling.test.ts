import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import {
  evaluateReleaseTag,
  selectLinuxAmd64Digest,
  summarizeSdkExports,
  summarizeUpstreamCi,
} from "../scripts/preflight-openclaw-upgrade.mjs";
import { sha512Integrity } from "../scripts/stage-openclaw-provider.mjs";

test("OpenClaw qualification manifest agrees with every active repository pin", async () => {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const qualification = JSON.parse(await readFile(new URL("../openclaw-qualification.json", import.meta.url), "utf8"));
  const result = await verifyOpenClawQualification({ root });
  assert.equal(result.stableVersion, qualification.stableVersion);
  assert.equal(result.supportedRange, qualification.supportedRange);
  assert.ok(result.checkedFiles >= 15);
});

test("OpenClaw qualification validation rejects range and identity drift", async () => {
  const manifest = JSON.parse(await readFile(new URL("../openclaw-qualification.json", import.meta.url), "utf8"));
  assert.throws(() => validateOpenClawQualification({ ...manifest, supportedRange: ">=2026.7.2-beta.7" }),
    /supported range must be/u);
  assert.throws(() => validateOpenClawQualification({
    ...manifest,
    supportedRange: `${manifest.supportedRange.replace(manifest.nextReleaseFloor, "2026.9.7-0")}`,
    nextReleaseFloor: "2026.9.7-0",
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

test("OpenClaw preflight selects the exact linux/amd64 image and required SDK exports", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(selectLinuxAmd64Digest({ manifests: [
    { digest, platform: { os: "linux", architecture: "amd64" } },
    { digest: `sha256:${"b".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } },
  ] }), digest);
  assert.throws(() => selectLinuxAmd64Digest({ manifests: [] }), /exactly one linux\/amd64/u);

  const exports = Object.fromEntries([
    "./plugin-sdk/agent-runtime",
    "./plugin-sdk/cli-argv",
    "./plugin-sdk/gateway-runtime",
    "./plugin-sdk/plugin-entry",
  ].map((entrypoint) => [entrypoint, "./file.js"]));
  assert.deepEqual(summarizeSdkExports({ exports }).missingEntrypoints, []);
  assert.deepEqual(summarizeSdkExports({ exports: { ...exports, "./plugin-sdk/plugin-entry": undefined } }).missingEntrypoints,
    ["./plugin-sdk/plugin-entry"]);
  delete exports["./plugin-sdk/plugin-entry"];
  assert.deepEqual(summarizeSdkExports({ exports }).missingEntrypoints, ["./plugin-sdk/plugin-entry"]);
});

test("OpenClaw preflight attributes verification only to the release tag itself", () => {
  const releaseTagSha = "a".repeat(40);
  const commit = "b".repeat(40);
  assert.deepEqual(evaluateReleaseTag({ type: "tag", sha: releaseTagSha }, {
    sha: releaseTagSha,
    object: { type: "commit", sha: commit },
    verification: { verified: true },
  }), { commit, verifiedTag: true, tagKind: "annotated" });
  assert.deepEqual(evaluateReleaseTag({ type: "commit", sha: commit }, undefined), {
    commit, verifiedTag: false, tagKind: "lightweight",
  });
  assert.throws(() => evaluateReleaseTag({ type: "tag", sha: releaseTagSha }, {
    sha: releaseTagSha,
    object: { type: "tag", sha: "c".repeat(40) },
    verification: { verified: false },
  }), /pointing directly to a commit/u);
});

test("OpenClaw preflight records official upstream waivers as advisory evidence", () => {
  assert.deepEqual(summarizeUpstreamCi("Stable soak waived by operator; waived lanes: soak-only."), {
    conclusion: "waived in official release evidence",
    waived: true,
  });
  assert.deepEqual(summarizeUpstreamCi("Operator lane waiver approved for non-proof CI."), {
    conclusion: "waived in official release evidence",
    waived: true,
  });
  assert.equal(summarizeUpstreamCi("All required release lanes completed."), undefined);
});

test("provider staging computes canonical SHA-512 subresource integrity", () => {
  assert.equal(sha512Integrity(Buffer.from("ThunderClaw", "utf8")),
    "sha512-SIyVC0pmzEQSUIh5nrVUK+2VYiZTZAc0vx3TD7hxn5xy8QA5uCJUFgrK7+E21TR/Tj3uSPWhyUGXQFdY5Xy69A==");
});
