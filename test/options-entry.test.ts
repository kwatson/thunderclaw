import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../packages/thunderbird-extension/src/manifest.json", import.meta.url), "utf8"));

class FakeElement {
  id = ""; focused = false; scrolls = 0; value = ""; placeholder = ""; checked = false; disabled = false; hidden = false; textContent = ""; dataset: Record<string, string> = {}; children: FakeElement[] = [];
  listeners = new Map<string, Array<(event: any) => void>>(); attributes = new Map<string, string>();
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  contains(element: FakeElement | null): boolean { return element === this || this.children.some((child) => child.contains(element)); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolls += 1; }
  append(...elements: FakeElement[]) { this.children.push(...elements); }
  replaceChildren(...elements: FakeElement[]) { this.children = elements; }
  dispatch(type: string, details: Record<string, unknown> = {}) { const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...details }; for (const listener of this.listeners.get(type) ?? []) listener(event); return event; }
}
const ids = ["build-version", "connection-form", "connection-panel", "consent-accepted", "provider", "endpoint", "api-key", "remove-key", "model", "output-mode", "max-response-tokens", "thinking", "thinking-setting", "thinking-provider-help", "writing-style", "state", "result", "available-models", "model-options", "model-choices", "model-status", "model-provider-help", "save", "load-models", "test", "forget", "migration", "key-status"];
async function setup(version = manifest.version) {
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  elements.get("provider")!.value = "openai"; elements.get("output-mode")!.value = "json_schema";
  elements.get("model-choices")!.hidden = true;
  elements.get("model-options")!.hidden = true;
  elements.get("model-choices")!.append(elements.get("available-models")!, elements.get("model-options")!);
  const document = new FakeElement();
  const posted: any[] = []; const responseListeners: Array<(message: any) => void> = []; const disconnectListeners: Array<() => void> = [];
  let inGesture = false; const permissions: unknown[] = [];
  const descriptors = new Map(["document", "browser"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener: document.addEventListener.bind(document), getElementById(id: string) { return elements.get(id); }, createElement() { return new FakeElement(); } } });
  Object.defineProperty(globalThis, "browser", { configurable: true, value: {
    runtime: { getManifest() { return { ...manifest, version }; }, connect({ name }: { name: string }) { assert.equal(name, "thunderclaw-inference-options-v1"); return {
      postMessage(value: unknown) { posted.push(value); }, onMessage: { addListener(listener: (message: any) => void) { responseListeners.push(listener); } }, onDisconnect: { addListener(listener: () => void) { disconnectListeners.push(listener); } },
    }; } },
    permissions: { request(value: unknown) { assert.equal(inGesture, true, "host access must be requested directly in user gesture"); permissions.push(value); return Promise.resolve(true); } },
  } });
  await import(`../packages/thunderbird-extension/src/options-entry.js?inference-options=${Math.random()}`);
  function respond(request: any, value: unknown, ok = true) { for (const listener of responseListeners) listener({ requestId: request.requestId, ok, ...(ok ? { value } : { error: typeof value === "object" ? value : { message: value } }) }); }
  function dispatch(id: string, type: string, details: Record<string, unknown> = {}) { inGesture = true; try { return elements.get(id)!.dispatch(type, details); } finally { inGesture = false; } }
  function restore() { for (const listener of disconnectListeners) listener(); for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
  return { elements, document, posted, permissions, respond, dispatch, disconnectListeners, restore };
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }
const config = { provider: "openai", apiBase: "https://api.openai.com/v1", model: "synthetic-model", outputMode: "json_schema", writingStyle: "Concise" };

test("settings identify the installed manifest version before the connection responds", async () => {
  for (const version of [manifest.version, "9.8.7"]) {
    const h = await setup(version);
    try {
      assert.equal(h.elements.get("build-version")!.textContent, `Version ${version}`);
      assert.equal(h.posted[0].method, "state");
    } finally { h.restore(); }
  }
});

