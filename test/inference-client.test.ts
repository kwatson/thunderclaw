import assert from "node:assert/strict";
import test from "node:test";
import { DirectClientError, type ConnectionBinding, type TransformComposeRequest, type TransformMessageRequest } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { InferenceClient, CONFIGURED_MODEL_ID, inferenceFailureMessage } from "../packages/thunderbird-extension/src/inference-client.js";
import { validateAgentListResponse } from "../packages/thunderbird-extension/src/direct-client-validators.js";
import { canonicalizeInferenceBase, reasoningEffortsForProvider, type InferenceConfiguration } from "../packages/thunderbird-extension/src/inference-provider.js";

const configuration: InferenceConfiguration = { provider: "custom", apiBase: "https://inference.example/v1", model: "configured/model", outputMode: "json_schema", writingStyle: "STYLE_SENTINEL" };
function binding(config = configuration): ConnectionBinding {
  const endpoint = canonicalizeInferenceBase(config.apiBase);
  return { apiBase: endpoint.apiBase, origin: endpoint.origin, credential: { mode: "device_credential", credentialId: "config-revision" }, permissionId: endpoint.permissionPattern, epoch: 1 };
}
function response(value: unknown, extra: Record<string, unknown> = {}, finish = "stop"): Response {
  return Response.json({ choices: [{ finish_reason: finish, message: { role: "assistant", content: JSON.stringify(value), ...extra } }] });
}
function compose(): TransformComposeRequest {
  return { protocolVersion: 1, requestId: "request-private", runId: "run-private", composeId: "compose-private", composeGeneration: 2, agentId: CONFIGURED_MODEL_ID, action: "improve", contextHash: "context-private", targetHash: "target-private", document: { subject: "SUBJECT_PRIVATE", recipients: ["recipient-private@example.test"], authoredText: "CONTEXT_PRIVATE", quotedText: "HISTORY_PRIVATE" }, target: { targetId: "target-id-private", text: "Selected draft.", start: 0, end: 15 }, limits: { maxOperations: 1, maxOutputCharacters: 1_000 } };
}
function message(action: "translate" | "summarize" = "translate"): TransformMessageRequest {
  return { protocolVersion: 1, requestId: "message-private", runId: "message-run", agentId: CONFIGURED_MODEL_ID, action, sourceLanguage: "English", targetLanguage: action === "translate" ? "French" : null, messageHash: "hash-private", document: { subject: "SUBJECT_PRIVATE", author: "AUTHOR_PRIVATE", segments: [{ id: "segment-private-1", text: "Hello." }, { id: "segment-private-2", text: "Thank you." }] }, limits: { maxSegments: 2, maxOutputCharacters: 1_000 } };
}
function makeClient(fetchImpl: typeof fetch, config = configuration, options: { timeoutMs?: number; permissionCheck?: () => Promise<boolean> } = {}) {
  return new InferenceClient(config, config.provider === "ollama" ? "" : "synthetic-key", binding(config), { fetchImpl, ...options });
}
async function transform(client: InferenceClient, request = compose(), signal?: AbortSignal) {
  await client.openCompose({ protocolVersion: 1, requestId: "open", composeId: request.composeId, composeGeneration: request.composeGeneration, agentId: request.agentId });
  return client.transformCompose(request, { signal });
}
const kind = (expected: DirectClientError["kind"]) => (error: unknown) => error instanceof DirectClientError && error.kind === expected;

test("default browser fetch keeps its global receiver", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async function (this: unknown) {
    assert.equal(this, globalThis, "native browser fetch requires its global receiver");
    calls += 1;
    return response({ text: "Edited draft.", summary: "Improved wording." });
  });
  const client = new InferenceClient(configuration, "synthetic-key", binding());
  await transform(client);
  assert.equal(calls, 1);
});

