import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const QUALIFICATION_FAILURE_FORMAT = "thunderclaw-openclaw-qualification-failure-v1";
const sha40 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const conclusions = new Set(["success", "failure", "cancelled", "timed_out", "action_required", "skipped"]);
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function requirePattern(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is malformed`);
}

function normalizedConclusion(job, name) {
  if (!job || typeof job !== "object" || job.status !== "completed" || !conclusions.has(job.conclusion)) {
    throw new Error(`qualification job ${name} has no terminal conclusion`);
  }
  return job.conclusion;
}

function oneJob(jobs, predicate, name) {
  const matches = jobs.filter(predicate);
  if (matches.length !== 1) throw new Error(`qualification jobs do not contain exactly one ${name}`);
  return matches[0];
}

export function validateQualificationFailureEvidence(value) {
  if (!exactKeys(value, ["format", "run", "reservation", "jobs", "classification", "evidenceSha256"])
      || value.format !== QUALIFICATION_FAILURE_FORMAT) throw new Error("qualification failure evidence must use the strict v1 schema");
  if (!exactKeys(value.run, ["id", "attempt", "event", "conclusion", "workflowCommit", "workflowPath"])) throw new Error("qualification failure run evidence is malformed");
  if (!Number.isSafeInteger(value.run.id) || value.run.id < 1 || !Number.isSafeInteger(value.run.attempt) || value.run.attempt < 1
      || value.run.event !== "workflow_dispatch" || !new Set(["failure", "cancelled", "timed_out", "action_required"]).has(value.run.conclusion)) {
    throw new Error("qualification failure run identity is malformed");
  }
  requirePattern(value.run.workflowCommit, sha40, "qualification failure workflowCommit");
  if (value.run.workflowPath !== ".github/workflows/qualify-openclaw-autopilot.yml") throw new Error("qualification failure workflow path is malformed");
  if (!exactKeys(value.reservation, ["reservationId", "identitySha256", "requestId", "candidateSha"])) throw new Error("qualification failure reservation evidence is malformed");
  requirePattern(value.reservation.reservationId, /^[a-f0-9]{32}$/u, "qualification failure reservationId");
  requirePattern(value.reservation.identitySha256, sha256, "qualification failure identitySha256");
  requirePattern(value.reservation.requestId, /^[A-Za-z0-9._:-]{1,128}$/u, "qualification failure requestId");
  requirePattern(value.reservation.candidateSha, sha40, "qualification failure candidateSha");
  const jobKeys = ["binding", "deterministic", "openclawIntegration", "thunderbirdLinux", "nativeWindows", "nativeMacos", "pairQualification", "result"];
  if (!exactKeys(value.jobs, jobKeys) || !Object.values(value.jobs).every((item) => conclusions.has(item))) throw new Error("qualification failure job evidence is malformed");
  if (!exactKeys(value.classification, ["stage", "disposition", "recoverable"])) throw new Error("qualification failure classification is malformed");
  const downstream = jobKeys.filter((name) => !["binding", "result"].includes(name)).map((name) => value.jobs[name]);
  let expected;
  if (value.run.conclusion === "cancelled") expected = { stage: "cancelled", disposition: "cancelled", recoverable: false };
  else if (new Set(["failure", "timed_out"]).has(value.jobs.binding) && downstream.every((result) => result === "skipped")) {
    expected = { stage: "pre-gate", disposition: "retryable", recoverable: true };
  } else expected = { stage: "gate", disposition: "blocked", recoverable: false };
  if (JSON.stringify(value.classification) !== JSON.stringify(expected)) throw new Error("qualification failure disposition does not match job evidence");
  const body = { format: value.format, run: value.run, reservation: value.reservation, jobs: value.jobs, classification: value.classification };
  requirePattern(value.evidenceSha256, sha256, "qualification failure evidenceSha256");
  if (value.evidenceSha256 !== digest(body)) throw new Error("qualification failure evidence digest is invalid");
  return value;
}

export function classifyQualificationFailure({ state, run, jobs: jobsValue }) {
  if (!state?.outputs?.preparation || !state?.outputs?.qualificationDispatch || state.phase !== "qualifying") {
    throw new Error("qualification failure is not bound to an active qualifying reservation");
  }
  const jobs = Array.isArray(jobsValue) ? jobsValue : jobsValue?.jobs;
  if (!Array.isArray(jobs)) throw new Error("qualification jobs response is malformed");
  const dispatch = state.outputs.qualificationDispatch;
  const preparation = state.outputs.preparation;
  const pathValue = typeof run?.path === "string" ? run.path.split("@")[0] : "";
  const runIdentity = {
    id: Number(run?.id), attempt: Number(run?.run_attempt), event: run?.event, conclusion: run?.conclusion,
    workflowCommit: run?.head_sha, workflowPath: pathValue,
  };
  if (!Number.isSafeInteger(runIdentity.id) || runIdentity.id < 1 || !Number.isSafeInteger(runIdentity.attempt) || runIdentity.attempt < 1
      || runIdentity.workflowCommit !== dispatch.workflowCommit || run?.head_branch !== "main") {
    throw new Error("qualification run differs from the active dispatch");
  }
  const binding = oneJob(jobs, (job) => job.name === "Bind immutable source and trusted workflow", "binding job");
  const result = oneJob(jobs, (job) => job.name === "Bind successful qualification result", "result job");
  const native = jobs.filter((job) => /^Native (?:Windows|macOS) qualification$/u.test(job.name));
  const windows = oneJob(native, (job) => job.name === "Native Windows qualification", "native Windows job");
  const macos = oneJob(native, (job) => job.name === "Native macOS qualification", "native macOS job");
  const jobResults = {
    binding: normalizedConclusion(binding, "binding"),
    deterministic: normalizedConclusion(oneJob(jobs, (job) => job.name === "Deterministic tests, types, and packages", "deterministic job"), "deterministic"),
    openclawIntegration: normalizedConclusion(oneJob(jobs, (job) => job.name === "Pinned OpenClaw integration", "OpenClaw integration job"), "OpenClaw integration"),
    thunderbirdLinux: normalizedConclusion(oneJob(jobs, (job) => job.name === "Thunderbird Linux qualification", "Thunderbird Linux job"), "Thunderbird Linux"),
    nativeWindows: normalizedConclusion(windows, "native Windows"),
    nativeMacos: normalizedConclusion(macos, "native macOS"),
    pairQualification: normalizedConclusion(oneJob(jobs, (job) => job.name === "Protected exact-pair real-agent qualification", "pair qualification job"), "pair qualification"),
    result: normalizedConclusion(result, "result"),
  };
  const reservation = { reservationId: state.reservationId, identitySha256: state.identitySha256,
    requestId: dispatch.requestId, candidateSha: preparation.candidateSha };
  const downstream = Object.entries(jobResults).filter(([name]) => !["binding", "result"].includes(name)).map(([, conclusion]) => conclusion);
  const classification = runIdentity.conclusion === "cancelled"
    ? { stage: "cancelled", disposition: "cancelled", recoverable: false }
    : new Set(["failure", "timed_out"]).has(jobResults.binding) && downstream.every((item) => item === "skipped")
      ? { stage: "pre-gate", disposition: "retryable", recoverable: true }
      : { stage: "gate", disposition: "blocked", recoverable: false };
  const body = { format: QUALIFICATION_FAILURE_FORMAT, run: runIdentity, reservation, jobs: jobResults, classification };
  return validateQualificationFailureEvidence({ ...body, evidenceSha256: digest(body) });
}

function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const stateFile = option(process.argv, "--state"); const runFile = option(process.argv, "--run"); const jobsFile = option(process.argv, "--jobs");
    if (!stateFile || !runFile || !jobsFile) throw new Error("Usage: classify-openclaw-qualification-failure.mjs --state FILE --run FILE --jobs FILE");
    const [state, run, jobs] = await Promise.all([stateFile, runFile, jobsFile].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
    process.stdout.write(`${JSON.stringify(classifyQualificationFailure({ state, run, jobs }), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
