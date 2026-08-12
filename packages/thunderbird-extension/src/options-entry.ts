import { DirectClientError } from "./direct-client-contract.js";
import { canonicalizeApiBase } from "./endpoint-policy.js";
import { randomId } from "./random-id.js";

declare const browser: any;

const OPTIONS_PORT_NAME = "thunderclaw-options-v1";
const endpointInput = requiredElement<HTMLInputElement>("endpoint");
const normalizeButton = requiredElement<HTMLButtonElement>("normalize");
const pairButton = requiredElement<HTMLButtonElement>("pair");
const claimButton = requiredElement<HTMLButtonElement>("claim");
const cancelPairingButton = requiredElement<HTMLButtonElement>("cancel-pairing");
const diagnoseButton = requiredElement<HTMLButtonElement>("diagnose");
const rotateButton = requiredElement<HTMLButtonElement>("rotate");
const disconnectButton = requiredElement<HTMLButtonElement>("disconnect");
const forgetButton = requiredElement<HTMLButtonElement>("forget");
const stateOutput = requiredElement<HTMLElement>("state");
const resultOutput = requiredElement<HTMLElement>("result");
const agentsOutput = requiredElement<HTMLElement>("agents");
const pairingOutput = requiredElement<HTMLElement>("pairing");
const port = browser.runtime.connect({ name: OPTIONS_PORT_NAME });
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let busy = false;
let lastState: Record<string, unknown> = {};
type VerificationOutcome = { kind: "success"; response: unknown } | { kind: "error"; error: unknown };
type VerificationSettlement = {
  agentId: string;
  probeRunId: string;
  generation: number;
  phase: "running" | "cancelling" | "cancel_failed";
  verifyOutcome: VerificationOutcome | null;
};
let verification: VerificationSettlement | null = null;
let agentRenderGeneration = 0;
let lastAgents: unknown[] = [];

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing options element: ${id}`);
  return element as T;
}

function localMessage(error: unknown): string {
  if (error instanceof DirectClientError) return error.message;
  return error instanceof Error && error.message ? error.message : "ThunderClaw could not complete this settings action.";
}

class OptionsRequestError extends Error {
  constructor(
    message: string,
    readonly permissionCleanup: "complete" | "background_pending" | null = null,
    readonly kind: string | null = null,
  ) {
    super(message);
    this.name = "OptionsRequestError";
  }
}

function request(method: string, fields: Record<string, unknown> = {}): Promise<unknown> {
  const requestId = randomId();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    port.postMessage({ requestId, method, ...fields });
  });
}

port.onMessage.addListener((message: unknown) => {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const response = message as Record<string, unknown>;
  if (typeof response.requestId !== "string") return;
  const waiting = pending.get(response.requestId);
  if (!waiting) return;
  pending.delete(response.requestId);
  if (response.ok === true) waiting.resolve(response.value);
  else {
    const error = typeof response.error === "object" && response.error !== null ? response.error as Record<string, unknown> : {};
    const cleanup = error.permissionCleanup === "complete" || error.permissionCleanup === "background_pending" ? error.permissionCleanup : null;
    const kind = typeof error.kind === "string" && [
      "configuration", "permission", "authentication", "capability", "network", "timeout",
      "cancellation", "rate_limit", "contract", "backend",
    ].includes(error.kind) ? error.kind : null;
    waiting.reject(new OptionsRequestError(
      typeof error.message === "string" ? error.message : "ThunderClaw rejected the settings action.",
      cleanup,
      kind,
    ));
  }
});

port.onDisconnect.addListener(() => {
  for (const waiting of pending.values()) waiting.reject(new Error("The ThunderClaw settings connection closed."));
  pending.clear();
});

function renderState(value: unknown): void {
  const state = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  lastState = state;
  const configured = state.configured === true;
  const granted = state.permissionGranted === true;
  const cleanupRequired = state.cleanupRequired === true;
  const phase = state.phase;
  stateOutput.textContent = cleanupRequired
    ? "Permission cleanup required — retry Disconnect or revoke host access in Add-ons Manager"
    : phase === "ready"
    ? "Connected — status and agents tested"
    : phase === "awaiting_approval" ? "Pairing request awaiting OpenClaw operator approval"
      : phase === "pairing_expired" ? "Pairing request expired"
      : phase === "rotation_ambiguous" ? "Credential rotation outcome uncertain — features are disabled"
      : phase === "disconnect_ambiguous" ? "Remote revocation outcome uncertain — features are disabled"
      : phase === "credential_expired" ? "Device credential expired — Disconnect, then pair again"
      : phase === "credential_revoked" ? "Device credential was revoked — Disconnect, then pair again"
    : phase === "authorized_untested"
      ? "Authorized — not yet tested"
      : configured || granted ? "Not connected" : "Not configured";
  stateOutput.dataset.state = phase === "ready" ? "connected" : "disconnected";
  if (typeof state.apiBase === "string") endpointInput.value = state.apiBase;
  pairingOutput.textContent = typeof state.approvalCode === "string"
    ? `Approval code: ${state.approvalCode}. Ask the OpenClaw host operator to open the ThunderClaw manager using the installation's OpenClaw CLI and approve this exact code. Then return here and select Claim approved pairing. Expires ${String(state.pairingExpiresAt)}.`
    : state.remoteCredentialPossiblyActive === true
      ? "A device credential may still be active remotely. Retry the recovery action or use Forget, then verify revocation in OpenClaw administration."
      : "";
  updateControls();
}