test("inference sends only selected content and action, binds edit identities locally and uses safe HTTP settings", async () => {
  let payload: any; let called = 0;
  const client = makeClient(async (url, init) => {
    called++; assert.equal(url, "https://inference.example/v1/chat/completions");
    assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-key");
    payload = JSON.parse(String(init?.body)); return response({ text: "Edited draft.", summary: "Improved wording." });
  });
  const result = (await transform(client)).value;
  assert.equal(result.result.requestId, "request-private"); assert.equal(result.result.contextHash, "context-private"); assert.equal(result.result.composeGeneration, 2);
  const operation = result.result.operations[0]; assert.equal(operation.targetId, "target-id-private");
  assert.equal(operation.type, "replace_text_range");
  assert.equal(called, 1); assert.equal(payload.stream, false); assert.equal(payload.model, "configured/model"); assert.equal(payload.tools, undefined);
  assert.equal(payload.response_format.type, "json_schema"); assert.equal(payload.response_format.json_schema.strict, true);
  const sent = JSON.stringify(payload);
  for (const sentinel of ["request-private", "run-private", "compose-private", "context-private", "target-private", "target-id-private", "SUBJECT_PRIVATE", "recipient-private", "HISTORY_PRIVATE"]) assert.ok(!sent.includes(sentinel), sentinel);
  assert.ok(sent.includes("STYLE_SENTINEL")); assert.ok(sent.includes("Selected draft.")); assert.ok(sent.includes("CONTEXT_PRIVATE"));
});

test("all compatibility and compose lifecycle calls remain local", async () => {
  const client = makeClient(async () => { throw new Error("unexpected network"); });
  await client.hello(); await client.status();
  const agents = (await client.listAgents("list")).value;
  assert.equal(validateAgentListResponse(agents, "list").agents[0].agentId, CONFIGURED_MODEL_ID);
  await client.probeAgent({ protocolVersion: 1, requestId: "probe", probeRunId: "probe-run", agentId: CONFIGURED_MODEL_ID });
  const req = compose(); await client.openCompose(req); await client.closeCompose(req);
  await assert.rejects(client.transformCompose(req), kind("contract"));
});

test("list and rich replacements use independent strict content grammars", async () => {
  const list = compose(); list.target = { ...list.target, text: "One\nTwo", start: 0, end: 7, selectionShape: "flat-list-items", items: ["One", "Two"] };
  const listed = await transform(makeClient(async () => response({ items: ["First", "Second"], summary: "Updated." })), list);
  assert.equal(listed.value.result.operations[0].type, "replace_flat_list_items");
  const rich = compose(); rich.target.selectionShape = "rich-blocks";
  const result = await transform(makeClient(async () => response({ blocks: [{ type: "paragraph", spans: [{ text: "Plain", marks: [] }, { text: "Bold", marks: ["bold"] }] }, { type: "ordered_list", items: [{ spans: [{ text: "First", marks: [] }] }] }], summary: "Updated." })), rich);
  assert.equal(result.value.result.operations[0].type, "replace_rich_blocks");
  for (const blocks of [[{ type: "html", html: "<script/>" }], [{ type: "paragraph", spans: [{ text: "x", marks: ["underline", "bold"] }] }], [{ type: "paragraph", spans: [{ text: "x", href: "https://bad.test" }] }]]) {
    await assert.rejects(transform(makeClient(async () => response({ blocks, summary: "" })), rich), kind("contract"));
  }
});

test("translation binds the original exact IDs and summary preserves action-specific result shape", async () => {
  const requests: any[] = [];
  const client = makeClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return body.messages[1].content.includes('"action":"translate"')
      ? response({ detectedLanguage: "English", translations: ["Bonjour.", "Merci."] })
      : response({ detectedLanguage: "English", summary: { title: "Greeting", bullets: ["Says hello and thanks."] } });
  });
  const translated = (await client.transformMessage(message())).value.result;
  assert.deepEqual(translated.segments, [{ id: "segment-private-1", text: "Bonjour." }, { id: "segment-private-2", text: "Merci." }]);
  assert.equal(translated.targetLanguage, "French");
  const summary = (await client.transformMessage(message("summarize"))).value.result;
  assert.deepEqual(summary.segments, []); assert.equal(summary.summary?.title, "Greeting");
  const sent = JSON.stringify(requests);
  for (const sentinel of ["AUTHOR_PRIVATE", "SUBJECT_PRIVATE", "segment-private", "hash-private", "STYLE_SENTINEL"]) assert.ok(!sent.includes(sentinel));
  for (const value of [{ detectedLanguage: null, translations: ["Only one"] }, { detectedLanguage: null, translations: ["a", "b"], messageHash: "spoof" }]) await assert.rejects(makeClient(async () => response(value)).transformMessage(message()), kind("contract"));
});

