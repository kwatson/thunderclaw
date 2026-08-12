import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  normalizeApprovalCode,
  PairingCliResponseError,
  type PairingCliDevice,
  type PairingCliRequest,
  validateApproval,
  validateDenial,
  validateIdentifier,
  validatePairingDevices,
  validatePairingRequests,
  validatePairingStatus,
  validateRevocation,
} from "./pairing-cli-contract.js";
import {
  fitTerminalText,
  formatRelativeTime,
  asciiTerminalText,
  type CliInput,
  type CliOutput,
  PairingCliInputError,
  PairingCliInterruptedError,
  PairingCliTerminatedError,
  promptHiddenLine,
  promptLine,
  readSingleStdinLine,
  safeIdentifierSuffix,
  sanitizeTerminalText,
} from "./pairing-cli-terminal.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];
type OperatorScope = "operator.read" | "operator.admin";
type Operation = "status" | "requests.list" | "requests.approve" | "requests.deny" | "devices.list" | "devices.revoke" | "manager";
type DeviceState = "Replaced" | "Expired" | "Revoked" | "Active";
const MANAGER_HISTORICAL_DEVICE_LIMIT = 5;

export type PairingCliDependencies = {
  stdin: CliInput;
  stdout: CliOutput;
  stderr: CliOutput;
  now: () => number;
  asciiOnly: boolean;
  callGateway: (method: string, params: Record<string, never> | Record<string, string>, scopes: readonly OperatorScope[], signal: AbortSignal) => Promise<unknown>;
  setExitCode: (code: number) => void;
  promptLine: (prompt: string) => Promise<string>;
  promptSecret: (prompt: string) => Promise<string>;
  readStdinLine: () => Promise<string>;
};

type CliFailureOutcome = "not-attempted" | "not-confirmed" | "unknown" | "confirmed";

class PairingCliFailure extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string,
    readonly outcome: CliFailureOutcome,
    readonly reconciliation?: string,
  ) {
    super(message);
  }
}

let stderrSuppressionDepth = 0;
let originalStderrWrite: typeof process.stderr.write | undefined;

async function withGatewayStderrSuppressed<T>(action: () => Promise<T>): Promise<T> {
  if (stderrSuppressionDepth === 0) {
    originalStderrWrite = process.stderr.write;
    process.stderr.write = ((..._arguments: unknown[]) => true) as typeof process.stderr.write;
  }
  stderrSuppressionDepth += 1;
  try {
    return await action();
  } finally {
    stderrSuppressionDepth -= 1;
    if (stderrSuppressionDepth === 0 && originalStderrWrite) {
      process.stderr.write = originalStderrWrite;
      originalStderrWrite = undefined;
    }
  }
}

const defaultDependencies = (): PairingCliDependencies => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  now: Date.now,
  asciiOnly: process.env.TERM === "dumb" || !/utf-?8/iu.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? ""),
  callGateway: async (method, params, scopes, signal) => withGatewayStderrSuppressed(() => callGatewayFromCli(
      method,
      { json: true },
      params,
      { scopes: [...scopes], signal, progress: false },
    )),
  setExitCode: (code) => { process.exitCode = code; },
  promptLine: (prompt) => promptLine(process.stdin, process.stderr, prompt),
  promptSecret: (prompt) => promptHiddenLine(process.stdin, process.stderr, prompt),
  readStdinLine: () => readSingleStdinLine(process.stdin),
});

function write(output: CliOutput, value: string): void {
  output.write(value.endsWith("\n") ? value : `${value}\n`);
}

function writeHuman(dependencies: PairingCliDependencies, value: string): void {
  write(dependencies.stderr, dependencies.asciiOnly ? asciiTerminalText(value) : value);
}

function observedAt(now: number): string {
  return new Date(now).toISOString();
}

function usage(message: string): never {
  throw new PairingCliFailure(2, "INVALID_USAGE", message, "not-attempted");
}

function selectionChanged(message: string): never {
  throw new PairingCliFailure(3, "SELECTION_CHANGED", message, "not-attempted");
}

function normalizeCode(value: string): string {
  try {
    return normalizeApprovalCode(value);
  } catch {
    return usage("Approval code must be ten Base32 characters, with an optional hyphen");
  }
}

function exactId(value: unknown, label: string): string {
  try {
    return validateIdentifier(value);
  } catch {
    return usage(`${label} must be a complete 20–64 character ThunderClaw identifier`);
  }
}

function ownString(error: unknown, key: string): string | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

function ownNumber(error: unknown, key: string): number | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "number" ? descriptor.value : undefined;
}

function isTransportFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "GatewayTransportError" || name === "AbortError";
}

function reconciliationText(value: string | undefined): string {
  if (value === undefined) return "";
  const descriptions: Record<string, string> = {
    "request-pending": "A fresh read still shows the request pending.",
    "request-approved": "A fresh read shows the request approved and awaiting claim in Thunderbird.",
    "request-not-open": "A fresh read no longer shows the request; the current API cannot determine why it disappeared.",
    "credential-active": "A fresh read still shows the credential active.",
    "credential-revoked": "A fresh read shows the credential revoked.",
    "credential-expired": "A fresh read shows the credential expired.",
    "credential-replaced": "A fresh read shows the credential replaced.",
    "credential-not-listed": "A fresh read no longer lists the credential.",
    "reconciliation-unavailable": "The one bounded read-only reconciliation attempt was unavailable.",
  };
  return ` ${descriptions[value] ?? "A fresh read returned an unrecognized state."}`;
}

function mapFailure(error: unknown, operation: Operation, mutationSent = false, reconciliation?: string): PairingCliFailure {
  if (error instanceof PairingCliFailure) return error;
  if (error instanceof PairingCliInterruptedError || (error instanceof Error && error.name === "AbortError")) {
    return new PairingCliFailure(130, "INTERRUPTED", "Interrupted; no automatic retry was attempted", mutationSent ? "unknown" : "not-attempted", reconciliation);
  }
  if (error instanceof PairingCliTerminatedError) {
    return new PairingCliFailure(error.exitCode, error.code, error.message, "not-attempted");
  }
  if (error instanceof PairingCliInputError) {
    return new PairingCliFailure(2, error.code, error.message, "not-attempted");
  }
  if (error instanceof PairingCliResponseError) {
    return new PairingCliFailure(70, error.code, error.message, mutationSent ? "unknown" : "not-attempted", reconciliation);
  }
  const name = error instanceof Error ? error.name : "";
  const gatewayCode = ownString(error, "gatewayCode") ?? ownString(error, "code");
  if (gatewayCode === "PAIRING_CONFLICT") {
    const message = operation === "requests.approve"
      ? "This request or code is no longer valid. Check the code in Thunderbird, refresh, and try again if the request is still pending."
      : "The selected ThunderClaw record is no longer actionable. Refresh and review its current state.";
    return new PairingCliFailure(4, gatewayCode, `${message}${reconciliationText(reconciliation)}`, "not-confirmed", reconciliation);
  }
  const authTransportClose = name === "GatewayTransportError" && ownString(error, "kind") === "closed" && ownNumber(error, "code") === 1008;
  if (gatewayCode === "FORBIDDEN" || gatewayCode === "AUTH_REQUIRED" || gatewayCode === "UNAUTHORIZED"
    || gatewayCode === "AUTH_UNAUTHORIZED" || gatewayCode === "NOT_LINKED" || gatewayCode === "NOT_PAIRED" || authTransportClose
    || name === "GatewayCredentialsRequiredError" || name === "GatewayExplicitAuthRequiredError" || name === "GatewayStoredDeviceAuthUnavailableError") {
    return new PairingCliFailure(5, gatewayCode ?? "AUTH_UNAUTHORIZED", "Gateway operator authentication or the required operator scope is unavailable", "not-attempted", reconciliation);
  }
  if (gatewayCode === "PAIRING_UNAVAILABLE" || gatewayCode === "UNAVAILABLE" || isTransportFailure(error)) {
    const timeout = name === "GatewayTransportError" && ownString(error, "kind") === "timeout";
    return new PairingCliFailure(6, timeout ? "GATEWAY_TIMEOUT" : gatewayCode ?? "GATEWAY_UNAVAILABLE",
      mutationSent ? `The Gateway result is unavailable. The mutation was not retried; review the current ThunderClaw state before trying again.${reconciliationText(reconciliation)}`
        : "ThunderClaw pairing administration is unavailable. Check that the Gateway and plugin are running.",
      mutationSent ? "unknown" : "not-attempted", reconciliation);
  }
  const rawMessage = error instanceof Error ? error.message : "";
  if (gatewayCode === "INVALID_REQUEST" && /^unknown method:/u.test(rawMessage)) {
    return new PairingCliFailure(6, "PAIRING_UNAVAILABLE", "The installed Gateway does not expose this ThunderClaw administration method", "not-attempted", reconciliation);
  }
  return new PairingCliFailure(70, "INTERNAL_ERROR", "ThunderClaw CLI encountered an unexpected software failure", mutationSent ? "unknown" : "not-attempted", reconciliation);
}

