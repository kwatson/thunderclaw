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
const stateIndicator = document.getElementById("state-indicator");
const connectionPanel = document.getElementById("connection-panel");
const agentsPanel = document.getElementById("agents-panel");
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

function focusElement(element: HTMLElement): void {
  if (typeof element.focus === "function") element.focus();
}

function scheduleFocus(element: HTMLElement): void {
  globalThis.setTimeout(() => focusElement(element), 0);
}

function setAttribute(element: HTMLElement | null, name: string, value: string): void {
  if (element && typeof element.setAttribute === "function") element.setAttribute(name, value);
}

function setResult(message: string, kind: "info" | "success" | "error" = "info"): void {
  setAttribute(resultOutput, "role", kind === "error" ? "alert" : "status");
  setAttribute(resultOutput, "aria-live", kind === "error" ? "assertive" : "polite");
  resultOutput.dataset.state = kind;
  resultOutput.dataset.kind = kind;
  resultOutput.textContent = message;
  if (kind === "error") scheduleFocus(resultOutput);
}

function formatExpiry(value: unknown): string {
  if (typeof value !== "string") return "This code expires soon.";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "This code expires soon.";
  return `Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)}.`;
}

function renderPairing(state: Record<string, unknown>): void {
  if (typeof state.approvalCode === "string") {
    const heading = document.createElement("h3");
    heading.tabIndex = -1;
    heading.textContent = "Approve this pairing code in OpenClaw";
    const instructions = document.createElement("ol");
    instructions.className = "pairing-instructions";
    const openManager = document.createElement("li");
    openManager.textContent = "Ask the OpenClaw host operator to open the ThunderClaw manager using the installation's OpenClaw CLI.";
    const approveCode = document.createElement("li");
    approveCode.textContent = "Select this Thunderbird and approve this exact code:";
    instructions.append(openManager, approveCode);
    const codeRow = document.createElement("div");
    codeRow.className = "pairing-code-row";
    const code = document.createElement("p");
    code.className = "pairing-code";
    code.textContent = state.approvalCode;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary copy-code";
    copy.dataset.action = "copy-pairing-code";
    copy.textContent = "Copy code";
    copy.addEventListener("click", () => {
      let write: Promise<void> | undefined;
      try {
        write = navigator.clipboard?.writeText(String(state.approvalCode));
      } catch {
        setResult("The pairing code could not be copied automatically. Select and copy the code instead.", "error");
        return;
      }
      if (!write) {
        setResult("The pairing code could not be copied automatically. Select and copy the code instead.", "error");
        return;
      }
      void write.then(() => {
        copy.textContent = "Copied";
        setResult("Pairing code copied.", "success");
      }).catch(() => {
        setResult("The pairing code could not be copied automatically. Select and copy the code instead.", "error");
      });
    });
    const expiry = document.createElement("p");
    expiry.className = "pairing-expiry";
    expiry.textContent = `${formatExpiry(state.pairingExpiresAt)} After approval, return here and select Finish pairing.`;
    codeRow.append(code, copy);
    pairingOutput.replaceChildren(heading, instructions, codeRow, expiry);
    return;
  }
  if (state.remoteCredentialPossiblyActive === true) {
    const recovery = document.createElement("p");
    recovery.className = "pairing-recovery";
    recovery.textContent = "A device credential may still be active remotely. Retry the recovery action or use Forget connection, then verify revocation in OpenClaw administration.";
    pairingOutput.replaceChildren(recovery);
    return;
  }
  pairingOutput.replaceChildren();
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
    ? "Permission cleanup needed — try disconnecting again or remove ThunderClaw access in Add-ons Manager"
    : phase === "ready"
    ? "Connected — ThunderClaw can reach OpenClaw"
    : phase === "awaiting_approval" ? "Approval needed — approve the code in OpenClaw"
      : phase === "pairing_expired" ? "Pairing request expired"
      : phase === "rotation_ambiguous" ? "Connection paused — credential replacement could not be confirmed"
      : phase === "disconnect_ambiguous" ? "Connection paused — remote disconnection could not be confirmed"
      : phase === "credential_expired" ? "Connection expired — disconnect, then pair again"
      : phase === "credential_revoked" ? "Connection revoked — disconnect, then pair again"
    : phase === "authorized_untested"
      ? "Almost done — test the connection to load your agents"
      : "Not connected";
  const visualState = phase === "ready" ? "connected"
    : cleanupRequired || ["awaiting_approval", "pairing_expired", "rotation_ambiguous", "disconnect_ambiguous", "credential_expired", "credential_revoked"].includes(String(phase))
      ? "attention" : "disconnected";
  stateOutput.dataset.state = visualState;
  if (stateIndicator) stateIndicator.dataset.state = visualState;
  if (connectionPanel) connectionPanel.dataset.phase = String(phase ?? "unknown");
  if (agentsPanel) agentsPanel.hidden = !["authorized_untested", "ready"].includes(String(phase));
  if (document.documentElement) document.documentElement.dataset.phase = String(phase ?? "unknown");
  if (typeof state.apiBase === "string") endpointInput.value = state.apiBase;
  renderPairing(state);
  updateControls();
}