test("writing style never changes proofreading, translation or summary tasks", async () => {
  for (const action of ["proofread", "translate", "summarize"] as const) {
    const request = compose(); request.action = action;
    const client = makeClient(async (_url, init) => { assert.ok(!String(init?.body).includes("STYLE_SENTINEL")); return response({ text: "Edited.", summary: "Done." }); });
    await transform(client, request);
  }
});

test("DeepSeek disables thinking in JSON object mode and other providers retain their request options", async () => {
  for (const provider of ["deepseek", "openrouter", "openai", "ollama", "lmstudio", "custom"] as const) {
    const config = { ...configuration, provider, outputMode: provider === "deepseek" ? "json_object" as const : "json_schema" as const };
    await transform(makeClient(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); assert.equal(body.response_format.type, config.outputMode);
      if (provider === "deepseek") {
        assert.equal(body.response_format.json_schema, undefined); assert.ok(body.messages[0].content.includes("JSON"));
        assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.max_tokens, 16_384);
      } else assert.equal(Object.hasOwn(body, "thinking"), false);
      if (provider === "openrouter") assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: false });
      if (provider === "openai") { assert.equal(body.store, false); assert.equal(body.max_completion_tokens, 16_384); }
      return response({ text: "Edited.", summary: "Done." });
    }, config));
  }
});

test("every provider maps each configured thinking level and token limit to its documented request format", async () => {
  for (const provider of ["deepseek", "openrouter", "openai", "ollama", "lmstudio", "custom"] as const) {
    for (const reasoningEffort of reasoningEffortsForProvider(provider)) {
      const config = { ...configuration, provider, outputMode: provider === "deepseek" ? "json_object" as const : "json_schema" as const, reasoningEffort, maxResponseTokens: 32_768 };
      await transform(makeClient(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, config.model); assert.equal(body.n, 1); assert.equal(body.stream, false);
        assert.equal(body.extra_body, undefined); assert.equal(body.tools, undefined);
        assert.equal(body[provider === "openai" ? "max_completion_tokens" : "max_tokens"], 32_768);
        assert.equal(body[provider === "openai" ? "max_tokens" : "max_completion_tokens"], undefined);
        if (provider === "openrouter") {
          assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: false });
          assert.deepEqual(body.reasoning, reasoningEffort === "default" ? undefined : reasoningEffort === "none" ? { enabled: false } : { effort: reasoningEffort });
          assert.equal(body.reasoning_effort, undefined); assert.equal(body.thinking, undefined);
        } else if (provider === "deepseek") {
          assert.equal(body.reasoning, undefined);
          assert.deepEqual(body.thinking, reasoningEffort === "default" ? undefined : { type: reasoningEffort === "none" ? "disabled" : "enabled" });
          assert.equal(body.reasoning_effort, ["default", "none"].includes(reasoningEffort) ? undefined : reasoningEffort);
        } else {
          assert.equal(body.reasoning_effort, reasoningEffort === "default" ? undefined : reasoningEffort);
          assert.equal(body.thinking, undefined); assert.equal(body.reasoning, undefined);
        }
        return response({ text: "Edited.", summary: "Done." });
      }, config));
    }
  }
});

test("DeepSeek newsletter auto translation retains all 74 segment identities and rejects missing or extra segments", async () => {
  const request = message();
  request.sourceLanguage = null;
  request.document.segments = Array.from({ length: 74 }, (_, index) => ({ id: `newsletter-${index}`, text: `Community newsletter item ${index + 1}: the library event starts at 10:00.` }));
  request.limits = { maxSegments: 74, maxOutputCharacters: 20_000 };
  const translations = request.document.segments.map((_, index) => `Actualité ${index + 1} : l'événement de la bibliothèque commence à 10 h.`);
  const config = { ...configuration, provider: "deepseek" as const, model: "synthetic-deepseek-flash", outputMode: "json_object" as const };
  let calls = 0;
  const client = makeClient(async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model); assert.equal(body.max_tokens, 16_384);
    assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.extra_body, undefined);
    assert.deepEqual(body.response_format, { type: "json_object" });
    const content = JSON.parse(body.messages[1].content);
    assert.equal(content.sourceLanguage, null); assert.deepEqual(content.segments, request.document.segments.map(({ text }) => text));
    return response({ detectedLanguage: "English", translations });
  }, config);
  const result = (await client.transformMessage(request)).value.result;
  assert.equal(calls, 1);
  assert.deepEqual(result.segments, translations.map((text, index) => ({ id: request.document.segments[index].id, text })));
  for (const invalid of [translations.slice(1), [...translations, "Extra segment."]]) {
    let invalidCalls = 0;
    await assert.rejects(makeClient(async () => { invalidCalls++; return response({ detectedLanguage: "English", translations: invalid }); }, config).transformMessage(request), kind("contract"));
    assert.equal(invalidCalls, 1);
  }
});

