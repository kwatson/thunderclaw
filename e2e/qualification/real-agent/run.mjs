import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const qualificationRoot = join(root, "e2e/qualification/real-agent");
const richComposeRoot = join(root, "e2e/thunderbird/rich-compose");
const configPath = join(root, ".spike/thunderclaw-openclaw/openclaw.json");
const soulPath = join(root, ".spike/thunderclaw-openclaw/workspace/SOUL.md");
const memoryPath = join(root, ".spike/thunderclaw-openclaw/workspace/MEMORY.md");
let xpiPath;
let gatewayOrigin;
const proxyName = "thunderclaw-real-agent-proxy";
const relayPort = 18790;
let expectedXpiSha256;
const coreCaseSuffixes = [
  ...["ul", "ol"].flatMap((kind) => ["rewrite", "add", "remove", "reorder"].map((operation) => `${kind}-${operation}`)),
  ...["body", "selection", "header", "attachment"].map((value) => `stale-${value}`),
  "newer-edit-undo",
];
const originSuffixes = ["origin-new", "origin-reply", "origin-forward-inline", "origin-reopened-draft"];
const allowedSuffixes = [...coreCaseSuffixes, ...originSuffixes, "probe-reopened-whitespace"];
const hash = (value) => createHash("sha256").update(value).digest("hex");

function command(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", env: options.env ?? process.env });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout?.trim() ?? "";
}

function validateGatewayOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("THUNDERCLAW_QUALIFICATION_GATEWAY_ORIGIN must be a valid URL origin"); }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value.replace(/\/$/u, "")) {
    throw new Error("THUNDERCLAW_QUALIFICATION_GATEWAY_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function resolveGatewayOrigin() {
  const configured = process.env.THUNDERCLAW_QUALIFICATION_GATEWAY_ORIGIN;
  if (configured) return validateGatewayOrigin(configured);
  const binding = command("docker", ["compose", "-f", "compose.spike.yaml", "port", "gateway", "18789"], { capture: true })
    .split("\n").find(Boolean);
  if (!binding) throw new Error("Docker Compose did not report the published Gateway port");
  const separator = binding.lastIndexOf(":");
  if (separator < 1) throw new Error("Docker Compose reported an invalid Gateway port binding");
  const rawHost = binding.slice(0, separator).replace(/^\[|\]$/gu, "");
  const port = binding.slice(separator + 1);
  if (!/^\d+$/u.test(port)) throw new Error("Docker Compose reported an invalid Gateway port");
  const host = rawHost.includes(":") ? `[${rawHost}]` : rawHost;
  return validateGatewayOrigin(`http://${host}:${port}`);
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function jsonLines(path) { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
async function atomicWrite(path, data) {
  const temporary = `${path}.qualification-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}

async function gatewayCall(token, path, body) {
  if (!gatewayOrigin) throw new Error("Gateway origin has not been resolved");
  const response = await fetch(`${gatewayOrigin}/thunderclaw/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Gateway qualification call failed (${response.status})`);
  return value;
}

async function waitForGateway(token) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { const status = await gatewayCall(token, "/status"); if (status.plugin === "thunderclaw") return status; } catch {}
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("Gateway did not become ready");
}

function operatorCall(method, params) {
  const output = command("docker", ["compose", "-f", "compose.spike.yaml", "exec", "-T", "gateway",
    "node", "openclaw.mjs", "gateway", "call", method, "--json", "--params", JSON.stringify(params)], { capture: true });
  return JSON.parse(output);
}

async function pairQualificationDevice(origin) {
  const requestId = randomBytes(24).toString("base64url");
  const deviceId = randomBytes(24).toString("base64url");
  const credentialId = randomBytes(24).toString("base64url");
  const credential = `${credentialId}.${randomBytes(32).toString("base64url")}`;
  const claimCredential = `${requestId}.${randomBytes(32).toString("base64url")}`;
  const verifier = (domain, value) => hash(`${domain}\0${value}`);
  const response = await fetch(`${origin}/thunderclaw/pairing/v1/requests`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({
      protocolVersion: 1, requestId, deviceId, deviceName: "ThunderClaw real-agent qualification",
      credentialId, credentialVerifier: verifier("thunderclaw-device-credential-v1", credential),
      claimVerifier: verifier("thunderclaw-pairing-claim-v1", claimCredential),
    }) });
  const issued = await response.json();
  assert(response.status === 201 && issued.requestId === requestId && typeof issued.approvalCode === "string",
    "qualification pairing request failed");
  operatorCall("thunderclaw.pairing.approve", { requestId, approvalCode: issued.approvalCode });
  const claim = await fetch(`${origin}/thunderclaw/pairing/v1/claim`, { method: "POST", redirect: "manual",
    headers: { authorization: `Bearer ${claimCredential}`, accept: "application/json" } });
  const claimed = await claim.json();
  assert(claim.status === 200 && claimed.device?.credentialId === credentialId, "qualification pairing claim failed");
  return { credential, credentialId };
}

function xpiEntries(path) {
  const names = command("unzip", ["-Z1", path], { capture: true }).split("\n").filter((name) => name && !name.endsWith("/")).sort();
  return Object.fromEntries(names.map((name) => [name, hash(spawnSync("unzip", ["-p", path, name], { cwd: root, encoding: null }).stdout)]));
}

function assert(value, message) { if (!value) throw new Error(message); }

async function scanArtifacts(artifacts, secrets) {
  const files = command("find", [artifacts, "-type", "f", "-print"], { capture: true }).split("\n").filter(Boolean);
  const forbiddenPatterns = [/authorization\s*:/iu, /bearer\s+[A-Za-z0-9._~+/-]+/iu, /THUNDERCLAW_PLUGIN_TOKEN\s*=/u, /DEEPSEEK_API_KEY\s*=/u];
  for (const file of files) {
    const bytes = await readFile(file);
    for (const secret of secrets) assert(!secret || !bytes.includes(Buffer.from(secret)), `secret material found in ${file}`);
    if (file.endsWith(".xpi")) continue;
    const text = bytes.toString("utf8");
    for (const pattern of forbiddenPatterns) assert(!pattern.test(text), `credential-shaped content found in ${file}`);
  }
  return files;
}

async function reconcile(artifacts, metadata, secrets) {
  const result = JSON.parse(await readFile(join(artifacts, "aggregate-result.json"), "utf8"));
  assert(result.status === "passed", `Thunderbird result failed: ${result.error ?? "unknown"}`);
  assert(result.cases.length === 8 && result.stale.length === 4 && result.newerEditUndo?.newerEditRetained, "result matrix is incomplete");
  const relay = await jsonLines(join(artifacts, "relay.jsonl"));
  const transforms = relay.filter((record) => record.path === "/thunderclaw/v1/compose/transform");
  const acceptedTransforms = transforms.filter((record) => record.status === 200);
  const rejectedTransforms = transforms.filter((record) => record.status === 400);
  const trialResults = [...result.cases, ...result.stale, result.newerEditUndo];
  const expectedAttempts = trialResults.reduce((sum, entry) => sum + entry.attempts, 0);
  assert(acceptedTransforms.length === 13 && transforms.length === expectedAttempts
    && rejectedTransforms.length === expectedAttempts - 13, `transform acceptance/retry ledger mismatch`);
  const expectedOutputs = [
    ...result.cases.map((entry) => entry.replacementItems),
    ...result.stale.map(() => null),
    result.newerEditUndo.replacementItems,
  ];
  for (const [index, record] of acceptedTransforms.entries()) {
    assert(record.method === "POST" && record.status === 200, `transform ${index} route failed`);
    const request = record.request; const response = record.response;
    assert(request.agentId === "deepseek-flash" && request.target.selectionShape === "flat-list-items", `transform ${index} agent/shape mismatch`);
    assert(request.target.items.join("\n") === request.target.text && request.target.items.length === 3, `transform ${index} target mismatch`);
    assert(request.document.contextHashMatches && request.targetHashMatches, `transform ${index} independent hash mismatch`);
    assert(response.runId === request.runId && response.requestId === request.requestId
      && response.composeGeneration === request.composeGeneration && response.contextHash === request.contextHash
      && response.targetHash === request.targetHash, `transform ${index} response identities mismatch`);
    assert(response.operation?.type === "replace_flat_list_items" && response.operation.targetId === request.target.targetId,
      `transform ${index} operation mismatch`);
    assert(response.provider === "deepseek" && response.model === "deepseek-v4-flash"
      && response.runtimeSessionMarkerPresent && typeof response.runtimeSessionMarkerSha256 === "string",
      `transform ${index} provider evidence mismatch`);
    assert(response.toolSummaryPresent === false || typeof response.toolSummarySha256 === "string", `transform ${index} tool summary evidence invalid`);
    assert(response.toolCallCount === 0 && response.toolNameCount === 0, `transform ${index} exposed model-callable tools`);
    assert(Array.isArray(response.operation.items) && response.operation.items.length >= 1 && response.operation.items.length <= 100
      && response.operation.items.every((item) => typeof item === "string" && item.trim().length > 0
        && !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(item)), `transform ${index} returned unsafe items`);
    if (expectedOutputs[index]) assert(JSON.stringify(response.operation.items) === JSON.stringify(expectedOutputs[index]), `transform ${index} output mismatch`);
  }
  for (const [index, record] of rejectedTransforms.entries()) {
    assert(record.method === "POST" && record.status === 400 && record.request?.agentId === "deepseek-flash"
      && record.request?.target?.selectionShape === "flat-list-items" && record.response?.operation == null
      && record.response?.errorCode === "INVALID_AGENT_OUTPUT",
      `rejected transform ${index} did not fail closed`);
  }
  assert(new Set(transforms.map((record) => record.request.requestId)).size === transforms.length, "transform request IDs are not unique");
  assert(new Set(transforms.map((record) => record.request.runId)).size === transforms.length, "transform run IDs are not unique");

  const provider = await jsonLines(join(artifacts, "provider.jsonl"));
  const modelRecords = provider.filter((record) => record.qualificationNoncePresent);
  assert(modelRecords.length >= transforms.length && modelRecords.length <= transforms.length * 2, `unexpected provider model-call count ${modelRecords.length}`);
  const expectedNonceHashes = coreCaseSuffixes.map((suffix) => hash(`${metadata.qualificationNonce}-${suffix}`));
  for (const [index, nonceHash] of expectedNonceHashes.entries()) {
    const matches = modelRecords.filter((record) => record.caseNonceSha256 === nonceHash);
    const attempts = trialResults[index].attempts;
    assert(matches.filter((record) => record.roles.length === 2).length === attempts
      && matches.length >= attempts && matches.length <= attempts * 3, `provider evidence missing or over-repaired case ${nonceHash}`);
  }
  for (const [index, record] of acceptedTransforms.entries()) {
    const matches = modelRecords.filter((entry) => entry.caseNonceSha256 === expectedNonceHashes[index]);
    const finalStart = matches.map((entry) => entry.roles.length).lastIndexOf(2);
    const finalAttemptCalls = matches.slice(finalStart);
    assert(record.response.repairAttempted === (finalAttemptCalls.length > 1), `transform ${index} repair evidence mismatch`);
  }
  for (const record of provider) {
    assert(record.model === "deepseek-v4-flash" && record.upstreamStatus === 200, "provider model/status mismatch");
    assert(record.toolsFieldPresent === false && record.toolCount === 0 && record.toolChoiceFieldPresent === false, "provider tools were exposed");
    assert(typeof record.personalityCanaryPresent === "boolean" && typeof record.memoryCanaryPresent === "boolean",
      "provider personality/memory observation is missing");
  }
  assert(new Set(provider.map((record) => record.requestSha256)).size === provider.length, "provider request digests are not unique");
  assert(new Set(provider.map((record) => record.responseSha256)).size === provider.length, "provider response digests are not unique");

  const retainedMime = [];
  for (const entry of result.cases) {
    for (const [artifactKey, digestKey] of [["draftArtifact", "draftSha256"], ["smtpArtifact", "smtpSha256"]]) {
      const name = entry.persistence[artifactKey];
      assert(name === (artifactKey === "draftArtifact" ? "draft.eml" : "smtp.eml"), `unexpected retained MIME name ${name}`);
      const file = join(artifacts, "trials", `${entry.kind}-${entry.operation}`, name);
      assert(await exists(file) && hash(await readFile(file)) === entry.persistence[digestKey], `retained MIME digest mismatch ${file}`);
      retainedMime.push(file);
    }
  }
  assert(retainedMime.length === 16, "retained MIME matrix is incomplete");
  const files = await scanArtifacts(artifacts, secrets);
  const summary = {
    status: "passed",
    xpiSha256: expectedXpiSha256,
    matrix: { operations: 8, staleApply: 4, newerEditUndo: 1, draftReopen: 8, smtpMime: 8 },
    transforms: { accepted: acceptedTransforms.length, rejectedFailClosed: rejectedTransforms.length },
    providerCalls: provider.length,
    providerRepairs: modelRecords.filter((record) => record.roles.length > 2).length,
    retainedMime: { drafts: 8, smtp: 8, digestVerified: true, secretScanned: true },
    secretScan: { files: files.length, passed: true },
    metadata: { ...metadata, qualificationNonce: undefined },
  };
  await writeFile(join(artifacts, "qualification-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

async function reconcileOrigins(artifacts, metadata, secrets, trials) {
  assert(trials.length === originSuffixes.length
    && JSON.stringify(trials.map((trial) => trial.trial)) === JSON.stringify(originSuffixes),
  "origin trial matrix is incomplete");
  for (const trial of trials) {
    const value = trial.trialResult;
    assert(value.origin === trial.trial.slice("origin-".length) && value.previewNonmutation
      && value.applyExact && value.undoExact && value.redoExact,
    `origin trial ${trial.trial} did not pass exact editor gates`);
    assert(Array.isArray(value.replacementItems) && value.replacementItems.length === 3,
      `origin trial ${trial.trial} returned an invalid replacement`);
  }
  const relay = await jsonLines(join(artifacts, "relay.jsonl"));
  const transforms = relay.filter((record) => record.path === "/thunderclaw/v1/compose/transform");
  const expectedAttempts = trials.reduce((sum, trial) => sum + trial.trialResult.attempts, 0);
  assert(transforms.length === expectedAttempts && transforms.filter((record) => record.status === 200).length === 4,
    "origin transform/retry ledger mismatch");
  for (const [index, record] of transforms.filter((entry) => entry.status === 200).entries()) {
    const request = record.request; const response = record.response;
    assert(request.agentId === "deepseek-flash" && request.target.selectionShape === "flat-list-items"
      && request.target.items.join("\n") === request.target.text && request.document.contextHashMatches
      && request.targetHashMatches, `origin transform ${index} request mismatch`);
    assert(response.requestId === request.requestId && response.runId === request.runId
      && response.composeGeneration === request.composeGeneration && response.contextHash === request.contextHash
      && response.targetHash === request.targetHash && response.provider === "deepseek"
      && response.model === "deepseek-v4-flash" && response.toolCallCount === 0 && response.toolNameCount === 0
      && response.operation?.type === "replace_flat_list_items"
      && JSON.stringify(response.operation.items) === JSON.stringify(trials[index].trialResult.replacementItems),
    `origin transform ${index} response mismatch`);
  }
  const provider = await jsonLines(join(artifacts, "provider.jsonl"));
  const modelRecords = provider.filter((record) => record.qualificationNoncePresent);
  for (const [index, suffix] of originSuffixes.entries()) {
    const matches = modelRecords.filter((record) => record.caseNonceSha256 === hash(`${metadata.qualificationNonce}-${suffix}`));
    const attempts = trials[index].trialResult.attempts;
    assert(matches.filter((record) => record.roles.length === 2).length === attempts
      && matches.length >= attempts && matches.length <= attempts * 3,
    `origin provider evidence mismatch for ${suffix}`);
  }
  assert(provider.every((record) => record.model === "deepseek-v4-flash" && record.upstreamStatus === 200
    && !record.toolsFieldPresent && record.toolCount === 0 && !record.toolChoiceFieldPresent),
  "origin provider calls were not exact restricted DeepSeek Flash calls");
  const files = await scanArtifacts(artifacts, secrets);
  const summary = { status: "passed", xpiSha256: expectedXpiSha256,
    matrix: { origins: originSuffixes.map((suffix) => suffix.slice("origin-".length)), operations: 4 },
    transforms: transforms.length, providerCalls: provider.length,
    secretScan: { files: files.length, passed: true },
    metadata: { ...metadata, qualificationNonce: undefined } };
  await writeFile(join(artifacts, "origin-qualification-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

async function main() {
  const releaseComponent = process.env.THUNDERCLAW_QUALIFICATION_COMPONENT;
  const candidatePlugin = process.env.THUNDERCLAW_OPENCLAW_PLUGIN_TGZ;
  const candidateXpi = process.env.THUNDERCLAW_E2E_XPI;
  assert(["openclaw-plugin", "thunderbird-extension"].includes(releaseComponent),
    "THUNDERCLAW_QUALIFICATION_COMPONENT must be openclaw-plugin or thunderbird-extension");
  assert(candidatePlugin, "THUNDERCLAW_OPENCLAW_PLUGIN_TGZ must name the exact candidate plugin archive");
  assert(candidateXpi, "THUNDERCLAW_E2E_XPI must name the exact counterpart XPI");
  const pluginPath = resolve(candidatePlugin);
  const currentXpi = resolve(candidateXpi);
  if (releaseComponent === "openclaw-plugin") {
    command("mise", ["exec", "--", "node", "scripts/validate-candidate-artifact.mjs", "plugin-tgz", pluginPath], { capture: true });
    command("mise", ["exec", "--", "node", "scripts/verify-counterpart-baseline.mjs",
      "--for-component", "openclaw-plugin", "--artifact", currentXpi], { capture: true });
  } else {
    command("mise", ["exec", "--", "node", "scripts/verify-counterpart-baseline.mjs",
      "--for-component", "thunderbird-extension", "--artifact", pluginPath], { capture: true });
    command("mise", ["exec", "--", "node", "scripts/validate-candidate-artifact.mjs", "xpi", currentXpi], { capture: true });
  }
  gatewayOrigin = resolveGatewayOrigin();
  const selectedSuffixes = process.env.THUNDERCLAW_QUALIFICATION_TRIALS
    ? process.env.THUNDERCLAW_QUALIFICATION_TRIALS.split(",").filter((suffix) => allowedSuffixes.includes(suffix))
    : coreCaseSuffixes;
  assert(selectedSuffixes.length > 0, "no valid qualification trials selected");
  const runId = `qualification-${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const artifacts = join(root, "build/e2e/product-real-agent/153.0.3", runId);
  await mkdir(artifacts, { recursive: false, mode: 0o700 });
  const temporary = await mkdtemp(join(tmpdir(), "thunderclaw-real-agent-"));
  const originalConfig = await readFile(configPath, "utf8");
  const config = JSON.parse(originalConfig);
  const initialDevices = operatorCall("thunderclaw.devices.list", {}).devices;
  assert(Array.isArray(initialDevices), "could not snapshot pre-qualification devices");
  const initialCredentialIds = new Set(initialDevices.map((device) => device.credentialId));
  const qualificationDevice = await pairQualificationDevice(gatewayOrigin);
  const token = qualificationDevice.credential;
  const envText = await readFile(join(root, ".env.openclaw.local"), "utf8");
  const environmentSecrets = envText.split(/\r?\n/u).map((line) => line.slice(line.indexOf("=") + 1)).filter(Boolean);
  const secrets = [token, ...environmentSecrets];
  const qualificationNonce = randomBytes(16).toString("hex");
  let relay;
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    if (relay) { relay.kill("SIGTERM"); await new Promise((done) => relay.once("exit", done)); }
    try { command("docker", ["rm", "-f", proxyName], { capture: true }); } catch {}
    await atomicWrite(configPath, originalConfig);
    command("docker", ["compose", "-f", "compose.spike.yaml", "restart", "gateway"]);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    void restore().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
  });
  try {
    assert(config.models.providers.deepseek.baseUrl !== `http://${proxyName}:18888`, "stale qualification provider override requires recovery");
    xpiPath = join(artifacts, "candidate.xpi");
    await copyFile(currentXpi, xpiPath);
    expectedXpiSha256 = hash(await readFile(xpiPath));
    assert(JSON.stringify(xpiEntries(xpiPath)) === JSON.stringify(xpiEntries(currentXpi)), "qualified XPI copy is not exact");

    config.models.providers.deepseek.baseUrl = `http://${proxyName}:18888`;
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
    command("docker", ["rm", "-f", proxyName], { capture: true });
  } catch (error) {
    if (!String(error).includes("docker failed")) throw error;
  }
  try {
    command("docker", ["run", "-d", "--name", proxyName, "--init", "--network", "thunderclaw-spike_default",
      "--user", `${process.getuid()}:${process.getgid()}`, "--env-file", ".env.openclaw.local",
      "--env", "THUNDERCLAW_PROVIDER_EVIDENCE=/evidence/provider.jsonl",
      "--env", `THUNDERCLAW_QUALIFICATION_NONCE=${qualificationNonce}`,
      "--env", `THUNDERCLAW_CASE_SUFFIXES=${allowedSuffixes.join(",")}`,
      "--mount", `type=bind,src=${join(qualificationRoot, "provider-proxy.mjs")},dst=/app/proxy.mjs,readonly`,
      "--mount", `type=bind,src=${artifacts},dst=/evidence`, "node:24.19.0-alpine", "node", "/app/proxy.mjs"], { capture: true });
    command("docker", ["compose", "-f", "compose.spike.yaml", "restart", "gateway"]);
    const status = await waitForGateway(token);
    assert(status.gatewayVersion === "2026.8.1" && status.capabilities?.flatListItemReplacement === true
      && status.capabilities?.toolsDisabled === true, "Gateway status capability mismatch");
    const probeRequest = { protocolVersion: 1, requestId: randomUUID(), probeRunId: randomUUID(), agentId: "deepseek-flash" };
    await gatewayCall(token, "/agents/probe", probeRequest);
    const agentsResponse = await gatewayCall(token, `/agents?requestId=${randomUUID()}`);
    const agent = agentsResponse.agents.find((candidate) => candidate.agentId === "deepseek-flash");
    assert(agent?.compatibility?.state === "verified" && agent.provider === "deepseek" && agent.model === "deepseek-v4-flash"
      && agent.compatibility.lastProbe?.observedProvider === "deepseek"
      && agent.compatibility.lastProbe?.observedModel === "deepseek-v4-flash", "deepseek-flash verification mismatch");

    relay = spawn("mise", ["exec", "--", "node", join(qualificationRoot, "loopback-relay.mjs")], {
      cwd: root, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env,
        THUNDERCLAW_RELAY_UPSTREAM: gatewayOrigin, THUNDERCLAW_RELAY_PORT: String(relayPort),
        THUNDERCLAW_RELAY_EVIDENCE: join(artifacts, "relay.jsonl"), THUNDERCLAW_RELAY_AUTO_APPROVE: "1" },
    });
    await new Promise((done) => setTimeout(done, 500));
    const imageId = command("docker", ["image", "inspect", "thunderclaw-thunderbird-e2e:153.0.3", "--format", "{{.Id}}"], { capture: true });
    const providerProxyImageId = command("docker", ["image", "inspect", "node:24.19.0-alpine", "--format", "{{.Id}}"], { capture: true });
    const providerProxyContainerImageId = command("docker", ["inspect", proxyName, "--format", "{{.Image}}"], { capture: true });
    assert(providerProxyContainerImageId === providerProxyImageId, "provider proxy is not using the inspected immutable image");
    const providerProxyRepoDigests = command("docker", ["image", "inspect", "node:24.19.0-alpine", "--format", "{{json .RepoDigests}}"], { capture: true });
    const parsedProviderProxyRepoDigests = JSON.parse(providerProxyRepoDigests);
    assert(Array.isArray(parsedProviderProxyRepoDigests) && parsedProviderProxyRepoDigests.length > 0,
      "provider proxy image has no immutable repository digest");
    const gatewayImageId = command("docker", ["image", "inspect", "ghcr.io/openclaw/openclaw:2026.8.1", "--format", "{{.Id}}"], { capture: true });
    const gatewayContainerImageId = command("docker", ["inspect", "thunderclaw-spike-gateway-1", "--format", "{{.Image}}"], { capture: true });
    assert(gatewayContainerImageId === gatewayImageId, "Gateway container is not using the pinned immutable image");
    const gatewayRepoDigests = command("docker", ["image", "inspect", "ghcr.io/openclaw/openclaw:2026.8.1", "--format", "{{json .RepoDigests}}"], { capture: true });
    const pluginArchiveSha256 = hash(await readFile(pluginPath));
    const pluginList = JSON.parse(command("docker", ["compose", "-f", "compose.spike.yaml", "exec", "-T", "gateway",
      "node", "openclaw.mjs", "plugins", "list", "--json"], { capture: true }));
    const installedPlugin = pluginList.plugins?.find((plugin) => plugin.id === "thunderclaw" && plugin.status === "loaded");
    const containerStateRoot = "/home/node/.openclaw/";
    assert(typeof installedPlugin?.rootDir === "string" && installedPlugin.rootDir.startsWith(containerStateRoot),
      "OpenClaw did not report a safe installed ThunderClaw root");
    const installedPluginRoot = join(root, ".spike/thunderclaw-openclaw", installedPlugin.rootDir.slice(containerStateRoot.length));
    const installedPluginSha256 = hash(await readFile(join(installedPluginRoot, "dist/src/route.js")));
    const unpackedPlugin = join(temporary, "plugin");
    await mkdir(unpackedPlugin);
    command("tar", ["-xzf", pluginPath, "-C", unpackedPlugin]);
    command("diff", ["-qr", join(unpackedPlugin, "package/dist"), join(installedPluginRoot, "dist")], { capture: true });
    const metadata = { runId, startedAt: new Date().toISOString(), qualificationNonce, status,
      agent: { agentId: agent.agentId, provider: agent.provider, model: agent.model,
        compatibilityState: agent.compatibility.state, observedProvider: agent.compatibility.lastProbe.observedProvider,
        observedModel: agent.compatibility.lastProbe.observedModel }, imageId, pluginArchiveSha256, installedPluginSha256,
      xpiSha256: expectedXpiSha256, gatewayImageId, gatewayRepoDigests,
      providerProxyImageId, providerProxyRepoDigests: parsedProviderProxyRepoDigests,
      runnerSha256: hash(await readFile(join(qualificationRoot, "run.mjs"))),
      comparatorSha256: hash(await readFile(join(qualificationRoot, "run.mjs"))),
      harnessSha256: hash(await readFile(join(qualificationRoot, "qualification.py"))),
      relaySha256: hash(await readFile(join(qualificationRoot, "loopback-relay.mjs"))),
      providerProxySha256: hash(await readFile(join(qualificationRoot, "provider-proxy.mjs"))) };
    const dockerArgs = ["run", "--rm", "--init", "--shm-size=1g", "--network", "host",
      "--user", `${process.getuid()}:${process.getgid()}`, "--entrypoint", "xvfb-run",
      "--env", "HOME=/tmp/thunderclaw-real-agent-home",
      "--mount", `type=bind,src=${xpiPath},dst=/work/product.xpi,readonly`,
      "--mount", `type=bind,src=${join(qualificationRoot, "qualification.py")},dst=/work/product-real-agent-qualification.py,readonly`,
      "--mount", `type=bind,src=${join(qualificationRoot, "product_whole_list.py")},dst=/work/product_whole_list_live.py,readonly`,
      "--mount", `type=bind,src=${join(richComposeRoot, "live-thunderbird.py")},dst=/work/live_thunderbird.py,readonly`,
      "--mount", `type=bind,src=${artifacts},dst=/work/artifacts`, "thunderclaw-thunderbird-e2e:153.0.3",
      "-a", "-s", "-screen 0 1440x1000x24 -nolisten tcp", "python3", "/work/product-real-agent-qualification.py",
      "--xpi", "/work/product.xpi"];
    const trialResults = [];
    for (const [trialIndex, suffix] of selectedSuffixes.entries()) {
      if (trialIndex > 0 && trialIndex % 8 === 0) {
        command("docker", ["compose", "-f", "compose.spike.yaml", "restart", "gateway"]);
        await waitForGateway(token);
      }
      const trialArtifacts = `/work/artifacts/trials/${suffix}`;
      command("docker", [...dockerArgs, "--artifacts", trialArtifacts, "--gateway-port", String(relayPort),
        "--nonce", qualificationNonce, "--trial", suffix]);
      const trial = JSON.parse(await readFile(join(artifacts, "trials", suffix, "result.json"), "utf8"));
      assert(trial.status === "passed" && trial.trial === suffix, `fresh-profile trial ${suffix} failed`);
      trialResults.push(trial);
    }
    if (JSON.stringify(selectedSuffixes) === JSON.stringify(originSuffixes)) {
      const summary = await reconcileOrigins(artifacts, metadata, secrets, trialResults);
      console.log(JSON.stringify({ status: summary.status, artifacts, matrix: summary.matrix }));
      return;
    }
    if (selectedSuffixes.length !== coreCaseSuffixes.length
      || JSON.stringify(selectedSuffixes) !== JSON.stringify(coreCaseSuffixes)) {
      await writeFile(join(artifacts, "diagnostic-result.json"), `${JSON.stringify({ status: "passed",
        trials: trialResults.map((trial) => trial.trial) }, null, 2)}\n`, { mode: 0o600 });
      await scanArtifacts(artifacts, secrets);
      console.log(JSON.stringify({ status: "passed", artifacts, diagnosticTrials: selectedSuffixes }));
      return;
    }
    const aggregate = {
      status: "passed",
      cases: trialResults.slice(0, 8).map((trial) => trial.trialResult),
      stale: trialResults.slice(8, 12).map((trial) => trial.trialResult),
      newerEditUndo: trialResults[12].trialResult,
      trials: trialResults.map((trial) => ({ trial: trial.trial, thunderbirdVersion: trial.thunderbirdVersion,
        xpiSha256: trial.xpiSha256, agentId: trial.agentId })),
    };
    await writeFile(join(artifacts, "aggregate-result.json"), `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 });
    const summary = await reconcile(artifacts, metadata, secrets);
    console.log(JSON.stringify({ status: summary.status, artifacts, matrix: summary.matrix }));
  } finally {
    await restore();
    assert(hash(await readFile(configPath)) === hash(originalConfig), "Gateway config restoration hash mismatch");
    const restoredStatus = await waitForGateway(token);
    const finalDevices = operatorCall("thunderclaw.devices.list", {}).devices;
    assert(Array.isArray(finalDevices), "could not enumerate qualification devices for cleanup");
    for (const device of finalDevices) {
      if (!initialCredentialIds.has(device.credentialId) && device.revokedAt == null) {
        operatorCall("thunderclaw.devices.revoke", { credentialId: device.credentialId });
      }
    }
    assert(spawnSync("docker", ["inspect", proxyName], { cwd: root, stdio: "ignore" }).status !== 0,
      "qualification proxy cleanup failed");
    await writeFile(join(artifacts, "environment-restored.json"), `${JSON.stringify({
      restored: true, configSha256: hash(await readFile(configPath)), proxyRemoved: true,
      gatewayVersion: restoredStatus.gatewayVersion, plugin: restoredStatus.plugin,
    }, null, 2)}\n`, { mode: 0o600 });
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
