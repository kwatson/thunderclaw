import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { DirectClientError, type TransformComposeRequest } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { CONFIGURED_MODEL_ID, InferenceClient } from "../packages/thunderbird-extension/src/inference-client.js";
import { canonicalizeInferenceBase } from "../packages/thunderbird-extension/src/inference-provider.js";

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, work: (client: InferenceClient, apiBase: string) => Promise<void>): Promise<void> {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const apiBase = `http://127.0.0.1:${address.port}/nested/v1`; const endpoint = canonicalizeInferenceBase(apiBase);
  const client = new InferenceClient({ provider: "custom", apiBase, model: "synthetic-model", outputMode: "json_schema", writingStyle: "" }, "", {
    apiBase, origin: endpoint.origin, permissionId: endpoint.permissionPattern, credential: { mode: "device_credential", credentialId: "synthetic-revision" }, epoch: 1,
  }, { permissionCheck: async () => true });
  try { await work(client, apiBase); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function request(): TransformComposeRequest {
  return { protocolVersion: 1, requestId: "http-request", runId: "http-run", composeId: "http-compose", composeGeneration: 1, agentId: CONFIGURED_MODEL_ID, action: "proofread", contextHash: "local-context", targetHash: "local-target", document: { subject: "", recipients: [], authoredText: "A draft." }, target: { targetId: "local-range", text: "A draft.", start: 0, end: 8 }, limits: { maxOperations: 1, maxOutputCharacters: 1_000 } };
}

test("real loopback HTTP performs discovery and validates a structured completion on fixed nested paths", async () => {
  const routes: string[] = [];
  await withServer((req, res) => {
    routes.push(`${req.method} ${req.url}`); assert.equal(req.headers.authorization, undefined);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/nested/v1/models") { res.end(JSON.stringify({ data: [{ id: "synthetic-model" }] })); return; }
    assert.equal(req.url, "/nested/v1/chat/completions");
    let body = ""; req.setEncoding("utf8"); req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body); assert.equal(payload.model, "synthetic-model"); assert.equal(payload.stream, false);
      assert.equal(payload.response_format.json_schema.strict, true); assert.ok(!body.includes("local-context"));
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ text: "A polished draft.", summary: "Polished." }) } }] }));
    });
  }, async (client) => {
    assert.deepEqual(await client.listModels(), ["synthetic-model"]);
    const req = request(); await client.openCompose(req); const completion = await client.transformCompose(req);
    assert.equal(completion.value.result.targetHash, "local-target"); assert.equal(completion.value.result.operations[0].targetId, "local-range");
    assert.deepEqual(routes, ["GET /nested/v1/models", "POST /nested/v1/chat/completions"]);
  });
});

test("real HTTP redirects are rejected without following to the target route", async () => {
  const routes: string[] = [];
  await withServer((req, res) => { routes.push(req.url ?? ""); res.writeHead(307, { location: "/capture" }); res.end(); }, async (client) => {
    await assert.rejects(client.listModels(), (error: unknown) => error instanceof DirectClientError && ["network", "contract"].includes(error.kind));
    assert.deepEqual(routes, ["/nested/v1/models"]);
  });
});

test("real HTTP cancellation closes a response stream and never returns an edit", async () => {
  let received!: () => void; const ready = new Promise<void>((resolve) => { received = resolve; });
  await withServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"choices":['); received(); }, async (client) => {
    const req = request(); await client.openCompose(req); const controller = new AbortController();
    const pending = client.transformCompose(req, { signal: controller.signal }); await ready; controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof DirectClientError && error.kind === "cancellation");
  });
});