test("response token exhaustion rejects complete-looking and partial results with a safe error and no retry", async () => {
  for (const operation of ["compose", "message"] as const) {
    for (const content of [JSON.stringify(operation === "compose" ? { text: "Edited.", summary: "Done." } : { detectedLanguage: "English", translations: ["Bonjour.", "Merci."] }), '{"private-provider-body":']) {
      let calls = 0;
      const client = makeClient(async () => { calls++; return response(null, { content, reasoning_content: "synthetic-private-reasoning" }, "length"); });
      await assert.rejects(operation === "compose" ? transform(client) : client.transformMessage(message()), (error: unknown) => {
        assert.ok(error instanceof DirectClientError);
        assert.equal(error.kind, "contract"); assert.equal(error.code, "INFERENCE_OUTPUT_LIMIT");
        assert.equal(error.message, inferenceFailureMessage("INFERENCE_OUTPUT_LIMIT"));
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("local Ollama needs no authorization header or relay", async () => {
  const config = { ...configuration, provider: "ollama" as const, apiBase: "http://127.0.0.1:11434/v1" };
  await transform(makeClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:11434/v1/chat/completions"); assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return response({ text: "Edited.", summary: "Done." });
  }, config));
});

test("malformed output, unknown keys, HTML, markdown lists and output overruns fail without repair or retry", async () => {
  for (const value of [null, [], { text: "Edited", summary: "", requestId: "spoof" }, { text: "<b>unsafe</b>", summary: "" }, { text: "- List", summary: "" }, { text: "x".repeat(1_001), summary: "" }, { text: 42, summary: "" }, { text: " REPLACEMENT TEXT ", summary: "Done." }, { text: "Edited.", summary: "Short Description" }]) {
    let calls = 0; const client = makeClient(async () => { calls++; return response(value); });
    await assert.rejects(transform(client), kind("contract")); assert.equal(calls, 1);
  }
  await assert.rejects(transform(makeClient(async () => response({}, { content: "```json\n{}\n```" }))), kind("contract"));
});

test("refusals, tool calls, truncation and multiple choices never become edits", async () => {
  for (const extra of [{ refusal: "No" }, { tool_calls: [{ type: "function", function: { name: "send_mail" } }] }, { function_call: { name: "send_mail" } }]) await assert.rejects(transform(makeClient(async () => response({ text: "x", summary: "" }, extra))), kind("contract"));
  for (const finish of ["length", "content_filter", "tool_calls", null]) await assert.rejects(transform(makeClient(async () => response({ text: "x", summary: "" }, {}, finish as string))), kind("contract"));
  await assert.rejects(transform(makeClient(async () => Response.json({ choices: [] }))), kind("contract"));
});

test("redirects, unexpected response URLs and unbounded response bodies fail closed", async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    async () => { const result = response({ text: "x", summary: "" }); Object.defineProperty(result, "redirected", { value: true }); return result; },
    async () => { const result = response({ text: "x", summary: "" }); Object.defineProperty(result, "url", { value: "https://other.example/chat/completions" }); return result; },
    async () => new Response("", { headers: { "content-type": "application/json", "content-length": "1048577" } }),
    async () => new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
    async () => new Response("not json", { headers: { "content-type": "text/plain" } }),
  ]) await assert.rejects(transform(makeClient(fetchImpl)), kind("contract"));
});

test("request bytes and missing permissions stop before sending content", async () => {
  let calls = 0; const fetchImpl: typeof fetch = async () => { calls++; return response({ text: "x", summary: "" }); };
  await assert.rejects(transform(makeClient(fetchImpl, configuration, { permissionCheck: async () => false })), kind("permission"));
  const request = compose(); request.target.text = "é".repeat(130_000); request.target.end = 130_000;
  await assert.rejects(transform(makeClient(fetchImpl), request), kind("contract")); assert.equal(calls, 0);
});

test("API and network errors never expose remote text, email or credentials", async () => {
  for (const fetchImpl of [async () => new Response("secret-key email body", { status: 401 }), async () => { throw new Error("secret-key email body"); }]) {
    await assert.rejects(transform(makeClient(fetchImpl)), (error: unknown) => error instanceof DirectClientError && !error.message.includes("secret-key") && !error.message.includes("email body"));
  }
});

test("caller cancellation resolves promptly even when fetch ignores abort", async () => {
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  const client = makeClient(async () => { started(); return new Promise<Response>(() => {}); });
  const controller = new AbortController(); const pending = transform(client, compose(), controller.signal);
  await ready; controller.abort(); await assert.rejects(pending, kind("cancellation"));
});

test("explicit cancel and close abort only their matching local compose generation", async () => {
  for (const close of [false, true]) {
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const client = makeClient(async () => { started(); return new Promise<Response>(() => {}); }); const request = compose();
    const pending = transform(client, request); await ready;
    if (close) await client.closeCompose({ ...request, requestId: "close" }); else await client.cancelComposeRun({ ...request, requestId: "cancel" });
    await assert.rejects(pending, kind("cancellation"));
    if (close) await assert.rejects(client.openCompose(request), kind("contract"));
  }
});

test("deadline includes a hung fetch, permission check and response stream", async () => {
  for (const mode of ["fetch", "permission", "stream"] as const) {
    const client = makeClient(async () => mode === "fetch" ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }), configuration, { timeoutMs: 15, permissionCheck: mode === "permission" ? () => new Promise<boolean>(() => {}) : undefined });
    await assert.rejects(transform(client), kind("timeout"));
  }
});