function updateControls(): void {
  const configured = lastState.configured === true;
  const granted = lastState.permissionGranted === true;
  const cleanupRequired = lastState.cleanupRequired === true;
  const phase = lastState.phase;
  const unavailable = busy || verification !== null;
  endpointInput.disabled = unavailable;
  normalizeButton.disabled = unavailable;
  pairButton.disabled = unavailable || cleanupRequired || !["not_configured", "disconnected"].includes(String(phase));
  claimButton.disabled = unavailable || phase !== "awaiting_approval";
  cancelPairingButton.disabled = unavailable || (phase !== "awaiting_approval" && phase !== "pairing_expired");
  diagnoseButton.disabled = unavailable || (phase !== "authorized_untested" && phase !== "ready");
  rotateButton.disabled = unavailable || !["authorized_untested", "ready", "rotation_ambiguous"].includes(String(phase));
  disconnectButton.disabled = unavailable || (!configured && !granted && !cleanupRequired);
  forgetButton.disabled = unavailable || !configured;
}

function setBusy(value: boolean): void {
  busy = value;
  updateControls();
}

const CHECK_LABELS: Record<string, string> = {
  configuration: "Configuration",
  credentials: "Credentials",
  structuredOutput: "Structured output",
  toolIsolation: "Tool isolation",
  cancellation: "Cancellation",
  fallbacks: "Configured fallbacks",
};

const CHECK_RESULT_COPY: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  not_run: "Not run",
  not_applicable: "Not applicable",
};

const STATE_COPY: Record<string, string> = {
  unverified: "Unverified",
  partially_verified: "Partially verified",
  verified: "Verified",
  incompatible: "Incompatible",
  unsupported: "Unsupported",
};

