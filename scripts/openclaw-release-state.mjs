import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateQualificationFailureEvidence } from "./classify-openclaw-qualification-failure.mjs";
import { assessUpgradeEvidence, immutableReleaseIdentity, validateUpgradePreflight } from "./openclaw-upgrade-policy.mjs";

export const RELEASE_STATE_FORMAT = "thunderclaw-openclaw-autopilot-state-v1";
export const RELEASE_INTENT_FORMAT = "thunderclaw-openclaw-autopilot-intent-v1";
const phases = ["observed", "ready", "prepared", "qualifying", "retryable", "cancelled", "qualified", "merged", "tagged", "github-published", "clawhub-verified", "closeout-open", "complete", "blocked"];
const intentTypes = ["reobserve", "waive-soak", "record-qualification-failure", "recover-qualification-automation", "record-preparation", "record-qualification-dispatch", "record-qualification", "record-merge", "record-tag", "record-github-publication", "record-clawhub-verification", "open-closeout", "complete-closeout", "block"];
const sha40 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
function exact(value, keys, name) { if (!exactKeys(value, keys)) throw new Error(`${name} must use its exact schema`); return value; }
function pattern(value, regex, name) { if (typeof value !== "string" || !regex.test(value)) throw new Error(`${name} is malformed`); }
function timestamp(value, name) { const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN; const canonical = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : ""; if (!Number.isFinite(milliseconds) || (canonical !== value && canonical.replace(/\.000Z$/u, "Z") !== value)) throw new Error(`${name} must be a canonical UTC timestamp`); }
function same(left, right) { return isDeepStrictEqual(left, right); }
function counterpart(value, name = "counterpart") {
  exact(value, ["repository", "tag", "name", "sha256", "size"], name);
  for (const key of ["repository", "tag", "name"]) if (typeof value[key] !== "string" || value[key].length < 1) throw new Error(`${name}.${key} is malformed`);
  pattern(value.sha256, sha256, `${name}.sha256`); if (!Number.isSafeInteger(value.size) || value.size < 1) throw new Error(`${name}.size is malformed`);
}
function automation(value) {
  exact(value, ["controllerWorkflowSha", "qualificationWorkflowSha", "classifierSha", "releaseWorkflowSha"], "automation");
  for (const [key, digest] of Object.entries(value)) pattern(digest, sha256, `automation.${key}`);
}