test("Fireworks restores a blank or saved exact ID, keeps manual help visible, and never starts discovery", async () => {
  for (const saved of [false, true]) {
    const h = await setup();
    try {
      const fireworks = { provider: "fireworks", apiBase: "https://api.fireworks.ai/inference/v1", model: "accounts/example/deployments/prod", outputMode: "json_schema", writingStyle: "" };
      if (saved) h.respond(h.posted[0], { configured: true, configuration: fireworks, phase: "ready", hasKey: true });
      else h.respond(h.posted[0], { configured: false, phase: "not_configured", hasKey: false });
      await settle();
      if (!saved) { h.elements.get("provider")!.value = "fireworks"; h.dispatch("provider", "change"); }
      assert.equal(h.elements.get("endpoint")!.value, fireworks.apiBase);
      assert.equal(h.elements.get("model")!.value, saved ? fireworks.model : "");
      assert.equal(h.elements.get("load-models")!.disabled, true);
      assert.match(h.elements.get("model-provider-help")!.textContent, /copy the exact full model, router, or deployment ID.*Load models is unavailable/u);
      assert.match(h.elements.get("model")!.placeholder, /accounts\/fireworks\/models/u);
      h.dispatch("load-models", "click"); await settle();
      assert.equal(h.permissions.length, 0);
      assert.equal(h.posted.some((item) => item.method === "listModels"), false);
      h.elements.get("provider")!.value = "openai"; h.dispatch("provider", "change");
      assert.equal(h.elements.get("load-models")!.disabled, false);
      assert.equal(h.elements.get("model-provider-help")!.textContent, "");
    } finally { h.restore(); }
  }
});

test("switching to Fireworks discards a pending model list and forget keeps manual guidance", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    h.dispatch("load-models", "click"); await settle();
    const listing = h.posted.find((item) => item.method === "listModels");
    h.elements.get("provider")!.value = "fireworks"; h.dispatch("provider", "change");
    assert.equal(h.elements.get("load-models")!.disabled, true);
    h.respond(listing, ["stale-model"]); await settle();
    assert.equal(h.elements.get("model-options")!.children.length, 0);
    assert.equal(h.elements.get("model")!.value, "");
    assert.match(h.elements.get("model-status")!.textContent, /Enter the exact model ID manually/u);
    h.dispatch("forget", "click"); await settle();
    h.respond(h.posted.find((item) => item.method === "forget"), { configured: false, phase: "not_configured", hasKey: false }); await settle();
    assert.equal(h.elements.get("load-models")!.disabled, true);
    assert.match(h.elements.get("model-provider-help")!.textContent, /Load models is unavailable/u);
  } finally { h.restore(); }
});

test("options save grants selected host in gesture, requires consent, clears typed key and does not retrieve stored secrets", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: false, phase: "not_configured", hasKey: false }); await settle();
    h.elements.get("model")!.value = "synthetic-model"; h.elements.get("api-key")!.value = "synthetic-api-key";
    h.dispatch("connection-form", "submit"); await settle(); assert.equal(h.permissions.length, 0, "upload consent precedes host permission");
    h.elements.get("consent-accepted")!.checked = true; h.dispatch("connection-form", "submit"); await settle();
    assert.deepEqual(h.permissions, [{ origins: ["https://api.openai.com/*"] }]);
    const save = h.posted.find((item) => item.method === "save"); assert.ok(save); assert.equal(save.apiKey, "synthetic-api-key"); assert.equal(save.keyAction, "replace"); assert.equal(save.consentAccepted, true);
    assert.equal(h.elements.get("api-key")!.value, "");
    h.respond(save, { configured: true, configuration: config, phase: "untested", hasKey: true }); await settle();
    assert.equal(h.elements.get("api-key")!.value, ""); assert.match(h.elements.get("key-status")!.textContent, /key is saved/u);
    assert.equal(h.elements.get("connection-panel")!.dataset.phase, "untested");
    assert.equal(h.posted.some((item) => /getKey|credential|secret/i.test(item.method)), false);
  } finally { h.restore(); }
});