function failureJson(operation: Operation, failure: PairingCliFailure) {
  return {
    cliOutputVersion: 1,
    ok: false,
    operation,
    error: {
      code: failure.code,
      message: failure.message,
      outcome: failure.outcome,
      ...(failure.reconciliation === undefined ? {} : { reconciliation: failure.reconciliation }),
    },
  };
}

function selectedJson(argv: readonly string[]): boolean {
  for (const argument of argv.slice(2)) {
    if (argument === "--") return false;
    if (argument === "--json") return true;
  }
  return false;
}

function operationFromArgv(argv: readonly string[]): Operation {
  const [root, group, action] = getRootOptionAwareCommandPath(argv, 3);
  if (root !== "thunderclaw") return "manager";
  if (group === "status") return "status";
  if (group === "requests" && action === "list") return "requests.list";
  if (group === "requests" && action === "approve") return "requests.approve";
  if (group === "requests" && action === "deny") return "requests.deny";
  if (group === "devices" && action === "list") return "devices.list";
  if (group === "devices" && action === "revoke") return "devices.revoke";
  return "manager";
}

function configureUsageErrors(
  command: CliProgram,
  rootProgram: CliProgram,
  dependencies: PairingCliDependencies,
): void {
  command.allowExcessArguments(false);
  command.configureOutput({ writeErr: () => {}, outputError: () => {} });
  command.exitOverride((error) => {
    if (error.exitCode === 0) throw error;
    const failure = new PairingCliFailure(2, "INVALID_USAGE", "Invalid ThunderClaw command usage. Run the selected command with --help.", "not-attempted");
    dependencies.setExitCode(2);
    error.exitCode = 2;
    const argv = (rootProgram as unknown as { rawArgs: readonly string[] }).rawArgs;
    if (selectedJson(argv)) write(dependencies.stdout, JSON.stringify(failureJson(operationFromArgv(argv), failure)));
    else writeHuman(dependencies, failure.message);
    throw error;
  });
}

function isInteractive(dependencies: PairingCliDependencies): boolean {
  return dependencies.stdin.isTTY === true && dependencies.stderr.isTTY === true;
}

async function runAction(
  dependencies: PairingCliDependencies,
  operation: Operation,
  json: boolean,
  action: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    await action(controller.signal);
    dependencies.setExitCode(0);
  } catch (error) {
    const failure = mapFailure(error, operation);
    dependencies.setExitCode(failure.exitCode);
    if (json) write(dependencies.stdout, JSON.stringify(failureJson(operation, failure)));
    else writeHuman(dependencies, failure.message);
  } finally {
    process.off("SIGINT", interrupt);
  }
}

async function gatewayRead<T>(
  dependencies: PairingCliDependencies,
  signal: AbortSignal,
  method: string,
  validate: (value: unknown) => T,
): Promise<T> {
  return validate(await dependencies.callGateway(method, {}, ["operator.read"], signal));
}

export function classifyDevice(device: PairingCliDevice, now: number): DeviceState {
  if (device.replacedBy !== null) return "Replaced";
  if (Date.parse(device.expiresAt) <= now) return "Expired";
  if (device.revokedAt !== null) return "Revoked";
  return "Active";
}

function requestExpiry(request: PairingCliRequest, now: number): string {
  const remaining = Date.parse(request.expiresAt) - now;
  return remaining <= 60_000
    ? `Expires soon · ${request.expiresAt} (${formatRelativeTime(now, request.expiresAt)})`
    : `expires ${request.expiresAt} (${formatRelativeTime(now, request.expiresAt)})`;
}

function columns(dependencies: PairingCliDependencies): number {
  return dependencies.stderr.columns ?? 100;
}

