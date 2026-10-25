import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProviderTrials } from "../scripts/provider-trials.js";
import { syntheticTrials } from "../e2e/provider-trials/synthetic.js";

test("synthetic provider suite covers all action families, rich/list and long automatic received transformations", async () => {
  const lines: string[] = [];
  assert.equal(await runProviderTrials([], line => lines.push(line)), 0);
  const results = lines.map(line => JSON.parse(line));
  assert.equal(results.length, 12);
  assert.ok(results.every(result => result.status === "passed" && result.mode === "mock"));
  const requests = syntheticTrials().map(trial => trial.request);
  assert.deepEqual(requests.filter(request => "target" in request).slice(0, 7).map(request => request.action),
    ["improve", "proofread", "shorten", "tone", "translate", "summarize", "ask"]);
  for (const request of requests) {
    if ("target" in request) continue;
    assert.equal(request.sourceLanguage, null);
    assert.equal(request.document.segments.length, 144);
    assert.ok(request.document.segments.reduce((count, segment) => count + segment.text.length, 0) > 40_000);
  }
  const truncation = results.find(result => result.case === "truncated-output");
  assert.equal(truncation.code, "INFERENCE_OUTPUT_LIMIT");
  assert.match(truncation.message, /Increase Response token limit.*No changes were applied/u);
});

test("provider options cannot trigger network without explicit live opt-in or accept raw keys and message files", async () => {
  for (const arguments_ of [["--api-base", "https://example.invalid"], ["--api-key", "secret"], ["--input", "test.eml"], ["--live"]]) {
    await assert.rejects(runProviderTrials(arguments_, () => {}));
  }
});

test("explicit provider trial sends synthetic source through real HTTP adapter, uses a key file and redacts provider output", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "thunderclaw-provider-trials-"));
  const keyPath = join(temporary, "synthetic-key");
  const key = "synthetic-trial-secret";
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  const observed: any[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unsupported_parameter", message: `Do not expose ${key} or source` } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const lines: string[] = [];
    assert.equal(await runProviderTrials(["--live", "--provider", "custom", "--api-base", `http://127.0.0.1:${address.port}/v1`,
      "--model", "synthetic", "--api-key-file", keyPath, "--case", "received-newsletter-translate-auto"], line => lines.push(line)), 1);
    assert.equal(observed.length, 1, "a failed live trial must never retry");
    assert.equal(observed[0].max_tokens, 16_384);
    assert.equal(observed[0].reasoning_effort, "none");
    const prompt = JSON.parse(observed[0].messages[1].content);
    assert.equal(prompt.sourceLanguage, null);
    assert.equal(prompt.segments.length, 144);
    assert.ok(prompt.segments[0].includes("synthetic"));
    assert.ok(!lines.join("\n").includes(key));
    assert.ok(!lines.join("\n").includes("Do not expose"));
    assert.equal(JSON.parse(lines[0]).code, "INFERENCE_SETTINGS_REJECTED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native fixture and provider trials use the same synthetic newsletter", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/provider-trials/newsletter.json", import.meta.url), "utf8"));
  assert.ok(fixture.author.endsWith("@example.invalid"));
  const docker = await readFile(new URL("../e2e/thunderbird/Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /fixtures\/provider-trials\/newsletter\.json/u);
  const ignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  assert.match(ignore, /!fixtures\/provider-trials\/newsletter\.json/u);
});