test("options key omission preserves, explicit removal sends no raw key, and failed save clears input", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    h.dispatch("connection-form", "submit"); await settle(); let save = h.posted.filter((item) => item.method === "save").at(-1);
    assert.equal(save.keyAction, "preserve"); assert.equal(Object.hasOwn(save, "apiKey"), false);
    h.respond(save, { configured: true, configuration: config, phase: "untested", hasKey: true }); await settle();
    h.elements.get("remove-key")!.checked = true; h.elements.get("api-key")!.value = "unused-synthetic-key";
    h.dispatch("connection-form", "submit"); await settle(); save = h.posted.filter((item) => item.method === "save").at(-1);
    assert.equal(save.keyAction, "remove"); assert.equal(Object.hasOwn(save, "apiKey"), false); assert.equal(h.elements.get("api-key")!.value, "");
    h.respond(save, "synthetic private provider response", false); await settle(); assert.equal(h.elements.get("result")!.textContent.includes("private provider"), false);
  } finally { h.restore(); }
});

test("model names render as inert text without automatic selection; edits disable testing until saved", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    h.dispatch("load-models", "click"); await settle(); const listing = h.posted.find((item) => item.method === "listModels");
    h.respond(listing, ["<img src=x onerror=alert(1)>", "another-model"]); await settle();
    assert.equal(h.elements.get("model-options")!.children[0].textContent, "<img src=x onerror=alert(1)>"); assert.equal(h.elements.get("model")!.value, "synthetic-model");
    assert.equal(h.elements.get("test")!.disabled, false, "discovery does not change the saved connection");
    h.dispatch("available-models", "click"); h.elements.get("model-options")!.children[1].dispatch("click");
    assert.equal(h.elements.get("model")!.value, "another-model");
    assert.equal(h.elements.get("test")!.disabled, true, "choosing a model requires saving and testing again");
    h.elements.get("model")!.value = "another-model"; h.dispatch("model", "input");
    assert.equal(h.elements.get("test")!.disabled, true); assert.equal(h.elements.get("load-models")!.disabled, false);
    assert.equal(h.elements.get("model-options")!.children.length, 2, "typing keeps discovered choices available");
    h.dispatch("test", "click"); await settle(); assert.equal(h.posted.some((item) => item.method === "test"), false);
  } finally { h.restore(); }
});

test("test requests permission in gesture and uses only saved connection; port loss clears key and rejects pending actions", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "untested", hasKey: true, legacyMigration: true }); await settle();
    assert.equal(h.elements.get("migration")!.hidden, false);
    h.dispatch("test", "click"); await settle(); const probe = h.posted.find((item) => item.method === "test");
    assert.deepEqual(Object.keys(probe).sort(), ["method", "requestId"]); h.respond(probe, { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    assert.match(h.elements.get("result")!.textContent, /synthetic connection test/u);
    h.elements.get("api-key")!.value = "synthetic-unsaved-key"; h.dispatch("load-models", "click"); await settle();
    for (const listener of h.disconnectListeners) listener(); await settle(); assert.equal(h.elements.get("api-key")!.value, ""); assert.equal(h.elements.get("save")!.disabled, true);
    assert.equal(h.elements.get("result")!.textContent.includes("synthetic-unsaved-key"), false);
  } finally { h.restore(); }
});


test("fresh setup can load models before choosing one, and endpoint/key edits invalidate discovered options", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: false, phase: "not_configured", hasKey: false }); await settle();
    h.elements.get("api-key")!.value = "synthetic-discovery-key";
    assert.equal(h.elements.get("model")!.value, ""); assert.equal(h.elements.get("load-models")!.disabled, false);
    h.dispatch("load-models", "click"); await settle();
    const listing = h.posted.find((item) => item.method === "listModels");
    assert.equal(listing.configuration.model, ""); assert.equal(listing.apiKey, "synthetic-discovery-key");
    assert.equal(h.posted.some((item) => item.method === "save"), false);
    h.respond(listing, ["available-model"]); await settle();
    assert.equal(h.elements.get("model")!.value, "");
    h.elements.get("model")!.value = "available-model"; h.dispatch("model", "input");
    assert.equal(h.elements.get("model-options")!.children.length, 1);
    h.dispatch("api-key", "input"); assert.equal(h.elements.get("model-options")!.children.length, 0);
    assert.deepEqual(h.permissions, [{ origins: ["https://api.openai.com/*"] }]);
  } finally { h.restore(); }
});

