import { readFile } from "node:fs/promises";

const endpoint = process.env.THUNDERCLAW_ENDPOINT ?? "http://127.0.0.1:18789/thunderclaw/v1";
const token = process.env.THUNDERCLAW_TOKEN;
if (!token) throw new Error("THUNDERCLAW_TOKEN is required");

const fixture = JSON.parse(await readFile(new URL("../fixtures/representative-transform.json", import.meta.url), "utf8")) as Record<string, unknown>;
const transform = {
  ...fixture,
  requestId: "cancel-request-001",
  composeId: "cancel-compose-001",
  runId: "cancel-run-001",
  instruction: "Think carefully before returning the best possible polished replacement.",
};
const base = {
  protocolVersion: 1,
  requestId: "cancel-open-001",
  composeId: transform.composeId,
  composeGeneration: 1,
  agentId: "main",
};

async function request(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

console.log(JSON.stringify(await request("/compose/open", base), null, 2));
const activeTransform = request("/compose/transform", transform);
await new Promise((resolve) => setTimeout(resolve, 250));
console.log(JSON.stringify(await request("/compose/cancel", { ...base, requestId: "cancel-command-001", runId: transform.runId }), null, 2));
console.log(JSON.stringify(await activeTransform, null, 2));
console.log(JSON.stringify(await request("/compose/close", { ...base, requestId: "cancel-close-001" }), null, 2));
