import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

const upstreamBase = process.env.THUNDERCLAW_RELAY_UPSTREAM;
const listenPort = Number(process.env.THUNDERCLAW_RELAY_PORT);
const evidencePath = process.env.THUNDERCLAW_RELAY_EVIDENCE;
if (!upstreamBase || !evidencePath || !Number.isSafeInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
  throw new Error("relay environment is incomplete");
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
let sequence = 0;

function approvePairing(requestId, approvalCode) {
  if (process.env.THUNDERCLAW_RELAY_AUTO_APPROVE !== "1") return;
  const result = spawnSync("docker", ["compose", "-f", "compose.spike.yaml", "exec", "-T", "gateway",
    "node", "openclaw.mjs", "gateway", "call", "thunderclaw.pairing.approve", "--json", "--params",
    JSON.stringify({ requestId, approvalCode })], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("operator approval failed");
  const value = JSON.parse(result.stdout);
  if (value?.approved !== true && value?.payload?.approved !== true) throw new Error("operator approval was not confirmed");
}

createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawRequest = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    let requestBody = null;
    try { requestBody = rawRequest.length ? JSON.parse(rawRequest.toString("utf8")) : null; } catch {}
    const upstream = await fetch(`${upstreamBase}${request.url}`, {
      method: request.method,
      headers: {
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
      },
      body: rawRequest.length ? rawRequest : undefined,
      redirect: "manual",
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    let responseBody = null;
    try { responseBody = JSON.parse(body.toString("utf8")); } catch {}
    if (request.url === "/thunderclaw/pairing/v1/requests" && upstream.status === 201) {
      approvePairing(requestBody?.requestId, responseBody?.approvalCode);
    }
    const isTransform = request.url === "/thunderclaw/v1/compose/transform";
    const operation = isTransform ? responseBody?.result?.operations?.[0] : null;
    const audit = {
      sequence: ++sequence,
      recordedAt: new Date().toISOString(),
      method: request.method,
      path: request.url,
      status: upstream.status,
      requestSha256: hash(rawRequest),
      responseSha256: hash(body),
      request: isTransform ? {
        protocolVersion: requestBody?.protocolVersion,
        requestId: requestBody?.requestId,
        runId: requestBody?.runId,
        composeId: requestBody?.composeId,
        composeGeneration: requestBody?.composeGeneration,
        agentId: requestBody?.agentId,
        action: requestBody?.action,
        instructionSha256: hash(String(requestBody?.instruction ?? "")),
        contextHash: requestBody?.contextHash,
        targetHash: requestBody?.targetHash,
        document: requestBody?.document ? {
          subject: requestBody.document.subject,
          recipients: requestBody.document.recipients,
          authoredTextSha256: hash(String(requestBody.document.authoredText ?? "")),
          quotedTextPresent: Object.hasOwn(requestBody.document, "quotedText"),
          quotedTextSha256: Object.hasOwn(requestBody.document, "quotedText")
            ? hash(String(requestBody.document.quotedText)) : null,
          contextHashRecomputed: `sha256:${hash(JSON.stringify(requestBody.document))}`,
          contextHashMatches: requestBody?.contextHash === `sha256:${hash(JSON.stringify(requestBody.document))}`,
        } : null,
        targetHashRecomputed: requestBody?.target?.text === undefined ? null
          : `sha256:${hash(String(requestBody.target.text))}`,
        targetHashMatches: requestBody?.target?.text === undefined ? false
          : requestBody?.targetHash === `sha256:${hash(String(requestBody.target.text))}`,
        target: requestBody?.target ? {
          targetId: requestBody.target.targetId,
          start: requestBody.target.start,
          end: requestBody.target.end,
          selectionShape: requestBody.target.selectionShape,
          text: requestBody.target.text,
          items: requestBody.target.items,
        } : null,
      } : null,
      response: isTransform ? {
        errorCode: typeof responseBody?.error?.code === "string" ? responseBody.error.code : null,
        runId: responseBody?.runId,
        requestId: responseBody?.result?.requestId,
        composeGeneration: responseBody?.result?.composeGeneration,
        contextHash: responseBody?.result?.contextHash,
        targetHash: responseBody?.result?.targetHash,
        operation: operation ? { type: operation.type, targetId: operation.targetId, items: operation.items } : null,
        summarySha256: hash(String(responseBody?.result?.summary ?? "")),
        provider: responseBody?.evidence?.provider,
        model: responseBody?.evidence?.model,
        toolSummaryPresent: responseBody?.evidence?.toolSummary != null,
        toolCallCount: responseBody?.evidence?.toolSummary == null ? 0
          : Number.isSafeInteger(responseBody?.evidence?.toolSummary?.calls)
          ? responseBody.evidence.toolSummary.calls
          : Array.isArray(responseBody?.evidence?.toolSummary?.calls)
            ? responseBody.evidence.toolSummary.calls.length : -1,
        toolNameCount: responseBody?.evidence?.toolSummary == null ? 0
          : Array.isArray(responseBody?.evidence?.toolSummary?.names)
          ? responseBody.evidence.toolSummary.names.length
          : Array.isArray(responseBody?.evidence?.toolSummary?.tools)
            ? responseBody.evidence.toolSummary.tools.length
            : responseBody?.evidence?.toolSummary?.tools && typeof responseBody.evidence.toolSummary.tools === "object"
              ? Object.keys(responseBody.evidence.toolSummary.tools).length : -1,
        toolSummarySha256: responseBody?.evidence?.toolSummary == null ? null
          : hash(JSON.stringify(responseBody.evidence.toolSummary)),
        runtimeSessionMarkerPresent: typeof responseBody?.evidence?.runtimeSessionMarker === "string",
        runtimeSessionMarkerSha256: typeof responseBody?.evidence?.runtimeSessionMarker === "string"
          ? hash(responseBody.evidence.runtimeSessionMarker) : null,
        repairAttempted: responseBody?.evidence?.repairAttempted,
      } : null,
    };
    await appendFile(evidencePath, `${JSON.stringify(audit)}\n`, { mode: 0o600 });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "content-length": String(body.length),
      "cache-control": upstream.headers.get("cache-control") ?? "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "qualification relay failed" } }));
  }
}).listen(listenPort, "127.0.0.1");