function chooseDeepSeek(h: Awaited<ReturnType<typeof setup>>) {
  h.elements.get("provider")!.value = "deepseek";
  h.dispatch("provider", "change");
}

test("DeepSeek levels and token defaults restore without changing key scope", async () => {
  for (const reasoningEffort of [undefined, "none", "high"]) {
    const h = await setup();
    try {
      const deepseek = { ...config, provider: "deepseek", apiBase: "https://api.deepseek.com", outputMode: "json_object", ...(reasoningEffort ? { reasoningEffort } : {}) };
      h.respond(h.posted[0], { configured: true, configuration: deepseek, phase: "ready", hasKey: true }); await settle();
      assert.equal(h.elements.get("thinking")!.value, reasoningEffort ?? "none");
      assert.equal(h.elements.get("max-response-tokens")!.value, "16384");
      h.elements.get("thinking")!.value = "low"; h.dispatch("thinking", "change");
      h.elements.get("max-response-tokens")!.value = "32768"; h.dispatch("max-response-tokens", "input");
      assert.equal(h.elements.get("test")!.disabled, true);
      h.dispatch("test", "click"); await settle(); assert.equal(h.posted.some((item) => item.method === "test"), false);
      h.dispatch("load-models", "click"); await settle();
      const listing = h.posted.find((item) => item.method === "listModels");
      assert.equal(listing.configuration.reasoningEffort, "low");
      assert.equal(listing.configuration.maxResponseTokens, 32768);
      assert.equal(Object.hasOwn(listing.configuration, "thinking"), false);
      assert.equal(Object.hasOwn(listing, "apiKey"), false, "response controls do not alter saved key scope");
      h.respond(listing, ["synthetic-model"]); await settle();
      h.dispatch("connection-form", "submit"); await settle();
      const saved = h.posted.find((item) => item.method === "save");
      assert.equal(saved.configuration.reasoningEffort, "low"); assert.equal(saved.configuration.maxResponseTokens, 32768); assert.equal(saved.keyAction, "preserve");
      h.respond(saved, { configured: true, configuration: saved.configuration, phase: "untested", hasKey: true }); await settle();
      assert.equal(h.elements.get("thinking")!.value, "low");
      assert.equal(h.elements.get("max-response-tokens")!.value, "32768");
      assert.equal(h.elements.get("test")!.disabled, false);
    } finally { h.restore(); }
  }
});

test("provider levels and defaults reset on switching while preserving the response cap", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: false, phase: "not_configured", hasKey: false }); await settle();
    assert.equal(h.elements.get("thinking")!.value, "default");
    h.elements.get("max-response-tokens")!.value = "65536";
    const all = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const [provider, efforts] of [["deepseek", ["default", "none", "low", "high", "max"]], ["openai", all], ["openrouter", all], ["fireworks", ["default", "none", "low", "medium", "high", "xhigh", "max"]], ["ollama", ["default", "none", "low", "medium", "high"]], ["lmstudio", ["default", "none", "low", "medium", "high"]], ["custom", all]] as const) {
      h.elements.get("thinking")!.value = "high";
      h.elements.get("provider")!.value = provider; h.dispatch("provider", "change");
      assert.equal(h.elements.get("thinking")!.value, provider === "deepseek" ? "none" : "default");
      assert.deepEqual(h.elements.get("thinking")!.children.map((option) => option.value), efforts);
      assert.equal(h.elements.get("max-response-tokens")!.value, "65536");
      assert.equal(h.elements.get("test")!.disabled, true);
      if (provider === "ollama" || provider === "lmstudio") assert.match(h.elements.get("thinking-provider-help")!.textContent, /own thinking levels.*Model default/u);
      if (provider === "custom") assert.match(h.elements.get("thinking-provider-help")!.textContent, /requires.*OpenAI reasoning_effort/u);
      if (provider === "fireworks") assert.match(h.elements.get("thinking-provider-help")!.textContent, /reject or reinterpret.*Model default/u);
    }
    chooseDeepSeek(h); assert.equal(h.elements.get("thinking")!.value, "none");
    assert.deepEqual(h.elements.get("thinking")!.children.map((option) => option.textContent), ["Model default", "Off", "Low", "High", "Maximum"]);
  } finally { h.restore(); }
});