function renderAgents(values: unknown[]): void {
  lastAgents = values;
  agentRenderGeneration += 1;
  const generation = agentRenderGeneration;
  const cards: HTMLElement[] = [];
  for (const value of values) {
    const agent = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    const compatibility = typeof agent.compatibility === "object" && agent.compatibility !== null
      ? agent.compatibility as Record<string, unknown> : {};
    const checks = typeof compatibility.checks === "object" && compatibility.checks !== null
      ? compatibility.checks as Record<string, unknown> : {};
    const lastProbe = typeof compatibility.lastProbe === "object" && compatibility.lastProbe !== null
      ? compatibility.lastProbe as Record<string, unknown> : null;
    const card = document.createElement("article");
    card.className = "agent-card";
    const heading = document.createElement("h3");
    heading.textContent = `${String(agent.displayName ?? agent.agentId ?? "Unknown agent")}${agent.isDefault === true ? " (default)" : ""}`;
    const model = document.createElement("p");
    model.className = "agent-model";
    model.textContent = `Primary model: ${typeof agent.provider === "string" && typeof agent.model === "string" ? `${agent.provider}/${agent.model}` : typeof agent.model === "string" ? agent.model : "Not configured"}`;
    const state = document.createElement("p");
    state.className = "compatibility-state";
    state.textContent = `Compatibility: ${STATE_COPY[String(compatibility.state)] ?? "Unknown"}`;
    const list = document.createElement("dl");
    list.className = "compatibility-checks";
    for (const [key, label] of Object.entries(CHECK_LABELS)) {
      const term = document.createElement("dt");
      term.textContent = label;
      const result = document.createElement("dd");
      result.textContent = CHECK_RESULT_COPY[String(checks[key])] ?? "Unknown";
      list.append(term, result);
    }
    const tested = document.createElement("p");
    tested.className = "agent-tested";
    tested.textContent = lastProbe && typeof lastProbe.testedAt === "string" ? `Last tested: ${lastProbe.testedAt}` : "Last tested: Never";
    const reason = document.createElement("p");
    reason.className = "agent-reason";
    reason.textContent = typeof compatibility.reason === "string" ? compatibility.reason : "Compatibility evidence is unavailable.";
    const actions = document.createElement("div");
    actions.className = "actions";
    const verify = document.createElement("button");
    verify.type = "button";
    verify.textContent = compatibility.state === "unverified" ? "Verify agent" : "Retry verification";
    const agentId = typeof agent.agentId === "string" ? agent.agentId : "";
    verify.disabled = verification !== null || agentId.length === 0;
    verify.addEventListener("click", () => {
      if (verification !== null || generation !== agentRenderGeneration) return;
      const probeRunId = randomId();
      const settlement: VerificationSettlement = { agentId, probeRunId, generation, phase: "running", verifyOutcome: null };
      verification = settlement;
      updateControls();
      verify.disabled = true;
      const progress = document.createElement("p");
      progress.className = "verification-progress";
      progress.textContent = "Verification in progress… This may make up to two synthetic model calls.";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = "Cancel verification";
      actions.replaceChildren(cancel);
      card.append(progress);
      cancel.addEventListener("click", () => {
        if (verification !== settlement || settlement.phase === "cancelling") return;
        settlement.phase = "cancelling";
        cancel.disabled = true;
        progress.textContent = "Cancelling verification…";
        void request("cancelAgentVerification", { agentId, probeRunId }).then((response) => {
          if (verification !== settlement) return;
          const record = typeof response === "object" && response !== null ? response as Record<string, unknown> : {};
          verification = null;
          renderAgents(Array.isArray(record.agents) ? record.agents : lastAgents);
          resultOutput.textContent = "Agent verification was cancelled.";
          resultOutput.dataset.state = "info";
        }).catch((error) => {
          if (verification !== settlement) return;
          settlement.phase = "cancel_failed";
          cancel.disabled = false;
          progress.textContent = "Verification is still in progress. Retry cancellation if needed.";
          showError(error);
          if (settlement.verifyOutcome !== null) terminalizeAfterCancelFailure(settlement, settlement.verifyOutcome);
          updateControls();
        });
      });
      void request("verifyAgent", { agentId, probeRunId }).then((response) => {
        if (verification !== settlement) return;
        if (settlement.phase === "cancelling") {
          settlement.verifyOutcome = { kind: "success", response };
          return;
        }
        if (settlement.phase === "cancel_failed") {
          terminalizeAfterCancelFailure(settlement, { kind: "success", response });
          updateControls();
          return;
        }
        const record = typeof response === "object" && response !== null ? response as Record<string, unknown> : {};
        verification = null;
        renderAgents(Array.isArray(record.agents) ? record.agents : lastAgents);
        resultOutput.textContent = "Agent verification finished. Compatibility evidence was refreshed.";
        resultOutput.dataset.state = "success";
      }).catch((error) => {
        if (verification !== settlement) return;
        if (settlement.phase === "cancelling") {
          settlement.verifyOutcome = { kind: "error", error };
          return;
        }
        if (settlement.phase === "cancel_failed") {
          terminalizeAfterCancelFailure(settlement, { kind: "error", error });
          updateControls();
          return;
        }
        verification = null;
        renderAgents(lastAgents);
        showError(error);
      }).finally(() => {
        updateControls();
      });
    });
    actions.append(verify);
    card.append(heading, model, state, list, tested, reason, actions);
    cards.push(card);
  }
  if (cards.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No configured agents were reported.";
    agentsOutput.replaceChildren(empty);
  } else agentsOutput.replaceChildren(...cards);
}

function renderDiagnostics(value: unknown): void {
  const diagnostics = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const status = typeof diagnostics.status === "object" && diagnostics.status !== null ? diagnostics.status as Record<string, unknown> : {};
  const agents = Array.isArray(diagnostics.agents) ? diagnostics.agents : [];
  const heading = document.createElement("p");
  heading.textContent = `ThunderClaw protocol ${String(status.protocolVersion ?? "?")} · Gateway ${String(status.gatewayVersion ?? "unknown")}`;
  resultOutput.replaceChildren(heading);
  renderAgents(agents);
}

function showError(error: unknown): void {
  resultOutput.textContent = localMessage(error);
  resultOutput.dataset.state = "error";
}

function indeterminateVerificationError(error: unknown): boolean {
  return error instanceof OptionsRequestError && (error.kind === "network" || error.kind === "timeout");
}

