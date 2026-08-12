import { readFile } from "node:fs/promises";

const endpoint = process.env.THUNDERCLAW_ENDPOINT ?? "http://127.0.0.1:18789/thunderclaw/v1";
const token = process.env.THUNDERCLAW_TOKEN;
if (!token) throw new Error("THUNDERCLAW_TOKEN is required");

const transform = JSON.parse(await readFile(new URL("../fixtures/representative-transform.json", import.meta.url), "utf8")) as Record<string, unknown>;
const base = {
  protocolVersion: transform.protocolVersion,
  requestId: "spike-open-001",
  composeId: transform.composeId,
  composeGeneration: transform.composeGeneration,
  agentId: transform.agentId,
};

async function call(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

console.log(JSON.stringify(await call("/status"), null, 2));
console.log(JSON.stringify(await call("/agents?requestId=spike-agents-001"), null, 2));
console.log(JSON.stringify(await call("/compose/open", base), null, 2));
const first = await call("/compose/transform", transform);
console.log(JSON.stringify(first, null, 2));

const refinement = {
  ...transform,
  requestId: "spike-request-002",
  runId: "spike-run-002",
  instruction:
    "Revise your immediately previous suggestion to be slightly more formal. Do not return to the original draft wording.",
};
console.log(JSON.stringify(await call("/compose/transform", refinement), null, 2));
console.log(JSON.stringify(await call("/compose/close", { ...base, requestId: "spike-close-001" }), null, 2));