test("response controls restore canonical settings, invalidate tests separately, and reset after forgetting", async () => {
  const h = await setup();
  try {
    const saved = { ...config, reasoningEffort: "xhigh", maxResponseTokens: 131072 };
    h.respond(h.posted[0], { configured: true, configuration: saved, phase: "ready", hasKey: true }); await settle();
    assert.equal(h.elements.get("thinking")!.value, "xhigh");
    assert.equal(h.elements.get("max-response-tokens")!.value, "131072");
    h.elements.get("max-response-tokens")!.value = "1"; h.dispatch("max-response-tokens", "input");
    assert.equal(h.elements.get("test")!.disabled, true);
    h.dispatch("connection-form", "submit"); await settle();
    const save = h.posted.find((item) => item.method === "save");
    assert.equal(save.configuration.maxResponseTokens, 1);
    h.respond(save, { configured: true, configuration: save.configuration, phase: "untested", hasKey: true }); await settle();
    assert.equal(h.elements.get("test")!.disabled, false);
    h.elements.get("thinking")!.value = "minimal"; h.dispatch("thinking", "input");
    assert.equal(h.elements.get("test")!.disabled, true);
    h.dispatch("forget", "click"); await settle();
    h.respond(h.posted.find((item) => item.method === "forget"), { configured: false, phase: "not_configured", hasKey: false }); await settle();
    assert.equal(h.elements.get("thinking")!.value, "default");
    assert.equal(h.elements.get("max-response-tokens")!.value, "16384");
    assert.equal(h.elements.get("test")!.disabled, true);
  } finally { h.restore(); }
});

test("invalid response caps stop saves and discovery before permission or network", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    for (const value of ["", " ", "0", "-1", "1.5", "131073", "Infinity", "NaN"]) {
      h.elements.get("max-response-tokens")!.value = value; h.dispatch("max-response-tokens", "input");
      h.dispatch("connection-form", "submit"); await settle();
      assert.match(h.elements.get("result")!.textContent, /whole-number response token limit from 1 to 131,072/u);
      h.dispatch("load-models", "click"); await settle();
      assert.match(h.elements.get("model-status")!.textContent, /whole-number response token limit/u);
      assert.equal(h.permissions.length, 0);
      assert.equal(h.posted.length, 1);
    }
  } finally { h.restore(); }
});

test("connection failures use only known safe classifications and never provider messages", async () => {
  const cases = [
    ["INFERENCE_OUTPUT_LIMIT", /Increase Response token limit.*reduce the thinking level/u],
    ["INFERENCE_REFUSAL", /declined.*another model/u],
    ["INFERENCE_CONTENT_FILTER", /filtered/u],
    ["EMPTY_INFERENCE_OUTPUT", /no usable content/u],
    ["INVALID_INFERENCE_JSON", /invalid JSON/u],
    ["INVALID_INFERENCE_OUTPUT", /required structure/u],
    ["INFERENCE_TRANSLATION_COUNT", /every message segment/u],
    ["RESPONSE_TOO_LARGE", /response-size limit/u],
    ["INFERENCE_SETTINGS_REJECTED", /rejected the request settings/u],
    ["INFERENCE_CONTEXT_LIMIT", /context limit/u],
    ["synthetic-private-code", /unsupported result/u],
    ["constructor", /unsupported result/u],
  ] as const;
  for (const [code, expected] of cases) {
    const h = await setup();
    try {
      h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
      h.dispatch("test", "click"); await settle();
      h.respond(h.posted.find((item) => item.method === "test"), { kind: "contract", code, message: "synthetic-private-provider-text" }, false); await settle();
      assert.match(h.elements.get("result")!.textContent, expected);
      assert.equal(h.elements.get("result")!.textContent.includes("synthetic-private"), false);
    } finally { h.restore(); }
  }
});

