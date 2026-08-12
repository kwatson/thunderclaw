import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Command } from "commander";
import { DEVICE_CAPABILITIES } from "../packages/openclaw-plugin/src/pairing-cli-contract.js";
import {
  classifyDevice,
  registerThunderClawCli,
  renderDeviceList,
  renderRequestList,
  type PairingCliDependencies,
} from "../packages/openclaw-plugin/src/pairing-cli.js";

const NOW = Date.parse("2026-08-11T23:31:00.000Z");
const REQUEST_ID = "request_cli_123456789012";
const DEVICE_ID = "device_cli_1234567890123";
const CREDENTIAL_ID = "credential_cli_123456789";
const REPLACEMENT_ID = "credential_cli_replacement1";

const request = {
  requestId: REQUEST_ID,
  deviceId: DEVICE_ID,
  deviceName: "Thunderbird",
  credentialId: CREDENTIAL_ID,
  state: "pending" as const,
  createdAt: "2026-08-11T23:30:00.000Z",
  expiresAt: "2026-08-11T23:40:00.000Z",
};

const device = {
  credentialId: CREDENTIAL_ID,
  deviceId: DEVICE_ID,
  deviceName: "Thunderbird",
  capabilities: [...DEVICE_CAPABILITIES],
  createdAt: "2026-08-01T23:30:00.000Z",
  expiresAt: "2026-11-09T23:30:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  replacedBy: null,
};

type GatewayCall = {
  method: string;
  params: Record<string, never> | Record<string, string>;
  scopes: readonly string[];
  aborted: boolean;
};

function stream(tty = false) {
  const value = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
  value.isTTY = tty;
  value.columns = 80;
  return value;
}