function terminalizeAfterCancelFailure(settlement: VerificationSettlement, outcome: VerificationOutcome): boolean {
  settlement.verifyOutcome = outcome;
  if (outcome.kind === "error" && indeterminateVerificationError(outcome.error)) return false;
  if (verification !== settlement) return false;
  verification = null;
  const record = outcome.kind === "success" && typeof outcome.response === "object" && outcome.response !== null
    ? outcome.response as Record<string, unknown> : {};
  renderAgents(Array.isArray(record.agents) ? record.agents : lastAgents);
  return true;
}

normalizeButton.addEventListener("click", () => {
  if (busy) return;
  try {
    const endpoint = canonicalizeApiBase(endpointInput.value);
    endpointInput.value = endpoint.apiBase;
    resultOutput.textContent = `Thunderbird will be asked to grant ${endpoint.permissionPattern}. The grant covers every port and path on that hostname.`;
    resultOutput.dataset.state = "info";
  } catch (error) {
    showError(error);
  }
});

pairButton.addEventListener("click", () => {
  if (busy) return;
  let endpoint;
  try {
    endpoint = canonicalizeApiBase(endpointInput.value);
  } catch (error) {
    showError(error);
    return;
  }
  // This permission call is deliberately made synchronously from the click
  // handler. No background message or network request precedes the grant.
  setBusy(true);
  let grant: Promise<boolean>;
  try {
    grant = browser.permissions.request({ origins: [endpoint.permissionPattern] });
  } catch (error) {
    setBusy(false);
    showError(error);
    return;
  }
  void grant.then(async (granted: boolean) => {
    if (!granted) throw new Error("Thunderbird did not grant access to the configured OpenClaw host.");
    let value: unknown;
    try {
      value = await request("beginPair", { apiBase: endpoint.apiBase });
    } catch (error) {
      if (!(error instanceof OptionsRequestError) || error.permissionCleanup !== "complete") {
        throw new Error(`${localMessage(error)} Background permission cleanup is pending; if it remains, revoke ThunderClaw host access in Add-ons Manager.`);
      }
      throw error;
    }
    renderState(value);
    resultOutput.textContent = "Pairing request created. Ask the OpenClaw host operator to open the ThunderClaw manager using the installation's OpenClaw CLI and approve the displayed code. Then return here and select Claim approved pairing.";
    resultOutput.dataset.state = "success";
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the claim error. */ }
  }).finally(() => setBusy(false));
});

claimButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  void request("claimPairing").then((value) => {
    renderState(value);
    resultOutput.textContent = "Pairing claimed. The per-device credential is held only by the ThunderClaw background context.";
    resultOutput.dataset.state = "success";
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the claim error. */ }
  }).finally(() => setBusy(false));
});

cancelPairingButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  void request("cancelPairing").then((value) => {
    renderState(value);
    resultOutput.textContent = "The pending pairing request was cancelled locally.";
  }).catch(showError).finally(() => setBusy(false));
});

rotateButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  void request("rotateCredential").then((value) => {
    renderState(value);
    resultOutput.textContent = "The device credential was rotated. The replaced credential is no longer retained.";
    resultOutput.dataset.state = "success";
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the rotation error. */ }
  }).finally(() => setBusy(false));
});

diagnoseButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  resultOutput.textContent = "Testing the configured connection…";
  void request("diagnose").then(async (value) => {
    renderDiagnostics(value);
    renderState(await request("state"));
  }).catch(async (error) => {
    // Preserve the authoritative sanitized diagnostic error while refreshing
    // permission/credential state that the failed preflight may have changed.
    showError(error);
    try {
      renderState(await request("state"));
    } catch {
      // A closed options port must not replace the original diagnostic error.
    }
  }).finally(() => setBusy(false));
});

disconnectButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  void request("disconnect").then((value) => {
    renderState(value);
    resultOutput.textContent = "Disconnected. Remote device revocation was confirmed before local custody and hostname permission were removed.";
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the disconnect error. */ }
  }).finally(() => setBusy(false));
});

forgetButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  void request("forget").then((value) => {
    endpointInput.value = "";
    renderState(value);
    const state = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    resultOutput.textContent = state.forgetRemoteRevocation === "confirmed"
      ? "Connection settings, device credential, and hostname permission were forgotten after confirmed remote revocation."
      : "Local connection settings and device credential were forgotten, but remote revocation could not be confirmed. Revoke this device in OpenClaw administration.";
  }).catch(showError).finally(() => setBusy(false));
});

updateControls();
void request("state").then(renderState).catch(showError);