test("DeepSeek discovery shows loading immediately, offers visible choices without saving, and selection fills the manual model", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: false, phase: "not_configured", hasKey: false }); await settle();
    chooseDeepSeek(h);
    h.elements.get("api-key")!.value = "synthetic-deepseek-key";
    h.dispatch("api-key", "input");
    h.dispatch("load-models", "click");
    assert.match(h.elements.get("model-status")!.textContent, /Loading models/u);
    assert.equal(h.elements.get("load-models")!.textContent, "Loading models…");
    assert.equal(h.elements.get("load-models")!.disabled, true);
    assert.equal(h.elements.get("load-models")!.attributes.get("aria-busy"), "true");
    await settle();
    const listing = h.posted.find((item) => item.method === "listModels");
    assert.deepEqual(listing.configuration, { provider: "deepseek", apiBase: "https://api.deepseek.com", model: "", outputMode: "json_object", writingStyle: "", maxResponseTokens: 16384, reasoningEffort: "none" });
    assert.equal(listing.apiKey, "synthetic-deepseek-key");
    assert.equal(h.elements.get("api-key")!.value, "synthetic-deepseek-key", "discovery leaves the unsaved key available for Save");
    h.dispatch("load-models", "click"); await settle();
    assert.equal(h.posted.filter((item) => item.method === "listModels").length, 1, "pending requests cannot be duplicated");
    h.respond(listing, ["deepseek-chat", "deepseek-reasoner"]); await settle();
    assert.equal(h.elements.get("model-choices")!.hidden, false);
    assert.equal(h.elements.get("available-models")!.textContent, "Choose a model…");
    assert.equal(h.elements.get("model-options")!.children[0].dataset.value, "deepseek-chat");
    assert.equal(h.elements.get("model")!.value, "");
    assert.match(h.elements.get("model-status")!.textContent, /2 models loaded/u);
    assert.equal(h.elements.get("load-models")!.textContent, "Load models");
    h.dispatch("available-models", "click");
    h.elements.get("model-options")!.children[0].dispatch("click");
    assert.equal(h.elements.get("model")!.value, "deepseek-chat");
    assert.equal(h.elements.get("test")!.disabled, true);
    assert.equal(h.elements.get("model-options")!.children.length, 2);
    assert.equal(h.posted.some((item) => item.method === "save" || item.method === "test"), false);
  } finally { h.restore(); }
});

test("model picker opens on one click, selects on one click, and closes on outside interaction", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    h.dispatch("load-models", "click"); await settle();
    h.respond(h.posted.find((item) => item.method === "listModels"), ["alpha", "beta"]); await settle();
    const trigger = h.elements.get("available-models")!;
    const list = h.elements.get("model-options")!;
    h.dispatch("available-models", "click");
    assert.equal(list.hidden, false);
    assert.equal(trigger.attributes.get("aria-expanded"), "true");
    assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[0].id);
    assert.equal(h.elements.get("model")!.value, config.model, "opening never selects a model");
    h.document.dispatch("pointerdown", { target: trigger });
    h.dispatch("model-choices", "focusout", { relatedTarget: trigger });
    assert.equal(list.hidden, false, "interacting inside the picker keeps choices visible");
    assert.equal(list.children[1].dispatch("pointerdown").defaultPrevented, true, "pressing an option retains combobox focus until selection");
    assert.equal(list.children[1].dispatch("mousedown").defaultPrevented, true, "mouse-only activation also retains focus until selection");
    assert.equal(list.hidden, false);
    list.children[1].dispatch("click");
    assert.equal(h.elements.get("model")!.value, "beta");
    assert.equal(trigger.textContent, "beta");
    assert.equal(trigger.focused, true);
    assert.equal(list.hidden, true);
    assert.equal(trigger.attributes.get("aria-expanded"), "false");
    assert.equal(trigger.attributes.has("aria-activedescendant"), false);
    assert.deepEqual(list.children.map((option) => option.attributes.get("aria-selected")), ["false", "true"]);
    assert.equal(h.elements.get("test")!.disabled, true);
    h.dispatch("available-models", "click");
    h.document.dispatch("pointerdown", { target: h.elements.get("model")! });
    assert.equal(list.hidden, true);
    h.dispatch("available-models", "click");
    h.dispatch("model-choices", "focusout", { relatedTarget: h.elements.get("model")! });
    assert.equal(list.hidden, true);
    assert.equal(h.posted.some((item) => item.method === "save" || item.method === "test"), false);
  } finally { h.restore(); }
});