function updateControls(): void {
  const configured = lastState.configured === true;
  const granted = lastState.permissionGranted === true;
  const cleanupRequired = lastState.cleanupRequired === true;
  const phase = lastState.phase;
  const unavailable = busy || verification !== null;
  setAttribute(connectionPanel, "aria-busy", String(busy));
  setAttribute(agentsOutput, "aria-busy", String(unavailable));
  const pairingActive = phase === "awaiting_approval" || phase === "pairing_expired";
  endpointInput.disabled = busy;
  endpointInput.readOnly = configured || granted || pairingActive;
  normalizeButton.disabled = unavailable;
  pairButton.disabled = unavailable || cleanupRequired || !["not_configured", "disconnected"].includes(String(phase));
  claimButton.disabled = unavailable || phase !== "awaiting_approval";
  cancelPairingButton.disabled = unavailable || (phase !== "awaiting_approval" && phase !== "pairing_expired");
  diagnoseButton.disabled = unavailable || (phase !== "authorized_untested" && phase !== "ready");
  rotateButton.disabled = unavailable || !["authorized_untested", "ready", "rotation_ambiguous"].includes(String(phase));
  disconnectButton.disabled = unavailable || (!configured && !granted && !cleanupRequired);
  forgetButton.disabled = unavailable || !configured;
  pairButton.hidden = !["not_configured", "disconnected"].includes(String(phase));
  claimButton.hidden = phase !== "awaiting_approval";
  cancelPairingButton.hidden = phase !== "awaiting_approval" && phase !== "pairing_expired";
  diagnoseButton.hidden = phase !== "authorized_untested" && phase !== "ready";
  diagnoseButton.textContent = phase === "ready" ? "Test again" : "Test connection";
  diagnoseButton.className = phase === "ready" ? "secondary" : "";
}

function setBusy(value: boolean): void {
  busy = value;
  setAttribute(connectionPanel, "aria-busy", String(value));
  setAttribute(agentsOutput, "aria-busy", String(value || verification !== null));
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
    tested.textContent = lastProbe && typeof lastProbe.testedAt === "string"
      ? `Last tested: ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(lastProbe.testedAt))}`
      : "Last tested: Never";
    const reason = document.createElement("p");
    reason.className = "agent-reason";
    reason.textContent = typeof compatibility.reason === "string" ? compatibility.reason : "Compatibility evidence is unavailable.";
    const actions = document.createElement("div");
    actions.className = "actions";
    const verify = document.createElement("button");
    verify.type = "button";
    verify.textContent = compatibility.state === "unverified" ? "Verify agent" : "Retry verification";
    const agentId = typeof agent.agentId === "string" ? agent.agentId : "";
    card.dataset.agentId = agentId;
    verify.dataset.action = "verify-agent";
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
      cancel.dataset.action = "cancel-agent-verification";
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
          setResult("Agent verification was cancelled.");
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
        setResult("Agent verification finished. Compatibility evidence was refreshed.", "success");
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
    const details = document.createElement("details");
    details.className = "verification-details";
    const detailsSummary = document.createElement("summary");
    detailsSummary.textContent = "Verification details";
    details.append(detailsSummary, list, tested, reason);
    actions.append(verify);
    card.append(heading, model, state, details, actions);
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
  resultOutput.dataset.state = "success";
  resultOutput.dataset.kind = "success";
  renderAgents(agents);
}