test("model discovery is bounded and never sends email content", async () => {
  const client = makeClient(async (url, init) => { assert.equal(url, "https://inference.example/v1/models"); assert.equal(init?.body, undefined); return Response.json({ data: [{ id: "b/model" }, { id: "a:model" }, { id: "b/model" }] }); });
  assert.deepEqual(await client.listModels(), ["a:model", "b/model"]);
  for (const data of [[{ id: "bad\nmodel" }], [{ id: "x".repeat(257) }], Array.from({ length: 5_001 }, () => ({ id: "x" }))]) await assert.rejects(makeClient(async () => Response.json({ data })).listModels(), kind("contract"));
});

test("setup tests both synthetic compose and exact segment output with one total deadline", async () => {
  let calls = 0;
  const client = makeClient(async (_url, init) => { calls++; const body = String(init?.body); assert.ok(!body.includes("PRIVATE")); return body.includes('\\"translations\\"') ? response({ detectedLanguage: "English", translations: ["Bonjour.", "Merci."] }) : response({ text: "Hello.", summary: "No change." }); });
  await client.testConnection(); assert.equal(calls, 2);
});

test("configuration and public binding cannot be changed after constructing the client", async () => {
  const config = { ...configuration }; const bound = binding();
  const client = new InferenceClient(config, "synthetic-key", bound, { fetchImpl: async (url) => { assert.equal(url, "https://inference.example/v1/chat/completions"); return response({ text: "x", summary: "" }); } });
  config.apiBase = "https://attacker.example/v1";
  (bound as { apiBase: string }).apiBase = "https://attacker.example/v1";
  assert.ok(Object.isFrozen(client.binding)); assert.ok(Object.isFrozen(client.binding.credential)); await transform(client);
});