test("model picker keyboard navigation previews choices and commits only with Enter or Space", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    h.dispatch("load-models", "click"); await settle();
    h.respond(h.posted.find((item) => item.method === "listModels"), ["alpha", "beta", "bravo", "gamma"]); await settle();
    const trigger = h.elements.get("available-models")!;
    const list = h.elements.get("model-options")!;
    const press = (key: string) => h.dispatch("available-models", "keydown", { key });
    assert.equal(press(" ").defaultPrevented, true, "Space must not synthesize a second button toggle");
    assert.equal(list.hidden, false);
    press("ArrowDown");
    assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[1].id);
    press("End"); assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[3].id);
    press("ArrowUp"); assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[2].id);
    press("Home"); assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[0].id);
    assert.equal(h.elements.get("model")!.value, config.model);
    assert.equal(h.elements.get("test")!.disabled, false);
    press("Escape"); assert.equal(list.hidden, true);
    press("ArrowUp"); assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[3].id);
    press("Home"); press("b"); press("r");
    assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[2].id, "typing navigates model IDs");
    assert.equal(press("Enter").defaultPrevented, true, "Enter must not submit the settings form");
    assert.equal(h.elements.get("model")!.value, "bravo");
    assert.equal(list.hidden, true);
    press("Enter");
    assert.equal(trigger.attributes.get("aria-activedescendant"), list.children[2].id);
    assert.equal(press("Tab").defaultPrevented, false, "Tab follows the normal form focus order");
    assert.equal(list.hidden, true);
    press("Home"); press(" ");
    assert.equal(h.elements.get("model")!.value, "alpha");
    h.elements.get("model")!.value = "beta"; h.dispatch("model", "input");
    assert.equal(trigger.textContent, "beta", "manual model edits keep the picker selection accurate");
    h.dispatch("available-models", "click"); h.dispatch("endpoint", "input");
    assert.equal(list.hidden, true);
    assert.equal(list.children.length, 0);
    assert.equal(h.elements.get("model-choices")!.hidden, true);
    assert.equal(trigger.attributes.get("aria-expanded"), "false");
  } finally { h.restore(); }
});

test("DeepSeek missing or malformed keys produce an adjacent error before permission or network", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: false, phase: "not_configured", hasKey: false }); await settle();
    chooseDeepSeek(h);
    assert.equal(h.permissions.length, 0, "choosing a provider has no network side effect");
    h.dispatch("load-models", "click"); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /Enter an API key/u);
    assert.equal(h.elements.get("model-status")!.attributes.get("role"), "alert");
    h.elements.get("api-key")!.value = "synthetic key with spaces";
    h.dispatch("api-key", "input"); h.dispatch("load-models", "click"); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /without spaces/u);
    assert.equal(h.permissions.length, 0);
    assert.equal(h.posted.some((item) => item.method === "listModels"), false);
  } finally { h.restore(); }
});