export function validateReleaseState(value) {
  const keys = ["format", "revision", "phase", "reservationId", "baseSha", "baseline", "identity", "identitySha256", "firstObservedAt", "lastObservedAt", "soakCompletesAt", "advisories", "blockers", "outputs", "history"];
  if (!exactKeys(value, keys) || value.format !== RELEASE_STATE_FORMAT || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("release state must use the strict v1 schema");
  if (!phases.includes(value.phase)) throw new Error("release state phase is invalid");
  pattern(value.reservationId, /^[a-f0-9]{32}$/u, "reservationId"); pattern(value.baseSha, sha40, "baseSha");
  validateUpgradePreflight(value.baseline);
  if (hash(value.identity) !== value.identitySha256 || !exactKeys(value.identity, Object.keys(immutableReleaseIdentity(value.baseline)))) throw new Error("release state identity hash is invalid");
  for (const [name, instant] of [["firstObservedAt", value.firstObservedAt], ["lastObservedAt", value.lastObservedAt], ["soakCompletesAt", value.soakCompletesAt]]) timestamp(instant, name);
  if (!Array.isArray(value.advisories) || !value.advisories.every((item) => typeof item === "string") || !Array.isArray(value.blockers) || !value.blockers.every((item) => typeof item === "string") || !object(value.outputs) || !Array.isArray(value.history)) throw new Error("release state collections are malformed");
  const outputKeys = { observed: [], ready: [], prepared: ["preparation"], qualifying: ["preparation", "qualificationDispatch"], retryable: ["preparation", "qualificationDispatch", "failure"], cancelled: ["preparation", "qualificationDispatch", "failure"], qualified: ["preparation", "qualificationDispatch", "qualification"], merged: ["preparation", "qualificationDispatch", "qualification", "merge"], tagged: ["preparation", "qualificationDispatch", "qualification", "merge", "tagged"], "github-published": ["preparation", "qualificationDispatch", "qualification", "merge", "tagged", "githubPublication"], "clawhub-verified": ["preparation", "qualificationDispatch", "qualification", "merge", "tagged", "githubPublication", "clawhubVerification"], "closeout-open": ["preparation", "qualificationDispatch", "qualification", "merge", "tagged", "githubPublication", "clawhubVerification", "closeout"], complete: ["preparation", "qualificationDispatch", "qualification", "merge", "tagged", "githubPublication", "clawhubVerification", "closeout", "completion"] };
  if (value.phase !== "blocked" && !exactKeys(value.outputs, outputKeys[value.phase])) throw new Error("release state outputs do not match its phase");
  if (value.phase === "blocked" && !Object.values(outputKeys).some((keys) => exactKeys(value.outputs, keys))
      && !exactKeys(value.outputs, ["preparation", "qualificationDispatch", "failure"])) throw new Error("blocked release state has a noncanonical output prefix");
  const outputs = value.outputs;
  if (outputs.preparation) {
    const p = exact(outputs.preparation, ["reservationId", "pluginVersion", "preparedDate", "baseSha", "branch", "prNumber", "candidateSha", "candidateTree", "tag", "classificationEvidenceSha256", "counterpart", "automation"], "persisted preparation");
    if (p.reservationId !== value.reservationId || p.baseSha !== value.baseSha || typeof p.branch !== "string" || !p.branch || typeof p.tag !== "string" || !p.tag || !Number.isSafeInteger(p.prNumber) || p.prNumber < 1) throw new Error("persisted preparation identity is inconsistent");
    pattern(p.pluginVersion, /^\d+\.\d+\.\d+$/u, "persisted pluginVersion"); pattern(p.preparedDate, /^\d{4}-\d{2}-\d{2}$/u, "persisted preparedDate"); pattern(p.candidateSha, sha40, "persisted candidateSha"); pattern(p.candidateTree, sha40, "persisted candidateTree"); pattern(p.classificationEvidenceSha256, sha256, "persisted classificationEvidenceSha256"); counterpart(p.counterpart); automation(p.automation);
  }
  if (outputs.qualificationDispatch) {
    const d = exact(outputs.qualificationDispatch, ["requestId", "workflow", "workflowCommit", "workflowSha256", "dispatchedAt"], "persisted qualification dispatch");
    pattern(d.workflowCommit, sha40, "persisted workflowCommit"); pattern(d.workflowSha256, sha256, "persisted workflowSha256"); timestamp(d.dispatchedAt, "persisted dispatchedAt");
    if (typeof d.requestId !== "string" || !d.requestId || typeof d.workflow !== "string" || !d.workflow || d.workflowSha256 !== outputs.preparation.automation.qualificationWorkflowSha) throw new Error("persisted qualification dispatch is inconsistent");
  }
  if (outputs.qualification) {
    const q = exact(outputs.qualification, ["requestId", "workflow", "workflowCommit", "workflowSha256", "runId", "runAttempt", "headSha", "headBranch", "event", "conclusion", "evidenceSha256", "classificationEvidenceSha256", "candidateArtifactSha256", "counterpart"], "persisted qualification");
    pattern(q.workflowCommit, sha40, "persisted qualification workflowCommit"); pattern(q.workflowSha256, sha256, "persisted qualification workflowSha256"); pattern(q.headSha, sha40, "persisted qualification headSha");
    for (const key of ["evidenceSha256", "classificationEvidenceSha256", "candidateArtifactSha256"]) pattern(q[key], sha256, `persisted qualification ${key}`); counterpart(q.counterpart);
    if (q.conclusion !== "success" || !Number.isSafeInteger(q.runId) || q.runId < 1 || !Number.isSafeInteger(q.runAttempt) || q.runAttempt < 1 || q.requestId !== outputs.qualificationDispatch.requestId || q.workflow !== outputs.qualificationDispatch.workflow || q.workflowCommit !== outputs.qualificationDispatch.workflowCommit || q.workflowSha256 !== outputs.qualificationDispatch.workflowSha256 || q.headSha !== outputs.preparation.candidateSha || q.headBranch !== outputs.preparation.branch || q.classificationEvidenceSha256 !== outputs.preparation.classificationEvidenceSha256 || !same(q.counterpart, outputs.preparation.counterpart)) throw new Error("persisted qualification is inconsistent");
  }
  if (outputs.failure) {
    const failure = validateQualificationFailureEvidence(outputs.failure);
    if (!outputs.preparation || !outputs.qualificationDispatch
        || failure.reservation.reservationId !== value.reservationId
        || failure.reservation.identitySha256 !== value.identitySha256
        || failure.reservation.requestId !== outputs.qualificationDispatch.requestId
        || failure.reservation.candidateSha !== outputs.preparation.candidateSha
        || failure.run.workflowCommit !== outputs.qualificationDispatch.workflowCommit
        || (value.phase === "retryable") !== (failure.classification.disposition === "retryable")
        || (value.phase === "cancelled") !== (failure.classification.disposition === "cancelled")
        || (value.phase === "blocked") !== (failure.classification.disposition === "blocked")) {
      throw new Error("persisted qualification failure is inconsistent");
    }
  }
  if (outputs.merge) {
    const m = exact(outputs.merge, ["mergeSha", "mergeTree", "tag"], "persisted merge"); pattern(m.mergeSha, sha40, "persisted mergeSha"); pattern(m.mergeTree, sha40, "persisted mergeTree");
    if (m.mergeTree !== outputs.preparation.candidateTree || m.tag !== outputs.preparation.tag) throw new Error("persisted merge is inconsistent");
  }
  if (outputs.tagged) { const t = exact(outputs.tagged, ["tag", "commit", "tree"], "persisted tag"); if (t.tag !== outputs.merge.tag || t.commit !== outputs.merge.mergeSha || t.tree !== outputs.merge.mergeTree) throw new Error("persisted tag is inconsistent"); }
  if (outputs.githubPublication) {
    const g = exact(outputs.githubPublication, ["tag", "commit", "artifactSha256", "releaseId"], "persisted GitHub publication"); pattern(g.artifactSha256, sha256, "persisted artifactSha256");
    if (g.tag !== outputs.tagged.tag || g.commit !== outputs.tagged.commit || !Number.isSafeInteger(g.releaseId) || g.releaseId < 1) throw new Error("persisted GitHub publication is inconsistent");
  }
  if (outputs.clawhubVerification) { const c = exact(outputs.clawhubVerification, ["tag", "version", "artifactSha256", "verifiedAt"], "persisted ClawHub verification"); timestamp(c.verifiedAt, "persisted verifiedAt"); if (c.tag !== outputs.tagged.tag || c.version !== outputs.preparation.pluginVersion || c.artifactSha256 !== outputs.githubPublication.artifactSha256) throw new Error("persisted ClawHub verification is inconsistent"); }
  if (outputs.closeout) { const c = exact(outputs.closeout, ["branch", "prNumber", "baseline", "headSha", "tree"], "persisted closeout"); counterpart(c.baseline, "persisted closeout baseline"); pattern(c.headSha, sha40, "persisted closeout headSha"); pattern(c.tree, sha40, "persisted closeout tree"); if (typeof c.branch !== "string" || !c.branch || !Number.isSafeInteger(c.prNumber) || c.prNumber < 1) throw new Error("persisted closeout is inconsistent"); }
  if (outputs.completion) { const c = exact(outputs.completion, ["mergeSha", "mergeTree"], "persisted completion"); pattern(c.mergeSha, sha40, "persisted completion mergeSha"); pattern(c.mergeTree, sha40, "persisted completion mergeTree"); }
  for (const [index, event] of value.history.entries()) {
    if (!exactKeys(event, ["intentId", "type", "at", "payloadSha256", "from", "to", "revision"])) throw new Error(`release state history ${index} is malformed`);
    timestamp(event.at, `history[${index}].at`); pattern(event.payloadSha256, sha256, `history[${index}].payloadSha256`);
    if (event.revision !== index + 1 || !intentTypes.includes(event.type) || !phases.includes(event.from) || !phases.includes(event.to)) throw new Error(`release state history ${index} is inconsistent`);
  }
  if (value.revision !== value.history.length) throw new Error("release state revision does not match history");
  if (value.history.length > 0 && value.history.at(-1).to !== value.phase) throw new Error("release state phase does not match its history");
  return value;
}

export function createReleaseState(preflight, { reservationId, baseSha }) {
  const baseline = validateUpgradePreflight(preflight); pattern(reservationId, /^[a-f0-9]{32}$/u, "reservationId"); pattern(baseSha, sha40, "baseSha");
  const identity = immutableReleaseIdentity(baseline); const assessment = assessUpgradeEvidence({ baseline, current: baseline });
  return validateReleaseState({ format: RELEASE_STATE_FORMAT, revision: 0, phase: assessment.blockers.length ? "blocked" : "observed", reservationId, baseSha, baseline, identity, identitySha256: hash(identity), firstObservedAt: baseline.observedAt, lastObservedAt: baseline.observedAt, soakCompletesAt: assessment.soakCompletesAt, advisories: assessment.advisories, blockers: assessment.blockers, outputs: {}, history: [] });
}
function validateIntent(value) {
  if (!exactKeys(value, ["format", "intentId", "expectedRevision", "type", "at", "payload"]) || value.format !== RELEASE_INTENT_FORMAT || typeof value.intentId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.intentId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !intentTypes.includes(value.type) || !object(value.payload)) throw new Error("release intent must use the strict v1 schema");
  timestamp(value.at, "intent.at"); return value;
}
function phase(state, expected, action) { if (state.phase !== expected) throw new Error(`${action} may be recorded only from ${expected}`); }

export function applyReleaseStateIntent(stateValue, intentValue) {
  const state = validateReleaseState(structuredClone(stateValue)); const intent = validateIntent(structuredClone(intentValue)); const payloadSha256 = hash(intent.payload);
  const replay = state.history.find((event) => event.intentId === intent.intentId);
  if (replay) { if (replay.type !== intent.type || replay.payloadSha256 !== payloadSha256) throw new Error("intent id was reused with different content"); return { decision: "already-applied", expectedRevision: state.revision, state }; }
  if (intent.expectedRevision !== state.revision) return { decision: "compare-and-swap-mismatch", expectedRevision: state.revision, state };
  if (["complete", "cancelled", "blocked"].includes(state.phase)
      || (state.phase === "retryable" && intent.type !== "recover-qualification-automation")) return { decision: "terminal", expectedRevision: state.revision, state };
  const from = state.phase; const payload = intent.payload;
  if (intent.type === "recover-qualification-automation") {
    phase(state, "retryable", "qualification automation recovery");
    exact(payload, ["failedRunId", "failedRunAttempt", "failureEvidenceSha256", "identitySha256", "preflight", "reason", "reservationId", "baseSha"], "qualification automation recovery payload");
    if (!Number.isSafeInteger(payload.failedRunId) || payload.failedRunId < 1 || !Number.isSafeInteger(payload.failedRunAttempt) || payload.failedRunAttempt < 1) throw new Error("qualification automation recovery run identity is malformed");
    if (typeof payload.reason !== "string" || !payload.reason) throw new Error("qualification automation recovery reason is malformed");
    pattern(payload.failureEvidenceSha256, sha256, "qualification automation recovery evidence"); pattern(payload.identitySha256, sha256, "qualification automation recovery identity");
    pattern(payload.reservationId, /^[a-f0-9]{32}$/u, "qualification automation recovery reservationId"); pattern(payload.baseSha, sha40, "qualification automation recovery baseSha");
    const failure = validateQualificationFailureEvidence(state.outputs.failure);
    const current = validateUpgradePreflight(payload.preflight); const reassessment = assessUpgradeEvidence({ baseline: state.baseline, current, now: intent.at });
    if (!failure.classification.recoverable || failure.classification.disposition !== "retryable"
        || failure.run.id !== payload.failedRunId || failure.run.attempt !== payload.failedRunAttempt
        || failure.evidenceSha256 !== payload.failureEvidenceSha256 || payload.identitySha256 !== state.identitySha256
        || reassessment.identitySha256 !== state.identitySha256 || reassessment.blockers.length > 0
        || failure.reservation.identitySha256 !== state.identitySha256 || !state.outputs.preparation
        || !state.outputs.qualificationDispatch || state.outputs.qualification) throw new Error("only exact structured pre-gate qualification evidence may be recovered");
    state.reservationId = payload.reservationId; state.baseSha = payload.baseSha; state.outputs = {}; state.blockers = [];
    state.lastObservedAt = current.observedAt; state.advisories = reassessment.advisories;
    state.advisories = [...new Set([...state.advisories, `qualification automation failure recovered: ${payload.reason}`])]; state.phase = "ready";
  } else if (intent.type === "reobserve") {
    if (!["observed", "ready"].includes(state.phase)) throw new Error("reobservation may be recorded only from observed or ready");
    exact(payload, ["preflight", "baseSha"], "reobserve payload"); const current = validateUpgradePreflight(payload.preflight); pattern(payload.baseSha, sha40, "reobserve baseSha");
    const assessment = assessUpgradeEvidence({ baseline: state.baseline, current, now: intent.at }); state.lastObservedAt = current.observedAt; state.advisories = assessment.advisories; state.blockers = assessment.blockers;
    if (assessment.identitySha256 !== state.identitySha256) state.blockers = [...new Set([...state.blockers, "immutable release identity changed during soak"])]; state.baseSha = payload.baseSha; state.phase = state.blockers.length ? "blocked" : assessment.decision === "ready" ? "ready" : "observed";
  } else if (intent.type === "waive-soak") {
    phase(state, "observed", "soak waiver"); exact(payload, ["reason", "identitySha256", "firstObservedAt", "secondObservedAt"], "soak waiver payload");
    if (typeof payload.reason !== "string" || !payload.reason) throw new Error("soak waiver reason is malformed");
    pattern(payload.identitySha256, sha256, "soak waiver identitySha256"); timestamp(payload.firstObservedAt, "soak waiver firstObservedAt"); timestamp(payload.secondObservedAt, "soak waiver secondObservedAt");
    const observedTwice = state.history.some((event) => event.type === "reobserve" && event.to === "observed");
    if (!observedTwice || payload.identitySha256 !== state.identitySha256 || payload.firstObservedAt !== state.firstObservedAt
        || payload.secondObservedAt !== state.lastObservedAt || Date.parse(payload.secondObservedAt) <= Date.parse(payload.firstObservedAt)) {
      throw new Error("soak waiver requires two distinct observations of the exact same release identity");
    }
    state.advisories = [...new Set([...state.advisories, `24-hour soak waived: ${payload.reason}`])]; state.phase = "ready";
  } else if (intent.type === "record-qualification-failure") {
    phase(state, "qualifying", "qualification failure");
    const failure = validateQualificationFailureEvidence(payload);
    const preparation = state.outputs.preparation; const dispatch = state.outputs.qualificationDispatch;
    if (failure.reservation.reservationId !== state.reservationId || failure.reservation.identitySha256 !== state.identitySha256
        || failure.reservation.requestId !== dispatch.requestId || failure.reservation.candidateSha !== preparation.candidateSha
        || failure.run.workflowCommit !== dispatch.workflowCommit) throw new Error("qualification failure differs from the active reservation");
    state.outputs.failure = failure;
    state.phase = failure.classification.disposition;
    state.blockers = [`ThunderClaw qualification run ${failure.run.id} attempt ${failure.run.attempt} ended as ${failure.classification.disposition} at ${failure.classification.stage}`];
  } else if (intent.type === "record-preparation") {
    phase(state, "ready", "preparation"); exact(payload, ["reservationId", "pluginVersion", "preparedDate", "baseSha", "branch", "prNumber", "candidateSha", "candidateTree", "tag", "classificationEvidenceSha256", "counterpart", "automation"], "preparation payload");
    if (payload.reservationId !== state.reservationId || payload.baseSha !== state.baseSha) throw new Error("preparation does not match its reservation");
    pattern(payload.pluginVersion, /^\d+\.\d+\.\d+$/u, "pluginVersion"); pattern(payload.preparedDate, /^\d{4}-\d{2}-\d{2}$/u, "preparedDate"); pattern(payload.classificationEvidenceSha256, sha256, "classificationEvidenceSha256"); for (const key of ["candidateSha", "candidateTree"]) pattern(payload[key], sha40, key);
    if (typeof payload.branch !== "string" || !payload.branch || !Number.isSafeInteger(payload.prNumber) || payload.prNumber < 1 || typeof payload.tag !== "string" || !payload.tag) throw new Error("preparation identity is malformed"); counterpart(payload.counterpart); automation(payload.automation); state.outputs.preparation = payload; state.phase = "prepared";
  } else if (intent.type === "record-qualification-dispatch") {
    phase(state, "prepared", "qualification dispatch"); exact(payload, ["requestId", "workflow", "workflowCommit", "workflowSha256", "dispatchedAt"], "qualification dispatch payload");
    for (const key of ["requestId", "workflow"]) if (typeof payload[key] !== "string" || !payload[key]) throw new Error(`qualification dispatch ${key} is malformed`); pattern(payload.workflowCommit, sha40, "qualification dispatch workflowCommit"); pattern(payload.workflowSha256, sha256, "qualification dispatch workflowSha256"); timestamp(payload.dispatchedAt, "qualification dispatch dispatchedAt");
    if (payload.workflowSha256 !== state.outputs.preparation.automation.qualificationWorkflowSha) throw new Error("dispatched qualification workflow differs from reserved automation"); state.outputs.qualificationDispatch = payload; state.phase = "qualifying";
  } else if (intent.type === "record-qualification") {
    phase(state, "qualifying", "qualification"); exact(payload, ["requestId", "workflow", "workflowCommit", "workflowSha256", "runId", "runAttempt", "headSha", "headBranch", "event", "conclusion", "evidenceSha256", "classificationEvidenceSha256", "candidateArtifactSha256", "counterpart"], "qualification payload");
    for (const key of ["requestId", "workflow", "headBranch", "event"]) if (typeof payload[key] !== "string" || !payload[key]) throw new Error(`qualification ${key} is malformed`); pattern(payload.workflowCommit, sha40, "qualification workflowCommit"); for (const key of ["workflowSha256", "evidenceSha256", "classificationEvidenceSha256", "candidateArtifactSha256"]) pattern(payload[key], sha256, `qualification ${key}`); pattern(payload.headSha, sha40, "qualification headSha");
    if (!Number.isSafeInteger(payload.runId) || payload.runId < 1 || !Number.isSafeInteger(payload.runAttempt) || payload.runAttempt < 1 || payload.conclusion !== "success") throw new Error("qualification run did not succeed exactly");
    const dispatch = state.outputs.qualificationDispatch; const preparation = state.outputs.preparation; counterpart(payload.counterpart);
    if (payload.requestId !== dispatch.requestId || payload.workflow !== dispatch.workflow || payload.workflowCommit !== dispatch.workflowCommit || payload.workflowSha256 !== dispatch.workflowSha256 || payload.headSha !== preparation.candidateSha || payload.headBranch !== preparation.branch || payload.classificationEvidenceSha256 !== preparation.classificationEvidenceSha256 || !same(payload.counterpart, preparation.counterpart)) throw new Error("qualification output differs from the prepared and dispatched identities");
    state.outputs.qualification = payload; state.phase = "qualified";
  } else if (intent.type === "record-merge") {
    phase(state, "qualified", "merge"); exact(payload, ["mergeSha", "mergeTree", "tag"], "merge payload"); pattern(payload.mergeSha, sha40, "mergeSha"); pattern(payload.mergeTree, sha40, "mergeTree");
    if (payload.mergeTree !== state.outputs.preparation.candidateTree || payload.tag !== state.outputs.preparation.tag) throw new Error("merge output differs from the qualified candidate"); state.outputs.merge = payload; state.phase = "merged";
  } else if (intent.type === "record-tag") {
    phase(state, "merged", "tag"); exact(payload, ["tag", "commit", "tree"], "tag payload"); if (payload.tag !== state.outputs.merge.tag || payload.commit !== state.outputs.merge.mergeSha || payload.tree !== state.outputs.merge.mergeTree) throw new Error("tag does not bind the qualified merge"); state.outputs.tagged = payload; state.phase = "tagged";
  } else if (intent.type === "record-github-publication") {
    phase(state, "tagged", "GitHub publication"); exact(payload, ["tag", "commit", "artifactSha256", "releaseId"], "GitHub publication payload"); pattern(payload.artifactSha256, sha256, "artifactSha256");
    if (payload.tag !== state.outputs.tagged.tag || payload.commit !== state.outputs.tagged.commit || !Number.isSafeInteger(payload.releaseId) || payload.releaseId < 1) throw new Error("GitHub publication differs from the tagged source"); state.outputs.githubPublication = payload; state.phase = "github-published";
  } else if (intent.type === "record-clawhub-verification") {
    phase(state, "github-published", "ClawHub verification"); exact(payload, ["tag", "version", "artifactSha256", "verifiedAt"], "ClawHub verification payload"); timestamp(payload.verifiedAt, "verifiedAt");
    if (payload.tag !== state.outputs.tagged.tag || payload.artifactSha256 !== state.outputs.githubPublication.artifactSha256 || payload.version !== state.outputs.preparation.pluginVersion) throw new Error("ClawHub record differs from the qualified release"); state.outputs.clawhubVerification = payload; state.phase = "clawhub-verified";
  } else if (intent.type === "open-closeout") {
    phase(state, "clawhub-verified", "closeout"); exact(payload, ["branch", "prNumber", "baseline", "headSha", "tree"], "closeout payload");
    if (typeof payload.branch !== "string" || !payload.branch || !Number.isSafeInteger(payload.prNumber) || payload.prNumber < 1) throw new Error("closeout pull request identity is malformed"); counterpart(payload.baseline, "closeout baseline"); pattern(payload.headSha, sha40, "closeout headSha"); pattern(payload.tree, sha40, "closeout tree"); state.outputs.closeout = payload; state.phase = "closeout-open";
  } else if (intent.type === "complete-closeout") {
    phase(state, "closeout-open", "closeout completion"); exact(payload, ["mergeSha", "mergeTree"], "completion payload"); pattern(payload.mergeSha, sha40, "completion mergeSha"); pattern(payload.mergeTree, sha40, "completion mergeTree"); state.outputs.completion = payload; state.phase = "complete";
  } else { exact(payload, ["reason"], "block payload"); if (typeof payload.reason !== "string" || !payload.reason) throw new Error("block reason is malformed"); state.blockers = [...new Set([...state.blockers, payload.reason])]; state.phase = "blocked"; }
  state.revision += 1; state.history.push({ intentId: intent.intentId, type: intent.type, at: intent.at, payloadSha256, from, to: state.phase, revision: state.revision });
  return { decision: "applied", expectedRevision: state.revision, state: validateReleaseState(state) };
}

export function decideReleaseResume(stateValue) {
  const state = validateReleaseState(stateValue); const actions = { observed: "reobserve", ready: "prepare", prepared: "dispatch-qualification", qualifying: "await-qualification", retryable: "retry-qualification", cancelled: "cancelled", qualified: "merge", merged: "tag", tagged: "publish-github", "github-published": "verify-clawhub", "clawhub-verified": "open-closeout", "closeout-open": "complete-closeout", complete: "complete", blocked: "blocked" };
  const pauses = { observed: { reason: "soak", until: state.soakCompletesAt }, qualifying: { reason: "qualification" }, "closeout-open": { reason: "closeout" } };
  return { action: actions[state.phase], revision: state.revision, ...(pauses[state.phase] ? { pause: pauses[state.phase] } : {}), ...(["blocked", "cancelled", "retryable"].includes(state.phase) ? { blockers: state.blockers } : {}) };
}
async function readJson(file) { return JSON.parse(file === "-" ? await new Promise((resolve, reject) => { let contents = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { contents += chunk; }); process.stdin.on("end", () => resolve(contents)); process.stdin.on("error", reject); }) : await readFile(file, "utf8")); }
function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, ...args] = process.argv.slice(2); let result;
    if (command === "init" && option(args, "--preflight") && option(args, "--reservation-id") && option(args, "--base-sha")) result = createReleaseState(await readJson(option(args, "--preflight")), { reservationId: option(args, "--reservation-id"), baseSha: option(args, "--base-sha") });
    else if (command === "apply" && option(args, "--state") && option(args, "--intent")) { result = applyReleaseStateIntent(await readJson(option(args, "--state")), await readJson(option(args, "--intent"))); if (result.decision === "compare-and-swap-mismatch") process.exitCode = 3; else if (result.decision === "terminal") process.exitCode = 4; }
    else if (command === "resume" && option(args, "--state")) result = decideReleaseResume(await readJson(option(args, "--state")));
    else if (command === "validate" && option(args, "--state")) result = { valid: true, state: validateReleaseState(await readJson(option(args, "--state"))) };
    else throw new Error("Usage: openclaw-release-state.mjs <init --preflight FILE --reservation-id 32HEX --base-sha SHA|apply --state FILE --intent FILE|resume --state FILE|validate --state FILE>");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