export function renderRequestList(requests: readonly PairingCliRequest[], now: number, terminalColumns = 100, asciiOnly = false): string {
  const pending = requests.filter((request) => request.state === "pending");
  const approved = requests.filter((request) => request.state === "approved");
  const lines = [`Pending approval (${pending.length})`];
  if (pending.length === 0) {
    lines.push("  None. Start pairing in Thunderbird, then refresh.");
  } else {
    pending.forEach((request, index) => {
      lines.push(`  ${index + 1}. ${fitTerminalText(asciiOnly ? asciiTerminalText(request.deviceName) : request.deviceName, terminalColumns, 5)}`);
      lines.push(`     requested ${formatRelativeTime(now, request.createdAt)} · ${requestExpiry(request, now)}`);
      lines.push(`     device ${safeIdentifierSuffix(request.deviceId)} · request ${safeIdentifierSuffix(request.requestId)}`);
      if (index < pending.length - 1) lines.push("");
    });
  }
  lines.push("", `Approved — finish in Thunderbird (${approved.length})`);
  if (approved.length === 0) lines.push("  None.");
  else approved.forEach((request) => {
    lines.push(`  - ${fitTerminalText(asciiOnly ? asciiTerminalText(request.deviceName) : request.deviceName, terminalColumns, 4)}`);
    lines.push(`    approved; select “Claim approved pairing” in Thunderbird before ${request.expiresAt}`);
    lines.push(`    request ${safeIdentifierSuffix(request.requestId)} · ${formatRelativeTime(now, request.expiresAt)} remaining`);
    lines.push("    The current protocol cannot cancel an approval; it disappears after claim or expiry.");
  });
  const rendered = lines.join("\n");
  return asciiOnly ? asciiTerminalText(rendered) : rendered;
}

export function renderDeviceList(
  devices: readonly PairingCliDevice[],
  now: number,
  firstNumber = 1,
  terminalColumns = 100,
  asciiOnly = false,
  historicalLimit = Number.POSITIVE_INFINITY,
  historicalOverflowAction = "Select [h]istory to view all.",
): string {
  const active = devices.filter((device) => classifyDevice(device, now) === "Active");
  const historical = devices
    .filter((device) => classifyDevice(device, now) !== "Active")
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const visibleHistorical = historical.slice(0, historicalLimit);
  const lines = [`Connected devices (${active.length} active, ${historical.length} historical)`];
  if (active.length === 0) lines.push("  None active.");
  active.forEach((device, index) => {
    const lastUsed = device.lastUsedAt === null ? "never used" : `last used ${formatRelativeTime(now, device.lastUsedAt)}`;
    lines.push(`  ${firstNumber + index}. ${fitTerminalText(asciiOnly ? asciiTerminalText(device.deviceName) : device.deviceName, terminalColumns, 5)} · Active · ${lastUsed}`);
    lines.push(`     credential ${safeIdentifierSuffix(device.credentialId)} · expires ${device.expiresAt}`);
  });
  if (historical.length > 0) {
    const historyHeading = visibleHistorical.length < historical.length
      ? `Historical credentials (showing ${visibleHistorical.length} of ${historical.length}, most recent first)`
      : `Historical credentials (${historical.length}, most recent first)`;
    lines.push("", historyHeading);
    visibleHistorical.forEach((device) => {
      lines.push(`  - ${fitTerminalText(asciiOnly ? asciiTerminalText(device.deviceName) : device.deviceName, terminalColumns, 4)} · ${classifyDevice(device, now)}`);
      lines.push(`    credential ${safeIdentifierSuffix(device.credentialId)} · expires ${device.expiresAt}`);
    });
    if (visibleHistorical.length < historical.length) {
      lines.push(`  ${historical.length - visibleHistorical.length} more. ${historicalOverflowAction}`);
    }
  }
  const rendered = lines.join("\n");
  return asciiOnly ? asciiTerminalText(rendered) : rendered;
}

function renderManager(
  requests: readonly PairingCliRequest[],
  devices: readonly PairingCliDevice[],
  now: number,
  terminalColumns: number,
  asciiOnly: boolean,
  showAllHistorical: boolean,
): string {
  const pendingCount = requests.filter((request) => request.state === "pending").length;
  return [
    "ThunderClaw — Thunderbird connections",
    "",
    renderRequestList(requests, now, terminalColumns, asciiOnly),
    "",
    renderDeviceList(
      devices,
      now,
      pendingCount + 1,
      terminalColumns,
      asciiOnly,
      showAllHistorical ? Number.POSITIVE_INFINITY : MANAGER_HISTORICAL_DEVICE_LIMIT,
    ),
  ].join("\n");
}

