import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const shaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const requestPattern = /^[a-f0-9]{32}$/u;
const versionPattern = /^\d{4}\.\d{1,2}\.\d+$/u;
const requiredGates = [
  "deterministic",
  "openclaw-integration",
  "pair-qualification",
  "thunderbird-linux",
  "native-windows",
  "native-macos",
];

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} must use the strict autopilot result schema`);
  }
}

function canonicalInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new Error(`${label} must be a positive canonical integer`);
  }
  return parsed;
}

export function validateAutopilotQualificationResult(value) {
  exactKeys(value, [
    "format", "repository", "repositoryId", "workflow", "workflowCommit", "workflowSha256", "event",
    "runId", "runAttempt", "requestId", "reservationId", "version", "identitySha256",
    "baseSha", "tag", "candidateArtifactSha256", "candidate", "counterpart", "classification", "automation", "gates", "decision",
  ], "qualification result");
  if (value.format !== "thunderclaw-openclaw-autopilot-result-v1"
      || typeof value.repository !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(value.repository)
      || !Number.isSafeInteger(value.repositoryId) || value.repositoryId < 1
      || value.workflow !== ".github/workflows/qualify-openclaw-autopilot.yml"
      || !shaPattern.test(value.workflowCommit)
      || !sha256Pattern.test(value.workflowSha256)
      || value.event !== "workflow_dispatch"
      || !Number.isSafeInteger(value.runId) || value.runId < 1
      || !Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1
      || !requestPattern.test(value.requestId)
      || !requestPattern.test(value.reservationId)
      || !versionPattern.test(value.version)
      || !sha256Pattern.test(value.identitySha256)
      || !shaPattern.test(value.baseSha)
      || !sha256Pattern.test(value.candidateArtifactSha256)
      || !/^openclaw-plugin-v\d+\.\d+\.\d+$/u.test(value.tag)) {
    throw new Error("qualification result identity is malformed");
  }
  exactKeys(value.candidate, ["ref", "sha", "tree"], "candidate identity");
  if (typeof value.candidate.ref !== "string" || !/^automation\/openclaw-\d{4}\.\d{1,2}\.\d+$/u.test(value.candidate.ref)
      || !shaPattern.test(value.candidate.sha) || !shaPattern.test(value.candidate.tree)) {
    throw new Error("qualification candidate identity is malformed");
  }
  exactKeys(value.counterpart, ["repository", "tag", "name", "sha256", "size"], "counterpart identity");
  if (value.counterpart.repository !== value.repository || typeof value.counterpart.tag !== "string"
      || typeof value.counterpart.name !== "string" || !sha256Pattern.test(value.counterpart.sha256)
      || !Number.isSafeInteger(value.counterpart.size) || value.counterpart.size < 1) {
    throw new Error("qualification counterpart identity is malformed");
  }
  exactKeys(value.classification, ["decision", "evidenceSha256"], "classification evidence");
  if (value.classification.decision !== "compatibility-only" || !sha256Pattern.test(value.classification.evidenceSha256)) {
    throw new Error("qualification classification is not an exact compatibility-only decision");
  }
  exactKeys(value.automation, ["controllerWorkflowSha", "qualificationWorkflowSha", "releaseWorkflowSha", "classifierSha"], "automation identity");
  if (Object.values(value.automation).some((digest) => typeof digest !== "string" || !sha256Pattern.test(digest))) {
    throw new Error("qualification automation identity is malformed");
  }
  exactKeys(value.gates, requiredGates, "qualification gates");
  if (Object.values(value.gates).some((result) => result !== "success")) {
    throw new Error("every ThunderClaw qualification gate must succeed without skips or waivers");
  }
  if (value.decision !== "pass") throw new Error("qualification decision must be pass");
  return value;
}

export function verifyAutopilotQualificationResult(value, expected) {
  const result = validateAutopilotQualificationResult(value);
  const comparisons = {
    repository: result.repository,
    repositoryId: String(result.repositoryId),
    workflowCommit: result.workflowCommit,
    workflowSha256: result.workflowSha256,
    runId: String(result.runId),
    runAttempt: String(result.runAttempt),
    requestId: result.requestId,
    reservationId: result.reservationId,
    version: result.version,
    identitySha256: result.identitySha256,
    baseSha: result.baseSha,
    tag: result.tag,
    candidateArtifactSha256: result.candidateArtifactSha256,
    candidateRef: result.candidate.ref,
    candidateSha: result.candidate.sha,
    candidateTree: result.candidate.tree,
    counterpartRepository: result.counterpart.repository,
    counterpartTag: result.counterpart.tag,
    counterpartName: result.counterpart.name,
    counterpartSha256: result.counterpart.sha256,
    counterpartSize: String(result.counterpart.size),
    classificationSha256: result.classification.evidenceSha256,
    controllerWorkflowSha256: result.automation.controllerWorkflowSha,
    qualificationWorkflowSha256: result.automation.qualificationWorkflowSha,
    releaseWorkflowSha256: result.automation.releaseWorkflowSha,
    classifierSha256: result.automation.classifierSha,
  };
  for (const [name, actual] of Object.entries(comparisons)) {
    if (expected[name] !== undefined && String(expected[name]) !== actual) {
      throw new Error(`qualification result ${name} does not match the reserved value`);
    }
  }
  return result;
}

function parseArguments(args) {
  const keys = new Set([
    "file", "repository", "repository-id", "workflow-commit", "workflow-sha256", "run-id", "run-attempt",
    "request-id", "reservation-id", "version", "identity-sha256", "base-sha", "tag", "candidate-artifact-sha256", "candidate-ref", "candidate-sha",
    "candidate-tree", "counterpart-repository", "counterpart-tag", "counterpart-name",
    "counterpart-sha256", "counterpart-size", "classification-sha256", "controller-workflow-sha256",
    "qualification-workflow-sha256", "release-workflow-sha256", "classifier-sha256",
  ]);
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith("--") || !keys.has(option.slice(2)) || value === undefined || parsed[option.slice(2)] !== undefined) {
      throw new Error("Invalid autopilot result verification arguments");
    }
    parsed[option.slice(2)] = value;
  }
  if ([...keys].some((key) => parsed[key] === undefined)) {
    throw new Error("All autopilot result verification arguments are required");
  }
  return {
    file: parsed.file,
    expected: {
      repository: parsed.repository,
      repositoryId: String(canonicalInteger(parsed["repository-id"], "repository-id")),
      workflowCommit: parsed["workflow-commit"],
      workflowSha256: parsed["workflow-sha256"],
      runId: String(canonicalInteger(parsed["run-id"], "run-id")),
      runAttempt: String(canonicalInteger(parsed["run-attempt"], "run-attempt")),
      requestId: parsed["request-id"],
      reservationId: parsed["reservation-id"],
      version: parsed.version,
      identitySha256: parsed["identity-sha256"],
      baseSha: parsed["base-sha"],
      tag: parsed.tag,
      candidateArtifactSha256: parsed["candidate-artifact-sha256"],
      candidateRef: parsed["candidate-ref"],
      candidateSha: parsed["candidate-sha"],
      candidateTree: parsed["candidate-tree"],
      counterpartRepository: parsed["counterpart-repository"],
      counterpartTag: parsed["counterpart-tag"],
      counterpartName: parsed["counterpart-name"],
      counterpartSha256: parsed["counterpart-sha256"],
      counterpartSize: String(canonicalInteger(parsed["counterpart-size"], "counterpart-size")),
      classificationSha256: parsed["classification-sha256"],
      controllerWorkflowSha256: parsed["controller-workflow-sha256"],
      qualificationWorkflowSha256: parsed["qualification-workflow-sha256"],
      releaseWorkflowSha256: parsed["release-workflow-sha256"],
      classifierSha256: parsed["classifier-sha256"],
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { file, expected } = parseArguments(process.argv.slice(2));
    const result = verifyAutopilotQualificationResult(JSON.parse(await readFile(file, "utf8")), expected);
    process.stdout.write(`${JSON.stringify({ decision: result.decision, runId: result.runId, runAttempt: result.runAttempt })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