test("saved-key discovery is allowed only for its provider and exact API base and respects removal", async () => {
  const h = await setup();
  try {
    const deepseek = { ...config, provider: "deepseek", apiBase: "https://api.deepseek.com", outputMode: "json_object" };
    h.respond(h.posted[0], { configured: true, configuration: deepseek, phase: "ready", hasKey: true }); await settle();
    h.dispatch("load-models", "click"); await settle();
    const listing = h.posted.find((item) => item.method === "listModels"); assert.ok(listing);
    assert.equal(Object.hasOwn(listing, "apiKey"), false);
    h.respond(listing, ["deepseek-chat"]); await settle();
    h.elements.get("endpoint")!.value = "https://api.deepseek.com/v1"; h.dispatch("endpoint", "input");
    h.dispatch("load-models", "click"); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /Enter an API key/u);
    h.elements.get("endpoint")!.value = deepseek.apiBase; h.dispatch("endpoint", "input");
    h.elements.get("remove-key")!.checked = true; h.dispatch("remove-key", "input");
    h.dispatch("load-models", "click"); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /Enter an API key/u);
    h.elements.get("remove-key")!.checked = false;
    h.elements.get("provider")!.value = "openai"; h.dispatch("provider", "change");
    h.elements.get("endpoint")!.value = deepseek.apiBase; h.dispatch("endpoint", "input");
    h.dispatch("load-models", "click"); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /Enter an API key/u);
    assert.equal(h.permissions.length, 1);
    assert.equal(h.posted.filter((item) => item.method === "listModels").length, 1);
  } finally { h.restore(); }
});

test("model discovery reports actionable safe authentication errors and empty catalogues beside the button", async () => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    h.dispatch("load-models", "click"); await settle();
    let listing = h.posted.filter((item) => item.method === "listModels").at(-1);
    h.respond(listing, { kind: "authentication", message: "private-provider-body synthetic-key-secret" }, false); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /did not accept the API key.*replace/u);
    assert.equal(h.elements.get("model-status")!.textContent.includes("private-provider-body"), false);
    assert.equal(h.elements.get("model-status")!.attributes.get("role"), "alert");
    assert.equal(h.elements.get("model-choices")!.hidden, true);
    assert.equal(h.elements.get("load-models")!.disabled, false);
    h.dispatch("load-models", "click"); await settle(); listing = h.posted.filter((item) => item.method === "listModels").at(-1);
    h.respond(listing, []); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /no models.*manually/u);
    assert.equal(h.elements.get("model-choices")!.hidden, true);
    assert.equal(h.elements.get("model-options")!.children.length, 0);
  } finally { h.restore(); }
});

test("discovery ignores late success and errors after provider, endpoint, key, or removal edits", async () => {
  for (const changed of ["provider", "endpoint", "api-key", "remove-key"]) {
    for (const success of [true, false]) {
      const h = await setup();
      try {
        h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
        h.dispatch("load-models", "click"); await settle(); const listing = h.posted.find((item) => item.method === "listModels");
        if (changed === "provider") chooseDeepSeek(h);
        else { h.elements.get(changed)!.value = "synthetic-change"; h.dispatch(changed, "input"); }
        assert.equal(h.elements.get("model-choices")!.hidden, true);
        h.respond(listing, success ? ["stale-model"] : { kind: "authentication" }, success); await settle();
        assert.equal(h.elements.get("model-options")!.children.length, 0);
        assert.match(h.elements.get("model-status")!.textContent, /Settings changed.*Load models again/u);
        assert.equal(h.elements.get("model-status")!.textContent.includes("API key"), false);
        assert.equal(h.elements.get("load-models")!.disabled, false);
      } finally { h.restore(); }
    }
  }
});

test("a background model request that never replies stops loading after the network budget", async (t) => {
  const h = await setup();
  try {
    h.respond(h.posted[0], { configured: true, configuration: config, phase: "ready", hasKey: true }); await settle();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    h.dispatch("load-models", "click"); await settle();
    const listing = h.posted.find((item) => item.method === "listModels");
    t.mock.timers.tick(180_000); await settle();
    assert.equal(h.elements.get("load-models")!.disabled, true, "allow the full client network deadline");
    t.mock.timers.tick(15_000); await settle();
    assert.match(h.elements.get("model-status")!.textContent, /timed out.*try again/u);
    assert.equal(h.elements.get("load-models")!.disabled, false);
    assert.equal(h.elements.get("load-models")!.textContent, "Load models");
    h.respond(listing, ["too-late-model"]); await settle();
    assert.equal(h.elements.get("model-options")!.children.length, 0);
  } finally { h.restore(); t.mock.timers.reset(); }
});