function harness(responder?: (call: GatewayCall) => unknown | Promise<unknown>, tty = false) {
  const stdin = stream(tty);
  const stdout = stream(tty);
  const stderr = stream(tty);
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk) => { stdoutText += chunk.toString(); });
  stderr.on("data", (chunk) => { stderrText += chunk.toString(); });
  const calls: GatewayCall[] = [];
  const signals: AbortSignal[] = [];
  let exitCode: number | undefined;
  const answers: Array<string | Error> = [];
  const secretAnswers: string[] = [];
  const dependencies: Partial<PairingCliDependencies> = {
    stdin,
    stdout,
    stderr,
    now: () => NOW,
    setExitCode: (value) => { exitCode = value; },
    promptLine: async () => {
      const answer = answers.shift() ?? "";
      if (answer instanceof Error) throw answer;
      return answer;
    },
    promptSecret: async () => secretAnswers.shift() ?? "",
    readStdinLine: async () => secretAnswers.shift() ?? "",
    callGateway: async (method, params, scopes, signal) => {
      signals.push(signal);
      const call = { method, params, scopes, aborted: signal.aborted };
      calls.push(call);
      if (responder) return responder(call);
      if (method === "thunderclaw.pairing.status") return { protocolVersion: 1, available: true };
      if (method === "thunderclaw.pairing.requests") return { protocolVersion: 1, requests: [request] };
      if (method === "thunderclaw.devices.list") return { protocolVersion: 1, devices: [device] };
      if (method === "thunderclaw.pairing.approve") return { protocolVersion: 1, approved: true };
      if (method === "thunderclaw.pairing.deny") return { protocolVersion: 1, denied: true };
      if (method === "thunderclaw.devices.revoke") return { protocolVersion: 1, revoked: true };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const program = new Command();
  program.option("--profile <name>");
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerThunderClawCli(program as never, dependencies);
  return {
    program,
    calls,
    signals,
    answers,
    secretAnswers,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    exitCode: () => exitCode,
  };
}

async function parse(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(["node", "openclaw", ...args]);
}

function gatewayError(code: string, message = "failure", name = "GatewayClientRequestError"): Error {
  const error = new Error(message);
  error.name = name;
  Object.defineProperty(error, "gatewayCode", { value: code, enumerable: true });
  return error;
}

test("status and list commands use exact read methods/scopes and deterministic JSON", async () => {
  for (const [args, operation, method, collection] of [
    [["thunderclaw", "status", "--json"], "status", "thunderclaw.pairing.status", "status"],
    [["thunderclaw", "requests", "list", "--json"], "requests.list", "thunderclaw.pairing.requests", "requests"],
    [["thunderclaw", "devices", "list", "--json"], "devices.list", "thunderclaw.devices.list", "devices"],
  ] as const) {
    const value = harness();
    await parse(value.program, [...args]);
    assert.equal(value.exitCode(), 0);
    assert.equal(value.calls.length, 1);
    assert.deepEqual(value.calls[0], { method, params: {}, scopes: ["operator.read"], aborted: false });
    const output = JSON.parse(value.stdout());
    assert.equal(output.cliOutputVersion, 1);
    assert.equal(output.ok, true);
    assert.equal(output.operation, operation);
    assert.equal(output.observedAt, "2026-08-11T23:31:00.000Z");
    assert.ok(Object.hasOwn(output, collection));
    assert.equal(value.stderr(), "");
  }
});

test("human render groups request/device state and sanitizes hostile names", () => {
  const hostileRequest = { ...request, deviceName: "safe\u001b[2J\u202Eeman" };
  const renderedRequests = renderRequestList([
    hostileRequest,
    { ...request, requestId: "request_cli_approved_1234", state: "approved" },
  ], NOW, 80);
  assert.match(renderedRequests, /Pending approval \(1\)/u);
  assert.match(renderedRequests, /Approved — finish in Thunderbird \(1\)/u);
  assert.equal(renderedRequests.includes("\u001b"), false);
  assert.match(renderedRequests, /\\u\{001B\}\[2J\\u\{202E\}eman/u);

  const renderedDevices = renderDeviceList([
    device,
    { ...device, credentialId: "credential_cli_revoked_123", revokedAt: "2026-08-11T23:30:30.000Z" },
    { ...device, credentialId: "credential_cli_expired_123", expiresAt: "2026-08-11T23:30:30.000Z" },
    { ...device, credentialId: "credential_cli_replaced_12", revokedAt: "2026-08-11T23:30:30.000Z", replacedBy: REPLACEMENT_ID },
  ], NOW);
  assert.match(renderedDevices, /1 active, 3 historical/u);
  assert.match(renderedDevices, /Revoked/u);
  assert.match(renderedDevices, /Expired/u);
  assert.match(renderedDevices, /Replaced/u);
  assert.equal(classifyDevice(device, NOW), "Active");

  const ascii = renderRequestList([{ ...request, deviceName: "🦞 Thunderbird" }], NOW, 30, true);
  assert.equal(/[^\x0A\x20-\x7E]/u.test(ascii), false);
  assert.ok((ascii.split("\n").find((line) => line.startsWith("  1."))?.length ?? 31) <= 30);
});

test("guided device history shows the five most recent credentials with an option to view all", async () => {
  const historical = Array.from({ length: 7 }, (_, index) => ({
    ...device,
    credentialId: `credential_history_${String(index).padStart(4, "0")}`,
    deviceName: `Historical ${index}`,
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T23:30:00.000Z`,
    revokedAt: `2026-08-${String(index + 1).padStart(2, "0")}T23:30:00.000Z`,
  })).reverse();
  const value = harness((call) => {
    if (call.method === "thunderclaw.pairing.requests") return { protocolVersion: 1, requests: [] };
    if (call.method === "thunderclaw.devices.list") return { protocolVersion: 1, devices: historical };
    throw new Error("unexpected");
  }, true);
  value.answers.push("h", "q");

  await parse(value.program, ["thunderclaw"]);

  assert.equal(value.exitCode(), 0);
  assert.match(value.stderr(), /Historical credentials \(showing 5 of 7, most recent first\)/u);
  assert.match(value.stderr(), /2 more\. Select \[h\]istory to view all\./u);
  assert.match(value.stderr(), /Historical credentials \(7, most recent first\)/u);
  assert.equal((value.stderr().match(/Historical 0/u) ?? []).length, 1);
  assert.ok(value.stderr().indexOf("Historical 6") < value.stderr().indexOf("Historical 2"));
  assert.equal(value.calls.length, 4);
});

test("human devices list limits history by default and --all expands it", async () => {
  const historical = Array.from({ length: 7 }, (_, index) => ({
    ...device,
    credentialId: `credential_list_${String(index).padStart(7, "0")}`,
    deviceName: `Listed history ${index}`,
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T23:30:00.000Z`,
    revokedAt: `2026-08-${String(index + 1).padStart(2, "0")}T23:30:00.000Z`,
  }));
  const responder = (call: GatewayCall) => {
    if (call.method === "thunderclaw.devices.list") return { protocolVersion: 1, devices: historical };
    throw new Error("unexpected");
  };

  const concise = harness(responder);
  await parse(concise.program, ["thunderclaw", "devices", "list"]);
  assert.match(concise.stderr(), /Historical credentials \(showing 5 of 7, most recent first\)/u);
  assert.match(concise.stderr(), /Run openclaw thunderclaw devices list --all to view all\./u);
  assert.equal(concise.stderr().includes("Listed history 0"), false);

  const complete = harness(responder);
  await parse(complete.program, ["thunderclaw", "devices", "list", "--all"]);
  assert.match(complete.stderr(), /Historical credentials \(7, most recent first\)/u);
  assert.match(complete.stderr(), /Listed history 0/u);
});

test("headless mutations require intent/input before any Gateway call", async () => {
  for (const args of [
    ["thunderclaw", "requests", "approve", REQUEST_ID, "--code-stdin", "--json"],
    ["thunderclaw", "requests", "approve", REQUEST_ID, "--yes", "--json"],
    ["thunderclaw", "requests", "deny", REQUEST_ID, "--json"],
    ["thunderclaw", "devices", "revoke", CREDENTIAL_ID, "--json"],
  ]) {
    const value = harness();
    value.secretAnswers.push("ABCDE-FGHIJ");
    await parse(value.program, args);
    assert.equal(value.exitCode(), 2);
    assert.equal(value.calls.length, 0);
    const output = JSON.parse(value.stdout());
    assert.equal(output.error.code, "INVALID_USAGE");
    assert.equal(output.error.outcome, "not-attempted");
  }
});

test("approval reads the code outside argv, preflights, mutates once, and reconciles with reads", async () => {
  let requestReads = 0;
  const value = harness((call) => {
    if (call.method === "thunderclaw.pairing.requests") {
      requestReads += 1;
      return { protocolVersion: 1, requests: requestReads === 1 ? [request] : [{ ...request, state: "approved" }] };
    }
    if (call.method === "thunderclaw.pairing.approve") return { protocolVersion: 1, approved: true };
    throw new Error("unexpected");
  });
  value.secretAnswers.push("abcde-fghij");
  await parse(value.program, ["thunderclaw", "requests", "approve", REQUEST_ID, "--code-stdin", "--yes", "--json"]);
  assert.equal(value.exitCode(), 0);
  assert.deepEqual(value.calls.map(({ method, scopes }) => [method, scopes]), [
    ["thunderclaw.pairing.requests", ["operator.read"]],
    ["thunderclaw.pairing.approve", ["operator.admin"]],
    ["thunderclaw.pairing.requests", ["operator.read"]],
  ]);
  assert.deepEqual(value.calls[1]?.params, { requestId: REQUEST_ID, approvalCode: "ABCDE-FGHIJ" });
  assert.equal(value.calls.filter(({ method }) => method === "thunderclaw.pairing.approve").length, 1);
  const output = value.stdout();
  assert.equal(output.includes("ABCDE-FGHIJ"), false);
  assert.equal(value.stderr().includes("ABCDE-FGHIJ"), false);
  assert.equal(JSON.parse(output).currentState, "approved");
});

test("denial and revocation submit exact identifiers once with admin scope", async () => {
  let requestReads = 0;
  const denial = harness((call) => {
    if (call.method === "thunderclaw.pairing.requests") {
      requestReads += 1;
      return { protocolVersion: 1, requests: requestReads <= 2 ? [request] : [] };
    }
    return { protocolVersion: 1, denied: true };
  });
  await parse(denial.program, ["thunderclaw", "requests", "deny", REQUEST_ID, "--yes", "--json"]);
  assert.equal(denial.exitCode(), 0);
  assert.equal(denial.calls.filter(({ method }) => method === "thunderclaw.pairing.deny").length, 1);
  assert.deepEqual(denial.calls[2], {
    method: "thunderclaw.pairing.deny", params: { requestId: REQUEST_ID }, scopes: ["operator.admin"], aborted: false,
  });

  let deviceReads = 0;
  const revocation = harness((call) => {
    if (call.method === "thunderclaw.devices.list") {
      deviceReads += 1;
      return { protocolVersion: 1, devices: deviceReads <= 2 ? [device] : [{ ...device, revokedAt: "2026-08-11T23:31:00.000Z" }] };
    }
    return { protocolVersion: 1, revoked: true };
  });
  await parse(revocation.program, ["thunderclaw", "devices", "revoke", CREDENTIAL_ID, "--yes", "--json"]);
  assert.equal(revocation.exitCode(), 0);
  assert.equal(revocation.calls.filter(({ method }) => method === "thunderclaw.devices.revoke").length, 1);
  assert.deepEqual(revocation.calls[2], {
    method: "thunderclaw.devices.revoke", params: { credentialId: CREDENTIAL_ID }, scopes: ["operator.admin"], aborted: false,
  });
});

test("preflight races stop before mutation with selected-record exit status", async () => {
  const value = harness((call) => {
    if (call.method === "thunderclaw.pairing.requests") return { protocolVersion: 1, requests: [] };
    throw new Error("mutation must not run");
  });
  value.secretAnswers.push("ABCDE-FGHIJ");
  await parse(value.program, ["thunderclaw", "requests", "approve", REQUEST_ID, "--code-stdin", "--yes", "--json"]);
  assert.equal(value.exitCode(), 3);
  assert.equal(value.calls.length, 1);
  assert.equal(JSON.parse(value.stdout()).error.code, "SELECTION_CHANGED");
});

test("Gateway conflicts, auth, unavailable, malformed responses, and unknown errors map deterministically", async () => {
  const cases = [
    [gatewayError("PAIRING_CONFLICT", "secret backend detail"), 4, "PAIRING_CONFLICT"],
    [gatewayError("FORBIDDEN", "missing scope: operator.admin"), 5, "FORBIDDEN"],
    [gatewayError("PAIRING_UNAVAILABLE", "sqlite path secret"), 6, "PAIRING_UNAVAILABLE"],
    [null, 70, "INVALID_GATEWAY_RESPONSE"],
    [new Error("credential=secret"), 70, "INTERNAL_ERROR"],
  ] as const;
  for (const [failure, exitCode, code] of cases) {
    const value = harness((call) => {
      if (call.method === "thunderclaw.pairing.status") {
        if (failure === null) return { protocolVersion: 1, available: true, verifier: "secret" };
        throw failure;
      }
      throw new Error("unexpected");
    });
    await parse(value.program, ["thunderclaw", "status", "--json"]);
    assert.equal(value.exitCode(), exitCode);
    const output = JSON.parse(value.stdout());
    assert.equal(output.error.code, code);
    assert.equal(value.stdout().includes("sqlite path"), false);
    assert.equal(value.stdout().includes("credential=secret"), false);
  }
});

test("pinned Gateway auth transport failures map to exit 5 without exposing close reasons", async () => {
  for (const failure of [
    Object.assign(new Error("closed (1008): unauthorized token=secret"), { name: "GatewayTransportError", kind: "closed", code: 1008, reason: "AUTH_REQUIRED token=secret" }),
    gatewayError("AUTH_REQUIRED", "auth details secret"),
    gatewayError("UNAUTHORIZED", "auth details secret"),
  ]) {
    const value = harness(() => { throw failure; });
    await parse(value.program, ["thunderclaw", "status", "--json"]);
    assert.equal(value.exitCode(), 5);
    assert.equal(JSON.parse(value.stdout()).error.code === "AUTH_REQUIRED" || JSON.parse(value.stdout()).error.code === "UNAUTHORIZED"
      || JSON.parse(value.stdout()).error.code === "AUTH_UNAUTHORIZED", true);
    assert.equal(value.stdout().includes("secret"), false);
    assert.equal(value.stderr(), "");
  }
});

test("lost mutation response is not retried and reports read-only reconciliation", async () => {
  let requestReads = 0;
  const value = harness((call) => {
    if (call.method === "thunderclaw.pairing.requests") {
      requestReads += 1;
      return { protocolVersion: 1, requests: requestReads === 1 ? [request] : [{ ...request, state: "approved" }] };
    }
    if (call.method === "thunderclaw.pairing.approve") {
      const error = new Error("gateway timeout secret=token");
      error.name = "GatewayTransportError";
      Object.defineProperty(error, "kind", { value: "timeout" });
      throw error;
    }
    throw new Error("unexpected");
  });
  value.secretAnswers.push("ABCDE-FGHIJ");
  await parse(value.program, ["thunderclaw", "requests", "approve", REQUEST_ID, "--code-stdin", "--yes", "--json"]);
  assert.equal(value.exitCode(), 6);
  assert.equal(value.calls.filter(({ method }) => method === "thunderclaw.pairing.approve").length, 1);
  const output = JSON.parse(value.stdout());
  assert.equal(output.error.code, "GATEWAY_TIMEOUT");
  assert.equal(output.error.outcome, "unknown");
  assert.equal(output.error.reconciliation, "request-approved");
  assert.equal(value.stdout().includes("token"), false);
  assert.equal(value.stdout().includes("ABCDE"), false);
  assert.notEqual(value.signals[1], value.signals[2], "reconciliation must use a fresh bounded signal");
});

test("pairing conflicts reconcile exactly once with a fresh read-only signal", async () => {
  let reads = 0;
  const value = harness((call) => {
    if (call.method === "thunderclaw.pairing.requests") {
      reads += 1;
      return { protocolVersion: 1, requests: reads === 1 ? [request] : [{ ...request, state: "approved" }] };
    }
    if (call.method === "thunderclaw.pairing.approve") throw gatewayError("PAIRING_CONFLICT", "wrong code secret");
    throw new Error("unexpected");
  });
  value.secretAnswers.push("ABCDE-FGHIJ");
  await parse(value.program, ["thunderclaw", "requests", "approve", REQUEST_ID, "--code-stdin", "--yes", "--json"]);
  assert.equal(value.exitCode(), 4);
  assert.equal(value.calls.filter(({ method }) => method === "thunderclaw.pairing.approve").length, 1);
  assert.equal(value.calls.filter(({ method }) => method === "thunderclaw.pairing.requests").length, 2);
  assert.notEqual(value.signals[1], value.signals[2]);
  const output = JSON.parse(value.stdout());
  assert.equal(output.error.reconciliation, "request-approved");
  assert.match(output.error.message, /fresh read shows the request approved/u);
});

test("human mutation failures explain the fresh reconciliation result", async () => {
  let reads = 0;
  const value = harness((call) => {
    if (call.method === "thunderclaw.pairing.requests") {
      reads += 1;
      return { protocolVersion: 1, requests: reads === 1 ? [request] : [{ ...request, state: "approved" }] };
    }
    const error = new Error("gateway closed after send");
    error.name = "GatewayTransportError";
    Object.assign(error, { kind: "closed", code: 1006 });
    throw error;
  });
  value.secretAnswers.push("ABCDE-FGHIJ");
  await parse(value.program, ["thunderclaw", "requests", "approve", REQUEST_ID, "--code-stdin", "--yes"]);
  assert.equal(value.exitCode(), 6);
  assert.match(value.stderr(), /mutation was not retried/u);
  assert.match(value.stderr(), /fresh read shows the request approved/u);
  assert.equal(value.stdout(), "");
});

test("Commander usage failures use exit 2 and stable JSON when requested", async () => {
  for (const args of [
    ["thunderclaw", "requests", "approve", "--code-stdin", "--yes", "--json"],
    ["thunderclaw", "requests", "deny", REQUEST_ID, "extra", "--yes", "--json"],
    ["thunderclaw", "devices", "unknown", "--json"],
    ["thunderclaw", "status", "--unknown", "--json"],
  ]) {
    const value = harness();
    await assert.rejects(() => parse(value.program, args), (error: unknown) => {
      return error instanceof Error && error.name === "CommanderError"
        && (error as Error & { exitCode?: number }).exitCode === 2;
    });
    assert.equal(value.exitCode(), 2);
    assert.equal(value.calls.length, 0);
    assert.equal(value.stderr(), "");
    const output = JSON.parse(value.stdout());
    assert.equal(output.cliOutputVersion, 1);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "INVALID_USAGE");
  }
});

test("Commander failures attribute operations after root option values", async () => {
  const value = harness();
  await assert.rejects(
    () => parse(value.program, ["--profile", "thunderclaw", "thunderclaw", "status", "--bogus", "--json"]),
    (error: unknown) => error instanceof Error && error.name === "CommanderError",
  );
  assert.equal(value.exitCode(), 2);
  assert.equal(value.calls.length, 0);
  assert.equal(JSON.parse(value.stdout()).operation, "status");
});

test("an interrupted interactive manager stops without another refresh", async () => {
  const interrupted = new Error("Interrupted");
  interrupted.name = "AbortError";
  const value = harness(undefined, true);
  value.answers.push("n", interrupted);
  await parse(value.program, ["thunderclaw"]);
  assert.equal(value.exitCode(), 130);
  assert.equal(value.calls.length, 2);
  assert.match(value.stderr(), /Interrupted/u);
});

test("non-TTY manager exits with usage status instead of waiting", async () => {
  const value = harness();
  await parse(value.program, ["thunderclaw"]);
  assert.equal(value.exitCode(), 2);
  assert.equal(value.calls.length, 0);
  assert.match(value.stderr(), /explicit subcommand/u);
  assert.equal(value.stdout(), "");
});

test("incomplete command groups exit with usage status without Gateway calls", async () => {
  for (const args of [["thunderclaw", "requests"], ["thunderclaw", "devices"]]) {
    const value = harness();
    await parse(value.program, args);
    assert.equal(value.exitCode(), 2);
    assert.equal(value.calls.length, 0);
    assert.match(value.stderr(), /subcommand/u);
  }
});

test("interactive manager binds numbered snapshot rows to exact IDs and defaults destructive confirmation to No", async () => {
  const value = harness(undefined, true);
  value.answers.push("y", "d", "", "n", "q");
  await parse(value.program, ["thunderclaw"]);
  assert.equal(value.exitCode(), 0);
  assert.equal(value.calls.some(({ method }) => method === "thunderclaw.pairing.deny"), false);
  assert.match(value.stderr(), new RegExp(REQUEST_ID, "u"));
  assert.match(value.stderr(), /No changes made\./u);
});