async function confirm(dependencies: PairingCliDependencies, prompt: string): Promise<boolean> {
  const answer = (await dependencies.promptLine(prompt)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function preflightRequest(
  dependencies: PairingCliDependencies,
  signal: AbortSignal,
  requestId: string,
): Promise<PairingCliRequest> {
  const current = await gatewayRead(dependencies, signal, "thunderclaw.pairing.requests", validatePairingRequests);
  const request = current.requests.find((candidate) => candidate.requestId === requestId);
  if (!request || request.state !== "pending") selectionChanged("The selected pairing request is absent or no longer pending. Refresh and review the current list.");
  return request;
}

async function preflightDevice(
  dependencies: PairingCliDependencies,
  signal: AbortSignal,
  credentialId: string,
): Promise<PairingCliDevice> {
  const current = await gatewayRead(dependencies, signal, "thunderclaw.devices.list", validatePairingDevices);
  const device = current.devices.find((candidate) => candidate.credentialId === credentialId);
  if (!device || classifyDevice(device, dependencies.now()) !== "Active") selectionChanged("The selected credential is absent or no longer active. Refresh and review the current list.");
  return device;
}

async function reconcileAfterTransportFailure(
  dependencies: PairingCliDependencies,
  operation: "requests.approve" | "requests.deny" | "devices.revoke",
  identifier: string,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  timeout.unref();
  try {
    if (operation === "devices.revoke") {
      const current = await gatewayRead(dependencies, controller.signal, "thunderclaw.devices.list", validatePairingDevices);
      const device = current.devices.find((candidate) => candidate.credentialId === identifier);
      return device ? `credential-${classifyDevice(device, dependencies.now()).toLowerCase()}` : "credential-not-listed";
    }
    const current = await gatewayRead(dependencies, controller.signal, "thunderclaw.pairing.requests", validatePairingRequests);
    const request = current.requests.find((candidate) => candidate.requestId === identifier);
    return request ? `request-${request.state}` : "request-not-open";
  } catch {
    return "reconciliation-unavailable";
  } finally {
    clearTimeout(timeout);
  }
}

async function callMutation<T>(
  dependencies: PairingCliDependencies,
  signal: AbortSignal,
  operation: "requests.approve" | "requests.deny" | "devices.revoke",
  method: string,
  params: Record<string, string>,
  validate: (value: unknown) => T,
  identifier: string,
): Promise<T> {
  try {
    return validate(await dependencies.callGateway(method, params, ["operator.admin"], signal));
  } catch (error) {
    const gatewayCode = ownString(error, "gatewayCode") ?? ownString(error, "code");
    const reconciliation = isTransportFailure(error) || gatewayCode === "PAIRING_CONFLICT"
      ? await reconcileAfterTransportFailure(dependencies, operation, identifier)
      : undefined;
    throw mapFailure(error, operation, true, reconciliation);
  }
}

async function postRequestState(dependencies: PairingCliDependencies, signal: AbortSignal, requestId: string): Promise<string> {
  try {
    const current = await gatewayRead(dependencies, signal, "thunderclaw.pairing.requests", validatePairingRequests);
    const request = current.requests.find((candidate) => candidate.requestId === requestId);
    return request ? request.state : "not-open";
  } catch {
    return "reconciliation-unavailable";
  }
}

async function postDeviceState(dependencies: PairingCliDependencies, signal: AbortSignal, credentialId: string): Promise<string> {
  try {
    const current = await gatewayRead(dependencies, signal, "thunderclaw.devices.list", validatePairingDevices);
    const device = current.devices.find((candidate) => candidate.credentialId === credentialId);
    return device ? classifyDevice(device, dependencies.now()).toLowerCase() : "not-listed";
  } catch {
    return "reconciliation-unavailable";
  }
}

function outputSuccess(dependencies: PairingCliDependencies, json: boolean, value: Record<string, unknown>, human: string): void {
  if (json) write(dependencies.stdout, JSON.stringify(value));
  else writeHuman(dependencies, human);
}

async function runStatus(dependencies: PairingCliDependencies, signal: AbortSignal, json: boolean): Promise<void> {
  const now = dependencies.now();
  const status = await gatewayRead(dependencies, signal, "thunderclaw.pairing.status", validatePairingStatus);
  if (!status.available) throw new PairingCliFailure(6, "PAIRING_UNAVAILABLE", "ThunderClaw pairing registry is unavailable", "not-attempted");
  outputSuccess(dependencies, json, {
    cliOutputVersion: 1, ok: true, operation: "status", observedAt: observedAt(now), status,
  }, `ThunderClaw pairing registry is available (protocol ${status.protocolVersion}).`);
}

async function runRequestsList(dependencies: PairingCliDependencies, signal: AbortSignal, json: boolean): Promise<void> {
  const now = dependencies.now();
  const result = await gatewayRead(dependencies, signal, "thunderclaw.pairing.requests", validatePairingRequests);
  outputSuccess(dependencies, json, {
    cliOutputVersion: 1, ok: true, operation: "requests.list", observedAt: observedAt(now), requests: result.requests,
  }, renderRequestList(result.requests, now, columns(dependencies), dependencies.asciiOnly));
}

async function runDevicesList(dependencies: PairingCliDependencies, signal: AbortSignal, json: boolean, all: boolean): Promise<void> {
  const now = dependencies.now();
  const result = await gatewayRead(dependencies, signal, "thunderclaw.devices.list", validatePairingDevices);
  outputSuccess(dependencies, json, {
    cliOutputVersion: 1, ok: true, operation: "devices.list", observedAt: observedAt(now), devices: result.devices,
  }, renderDeviceList(
    result.devices,
    now,
    1,
    columns(dependencies),
    dependencies.asciiOnly,
    all ? Number.POSITIVE_INFINITY : MANAGER_HISTORICAL_DEVICE_LIMIT,
    "Run openclaw thunderclaw devices list --all to view all.",
  ));
}

async function requireConfirmation(
  dependencies: PairingCliDependencies,
  json: boolean,
  yes: boolean,
  prompt: string,
): Promise<boolean> {
  if (yes) return true;
  if (json || !isInteractive(dependencies)) usage("--yes is required when prompts are unavailable or --json is used");
  return confirm(dependencies, prompt);
}

function requireHeadlessIntent(dependencies: PairingCliDependencies, json: boolean, yes: boolean): void {
  if ((json || !isInteractive(dependencies)) && !yes) {
    usage("--yes is required when prompts are unavailable or --json is used");
  }
}

async function approvalCode(dependencies: PairingCliDependencies, json: boolean, codeStdin: boolean): Promise<string> {
  if (codeStdin) return normalizeCode(await dependencies.readStdinLine());
  if (json || !isInteractive(dependencies)) usage("--code-stdin is required when hidden interactive input is unavailable or --json is used");
  return normalizeCode(await dependencies.promptSecret("Approval code: "));
}

async function approveRequest(
  dependencies: PairingCliDependencies,
  signal: AbortSignal,
  requestIdValue: unknown,
  options: { json?: boolean; yes?: boolean; codeStdin?: boolean },
): Promise<void> {
  const json = options.json === true;
  const requestId = exactId(requestIdValue, "request-id");
  requireHeadlessIntent(dependencies, json, options.yes === true);
  const code = await approvalCode(dependencies, json, options.codeStdin === true);
  const accepted = await requireConfirmation(dependencies, json, options.yes === true, `Approve request ${requestId} using the code you entered? [y/N] `);
  if (!accepted) return outputSuccess(dependencies, false, {}, "No changes made.");
  const request = await preflightRequest(dependencies, signal, requestId);
  await callMutation(dependencies, signal, "requests.approve", "thunderclaw.pairing.approve", { requestId, approvalCode: code }, validateApproval, requestId);
  const currentState = await postRequestState(dependencies, signal, requestId);
  outputSuccess(dependencies, json, {
    cliOutputVersion: 1, ok: true, operation: "requests.approve", observedAt: observedAt(dependencies.now()),
    requestId, approved: true, currentState,
  }, `Approved.\nReturn to Thunderbird and select “Claim approved pairing” before ${request.expiresAt}.`);
}

async function denyRequest(
  dependencies: PairingCliDependencies,
  signal: AbortSignal,
  requestIdValue: unknown,
  options: { json?: boolean; yes?: boolean },
): Promise<void> {
  const json = options.json === true;
  const requestId = exactId(requestIdValue, "request-id");
  requireHeadlessIntent(dependencies, json, options.yes === true);
  const request = await preflightRequest(dependencies, signal, requestId);
  const accepted = await requireConfirmation(dependencies, json, options.yes === true,
    `Deny pairing request for “${sanitizeTerminalText(request.deviceName)}”? Thunderbird will need to start pairing again. [y/N] `);
  if (!accepted) return outputSuccess(dependencies, false, {}, "No changes made.");
  await preflightRequest(dependencies, signal, requestId);
  await callMutation(dependencies, signal, "requests.deny", "thunderclaw.pairing.deny", { requestId }, validateDenial, requestId);
  const currentState = await postRequestState(dependencies, signal, requestId);
  outputSuccess(dependencies, json, {
    cliOutputVersion: 1, ok: true, operation: "requests.deny", observedAt: observedAt(dependencies.now()),
    requestId, denied: true, currentState,
  }, "Denied. This request can no longer be claimed.");
}

async function revokeDevice(
  dependencies: PairingCliDependencies,
  signal: AbortSignal,
  credentialIdValue: unknown,
  options: { json?: boolean; yes?: boolean },
): Promise<void> {
  const json = options.json === true;
  const credentialId = exactId(credentialIdValue, "credential-id");
  requireHeadlessIntent(dependencies, json, options.yes === true);
  const device = await preflightDevice(dependencies, signal, credentialId);
  const accepted = await requireConfirmation(dependencies, json, options.yes === true,
    `Revoke “${sanitizeTerminalText(device.deviceName)}”? Thunderbird will immediately lose ThunderClaw access. [y/N] `);
  if (!accepted) return outputSuccess(dependencies, false, {}, "No changes made.");
  await preflightDevice(dependencies, signal, credentialId);
  await callMutation(dependencies, signal, "devices.revoke", "thunderclaw.devices.revoke", { credentialId }, validateRevocation, credentialId);
  const currentState = await postDeviceState(dependencies, signal, credentialId);
  outputSuccess(dependencies, json, {
    cliOutputVersion: 1, ok: true, operation: "devices.revoke", observedAt: observedAt(dependencies.now()),
    credentialId, revoked: true, currentState,
  }, "Revoked. Pair again in Thunderbird to reconnect this installation.");
}

async function manageRequest(dependencies: PairingCliDependencies, signal: AbortSignal, request: PairingCliRequest): Promise<void> {
  writeHuman(dependencies, [
    "Pairing request",
    `  ${fitTerminalText(request.deviceName, columns(dependencies), 2)}`,
    `  request ${request.requestId}`,
    `  requested ${formatRelativeTime(dependencies.now(), request.createdAt)}`,
    `  expires ${request.expiresAt}`,
  ].join("\n"));
  const action = (await dependencies.promptLine("[a]pprove, [d]eny, or [b]ack: ")).trim().toLowerCase();
  if (action === "b" || action === "back" || action === "") return;
  if (action === "a" || action === "approve") {
    return approveRequest(dependencies, signal, request.requestId, {});
  }
  if (action === "d" || action === "deny") {
    return denyRequest(dependencies, signal, request.requestId, {});
  }
  writeHuman(dependencies, "Choose Approve, Deny, or Back.");
}

async function manageDevice(dependencies: PairingCliDependencies, signal: AbortSignal, device: PairingCliDevice): Promise<void> {
  writeHuman(dependencies, [
    "Connected device",
    `  ${fitTerminalText(device.deviceName, columns(dependencies), 2)}`,
    `  credential ${device.credentialId}`,
    `  expires ${device.expiresAt}`,
    "  Revocation does not delete mail or change drafts.",
  ].join("\n"));
  await revokeDevice(dependencies, signal, device.credentialId, {});
}

async function runManager(dependencies: PairingCliDependencies, signal: AbortSignal): Promise<void> {
  if (!isInteractive(dependencies)) usage("Interactive management requires a terminal. Use an explicit subcommand; add --json for machine output.");
  let showAllHistorical = false;
  for (;;) {
    const now = dependencies.now();
    const [requestResult, deviceResult] = await Promise.all([
      gatewayRead(dependencies, signal, "thunderclaw.pairing.requests", validatePairingRequests),
      gatewayRead(dependencies, signal, "thunderclaw.devices.list", validatePairingDevices),
    ]);
    writeHuman(dependencies, renderManager(
      requestResult.requests,
      deviceResult.devices,
      now,
      columns(dependencies),
      dependencies.asciiOnly,
      showAllHistorical,
    ));
    const pending = requestResult.requests.filter((request) => request.state === "pending");
    const active = deviceResult.devices.filter((device) => classifyDevice(device, now) === "Active");
    const historicalCount = deviceResult.devices.length - active.length;
    if (pending.length === 1 && await confirm(dependencies, "Manage the single pending request? [y/N] ")) {
      await manageRequest(dependencies, signal, pending[0]!);
      continue;
    }
    const historyAction = historicalCount > MANAGER_HISTORICAL_DEVICE_LIMIT
      ? showAllHistorical ? ", [h]istory (show recent 5)" : ", [h]istory (view all)"
      : "";
    const answer = (await dependencies.promptLine(`Select a number${historyAction}, [r]efresh, or [q]uit: `)).trim().toLowerCase();
    if (answer === "q" || answer === "quit") return;
    if (answer === "r" || answer === "refresh" || answer === "") continue;
    if ((answer === "h" || answer === "history") && historicalCount > MANAGER_HISTORICAL_DEVICE_LIMIT) {
      showAllHistorical = !showAllHistorical;
      continue;
    }
    if (!/^\d+$/u.test(answer)) {
      writeHuman(dependencies, "Choose a listed number, Refresh, or Quit.");
      continue;
    }
    const selected = Number(answer);
    if (selected >= 1 && selected <= pending.length) {
      await manageRequest(dependencies, signal, pending[selected - 1]!);
      continue;
    }
    const activeIndex = selected - pending.length - 1;
    if (activeIndex >= 0 && activeIndex < active.length) {
      await manageDevice(dependencies, signal, active[activeIndex]!);
      continue;
    }
    writeHuman(dependencies, "That number is not actionable. Approved requests must be claimed in Thunderbird; historical credentials cannot be revoked again.");
  }
}

export function registerThunderClawCli(program: CliProgram, overrides: Partial<PairingCliDependencies> = {}): void {
  const defaults = defaultDependencies();
  const dependencies: PairingCliDependencies = {
    ...defaults,
    ...overrides,
    promptLine: overrides.promptLine ?? ((prompt) => promptLine(overrides.stdin ?? defaults.stdin, overrides.stderr ?? defaults.stderr,
      dependencies.asciiOnly ? asciiTerminalText(prompt) : prompt)),
    promptSecret: overrides.promptSecret ?? ((prompt) => promptHiddenLine(overrides.stdin ?? defaults.stdin, overrides.stderr ?? defaults.stderr,
      dependencies.asciiOnly ? asciiTerminalText(prompt) : prompt)),
    readStdinLine: overrides.readStdinLine ?? (() => readSingleStdinLine(overrides.stdin ?? defaults.stdin)),
  };
  const thunderclaw = program.command("thunderclaw")
    .description("Manage ThunderClaw Thunderbird connections")
    .action(async () => runAction(dependencies, "manager", false, (signal) => runManager(dependencies, signal)));

  thunderclaw.command("status")
    .description("Check ThunderClaw pairing registry availability")
    .option("--json", "Print stable JSON", false)
    .action(async (options: { json?: boolean }) => runAction(dependencies, "status", options.json === true,
      (signal) => runStatus(dependencies, signal, options.json === true)));

  const requests = thunderclaw.command("requests").description("Manage Thunderbird pairing requests")
    .action(async () => runAction(dependencies, "manager", false, async () => usage("Choose a requests subcommand: list, approve, or deny")));
  requests.command("list")
    .description("List open pairing requests")
    .option("--json", "Print stable JSON", false)
    .action(async (options: { json?: boolean }) => runAction(dependencies, "requests.list", options.json === true,
      (signal) => runRequestsList(dependencies, signal, options.json === true)));
  requests.command("approve")
    .description("Approve a pending pairing request")
    .argument("<request-id>", "Exact pairing request identifier")
    .option("--code-stdin", "Read one newline-terminated approval code from stdin", false)
    .option("--yes", "Confirm the exact action", false)
    .option("--json", "Print stable JSON", false)
    .action(async (requestId: string | undefined, options: { codeStdin?: boolean; yes?: boolean; json?: boolean }) =>
      runAction(dependencies, "requests.approve", options.json === true,
        (signal) => approveRequest(dependencies, signal, requestId, options)));
  requests.command("deny")
    .description("Deny a pending pairing request")
    .argument("<request-id>", "Exact pairing request identifier")
    .option("--yes", "Confirm the exact action", false)
    .option("--json", "Print stable JSON", false)
    .action(async (requestId: string | undefined, options: { yes?: boolean; json?: boolean }) =>
      runAction(dependencies, "requests.deny", options.json === true,
        (signal) => denyRequest(dependencies, signal, requestId, options)));

  const devices = thunderclaw.command("devices").description("Manage Thunderbird device credentials")
    .action(async () => runAction(dependencies, "manager", false, async () => usage("Choose a devices subcommand: list or revoke")));
  devices.command("list")
    .description("List device credential records")
    .option("--all", "Show all historical credentials in human-readable output", false)
    .option("--json", "Print stable JSON", false)
    .action(async (options: { all?: boolean; json?: boolean }) => runAction(dependencies, "devices.list", options.json === true,
      (signal) => runDevicesList(dependencies, signal, options.json === true, options.all === true || options.json === true)));
  devices.command("revoke")
    .description("Revoke an active device credential")
    .argument("<credential-id>", "Exact credential identifier")
    .option("--yes", "Confirm the exact action", false)
    .option("--json", "Print stable JSON", false)
    .action(async (credentialId: string | undefined, options: { yes?: boolean; json?: boolean }) =>
      runAction(dependencies, "devices.revoke", options.json === true,
        (signal) => revokeDevice(dependencies, signal, credentialId, options)));

  const configure = (command: CliProgram): void => {
    configureUsageErrors(command, program, dependencies);
    for (const child of command.commands) configure(child);
  };
  configure(thunderclaw);
}