function showError(error: unknown): void {
  setResult(localMessage(error), "error");
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

function normalizeEndpoint(announce: boolean): boolean {
  if (busy) return false;
  try {
    const endpoint = canonicalizeApiBase(endpointInput.value);
    endpointInput.value = endpoint.apiBase;
    if (announce) setResult(`Thunderbird will be asked to grant ${endpoint.permissionPattern}. The grant covers every port and path on that hostname.`);
    return true;
  } catch (error) {
    if (announce) showError(error);
    else setResult(localMessage(error), "error");
    return false;
  }
}

normalizeButton.addEventListener("click", () => {
  normalizeEndpoint(true);
});

endpointInput.addEventListener("blur", () => {
  if (endpointInput.value.trim().length > 0 && !endpointInput.readOnly) normalizeEndpoint(false);
});

pairButton.addEventListener("click", () => {
  if (busy) return;
  let endpoint;
  try {
    endpoint = canonicalizeApiBase(endpointInput.value);
    endpointInput.value = endpoint.apiBase;
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
    setResult("Pairing request created. Approve the displayed code in OpenClaw, then finish pairing here.", "success");
    const firstPairingElement = pairingOutput.children[0];
    if (firstPairingElement) scheduleFocus(firstPairingElement as HTMLElement);
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the claim error. */ }
  }).finally(() => setBusy(false));
});

claimButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  setResult("Finishing pairing…");
  void request("claimPairing").then((value) => {
    renderState(value);
    setResult("Pairing complete. Test the connection to load your available agents.", "success");
    scheduleFocus(stateOutput);
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the claim error. */ }
  }).finally(() => setBusy(false));
});

cancelPairingButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  setResult("Cancelling pairing…");
  void request("cancelPairing").then((value) => {
    renderState(value);
    setResult("The pending pairing request was cancelled locally.");
    scheduleFocus(endpointInput);
  }).catch(showError).finally(() => setBusy(false));
});

rotateButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  setResult("Replacing the connection credential…");
  void request("rotateCredential").then((value) => {
    renderState(value);
    setResult("Credential rotated. The previous credential is no longer retained.", "success");
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the rotation error. */ }
  }).finally(() => setBusy(false));
});

diagnoseButton.addEventListener("click", () => {
  if (busy) return;
  setBusy(true);
  setResult("Testing the configured connection…");
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
  setResult("Disconnecting this Thunderbird from OpenClaw…");
  void request("disconnect").then((value) => {
    renderState(value);
    setResult("Disconnected. OpenClaw confirmed revocation before Thunderbird removed its local credential and host permission.", "success");
    scheduleFocus(endpointInput);
  }).catch(async (error) => {
    showError(error);
    try { renderState(await request("state")); } catch { /* Preserve the disconnect error. */ }
  }).finally(() => setBusy(false));
});

forgetButton.addEventListener("click", () => {
  if (busy) return;
  const confirmed = globalThis.confirm("Forget this connection on Thunderbird?\n\nUse this only if OpenClaw cannot be reached. Remote access may remain active and may need to be revoked in OpenClaw administration.");
  if (!confirmed) return;
  setBusy(true);
  setResult("Removing the local connection…");
  void request("forget").then((value) => {
    endpointInput.value = "";
    renderState(value);
    const state = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    setResult(state.forgetRemoteRevocation === "confirmed"
      ? "Connection settings, device credential, and hostname permission were forgotten after confirmed remote revocation."
      : "Local connection settings and device credential were forgotten, but remote revocation could not be confirmed. Revoke this device in OpenClaw administration.",
      state.forgetRemoteRevocation === "confirmed" ? "success" : "error");
    if (state.forgetRemoteRevocation === "confirmed") scheduleFocus(endpointInput);
  }).catch(showError).finally(() => setBusy(false));
});

updateControls();
void request("state").then(renderState).catch(showError);
