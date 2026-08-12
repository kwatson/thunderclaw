import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";

const apiKey = process.env.DEEPSEEK_API_KEY;
const evidencePath = process.env.THUNDERCLAW_PROVIDER_EVIDENCE;
const qualificationNonce = process.env.THUNDERCLAW_QUALIFICATION_NONCE;
const caseSuffixes = (process.env.THUNDERCLAW_CASE_SUFFIXES ?? "").split(",").filter(Boolean);
if (!apiKey || !evidencePath || !qualificationNonce) throw new Error("provider proxy environment is incomplete");

await mkdir(new URL(".", `file://${evidencePath}`).pathname, { recursive: true });
let requestNumber = 0;

const hash = (value) => createHash("sha256").update(value).digest("hex");
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const serializedMessages = JSON.stringify(messages);
    const sequence = ++requestNumber;
    const startedAt = Date.now();
    const upstream = await fetch(`https://api.deepseek.com${request.url}`, {
      method: request.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: raw,
      redirect: "error",
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    const matchedCaseNonce = caseSuffixes.map((suffix) => `${qualificationNonce}-${suffix}`)
      .find((candidate) => serializedMessages.includes(candidate));
    const record = {
      sequence,
      recordedAt: new Date().toISOString(),
      requestSha256: hash(raw),
      pathSha256: hash(String(request.url ?? "")),
      model: typeof body.model === "string" ? body.model : null,
      roles: messages.map((message) => typeof message?.role === "string" ? message.role : null),
      toolsFieldPresent: Object.hasOwn(body, "tools"),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      toolChoiceFieldPresent: Object.hasOwn(body, "tool_choice"),
      personalityCanaryPresent: serializedMessages.includes("THUNDERBIRD_PERSONALITY_CANARY_7F3A"),
      memoryCanaryPresent: serializedMessages.includes("THUNDERBIRD_MEMORY_CANARY_91C2"),
      qualificationNonceSha256: hash(qualificationNonce),
      qualificationNoncePresent: serializedMessages.includes(qualificationNonce),
      caseNonceSha256: matchedCaseNonce ? hash(matchedCaseNonce) : null,
      upstreamStatus: upstream.status,
      responseSha256: hash(upstreamBody),
      durationMs: Date.now() - startedAt,
    };
    await appendFile(evidencePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "content-length": String(upstreamBody.length),
    });
    response.end(upstreamBody);
  } catch {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "qualification proxy failed" } }));
  }
});

server.listen(18888, "0.0.0.0");