test("safe failure codes distinguish refusal, filtering, empty output, invalid JSON, schema and segment cardinality", async () => {
  const cases: Array<[() => Promise<unknown>, string]> = [
    [() => transform(makeClient(async () => response({}, { refusal: "PRIVATE_PROVIDER_TEXT" }))), "INFERENCE_REFUSAL"],
    [() => transform(makeClient(async () => response({}, {}, "content_filter"))), "INFERENCE_CONTENT_FILTER"],
    [() => transform(makeClient(async () => response({}, { content: null }))), "EMPTY_INFERENCE_OUTPUT"],
    [() => transform(makeClient(async () => response({}, { content: "  " }))), "EMPTY_INFERENCE_OUTPUT"],
    [() => transform(makeClient(async () => response({}, { content: "PRIVATE_PROVIDER_TEXT{" }))), "INVALID_INFERENCE_JSON"],
    [() => transform(makeClient(async () => new Response("PRIVATE_PROVIDER_TEXT{", { headers: { "content-type": "application/json" } }))), "INVALID_INFERENCE_JSON"],
    [() => transform(makeClient(async () => response({ text: "Edited.", summary: "Done.", private: "PRIVATE_PROVIDER_TEXT" }))), "INVALID_INFERENCE_OUTPUT"],
    [() => transform(makeClient(async () => response({ text: "<script>PRIVATE_PROVIDER_TEXT</script>", summary: "Done." }))), "INVALID_INFERENCE_OUTPUT"],
    [() => makeClient(async () => response({ detectedLanguage: null, translations: ["a"] })).transformMessage(message()), "INFERENCE_TRANSLATION_COUNT"],
    [() => transform(makeClient(async () => new Response("", { headers: { "content-type": "application/json", "content-length": "1048577" } }))), "RESPONSE_TOO_LARGE"],
  ];
  for (const [operation, code] of cases) {
    await assert.rejects(operation(), (error: unknown) => {
      assert.ok(error instanceof DirectClientError);
      assert.equal(error.code, code); assert.equal(error.message, inferenceFailureMessage(code));
      assert.ok(!error.message.includes("PRIVATE_PROVIDER_TEXT")); return true;
    });
  }
});

test("HTTP rejection classifications inspect only bounded exact error-code literals and never echo server data", async () => {
  const cases: Array<[unknown, number, string, DirectClientError["kind"]]> = [
    [{ error: { code: "context_length_exceeded", message: "PRIVATE_PROVIDER_TEXT" } }, 400, "INFERENCE_CONTEXT_LIMIT", "backend"],
    [{ error: { code: "context_window_exceeded", message: "PRIVATE_PROVIDER_TEXT" } }, 422, "INFERENCE_CONTEXT_LIMIT", "backend"],
    [{ error: { code: "unsupported_parameter", param: "max_tokens PRIVATE_PROVIDER_TEXT", message: "PRIVATE_PROVIDER_TEXT" } }, 400, "INFERENCE_SETTINGS_REJECTED", "backend"],
    [{ error: { code: "invalid_api_key", message: "PRIVATE_PROVIDER_TEXT" } }, 401, "INFERENCE_HTTP_ERROR", "authentication"],
    [{ error: { code: "context_length_exceeded", message: "PRIVATE_PROVIDER_TEXT" } }, 403, "INFERENCE_HTTP_ERROR", "permission"],
    [{ error: { code: "context_length_exceeded", message: "PRIVATE_PROVIDER_TEXT" } }, 429, "INFERENCE_HTTP_ERROR", "rate_limit"],
    [{ error: { code: "context_length_exceeded PRIVATE_PROVIDER_TEXT", message: "context_length_exceeded" } }, 400, "INFERENCE_SETTINGS_REJECTED", "backend"],
    [{ error: { message: "Unsupported reasoning_effort: PRIVATE_PROVIDER_TEXT" } }, 400, "INFERENCE_SETTINGS_REJECTED", "backend"],
    [{ error: { code: "context_length_exceeded", message: "PRIVATE_PROVIDER_TEXT".repeat(2_000) } }, 400, "INFERENCE_SETTINGS_REJECTED", "backend"],
    [null, 500, "INFERENCE_HTTP_ERROR", "backend"],
  ];
  for (const [body, status, code, errorKind] of cases) {
    let calls = 0;
    await assert.rejects(transform(makeClient(async () => { calls++; return Response.json(body, { status }); })), (error: unknown) => {
      assert.ok(error instanceof DirectClientError); assert.equal(error.code, code); assert.equal(error.kind, errorKind);
      assert.equal(error.status, status); assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_TEXT|unsupported_parameter|reasoning_effort/u); return true;
    });
    assert.equal(calls, 1);
  }
  for (const body of ["context_length_exceeded PRIVATE_PROVIDER_TEXT", "{broken"]) {
    await assert.rejects(transform(makeClient(async () => new Response(body, { status: 400, headers: { "content-type": "application/json" } }))),
      (error: unknown) => error instanceof DirectClientError && error.code === "INFERENCE_SETTINGS_REJECTED");
  }
});

test("HTTP error-body inspection remains cancellable and bounded by the operation deadline", async () => {
  const client = makeClient(async () => new Response(new ReadableStream({ start() {} }), { status: 400, headers: { "content-type": "application/json" } }), configuration, { timeoutMs: 15 });
  await assert.rejects(transform(client), kind("timeout"));
});
