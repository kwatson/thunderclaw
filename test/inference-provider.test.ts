import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeInferenceBase, DEFAULT_MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS, PROVIDER_PRESETS, reasoningEffortsForProvider, validateInferenceConfiguration } from "../packages/thunderbird-extension/src/inference-provider.js";

test("provider presets cover hosted, local and custom APIs with DeepSeek JSON mode", () => {
  assert.deepEqual(PROVIDER_PRESETS.map(({ id }) => id), ["openai", "openrouter", "deepseek", "ollama", "lmstudio", "custom"]);
  assert.equal(PROVIDER_PRESETS.find(({ id }) => id === "deepseek")?.outputMode, "json_object");
  for (const preset of PROVIDER_PRESETS.filter(({ apiBase }) => apiBase)) assert.equal(canonicalizeInferenceBase(preset.apiBase).apiBase, preset.apiBase);
});

test("canonical bases preserve empty and nested provider paths and support explicit loopback", () => {
  assert.equal(canonicalizeInferenceBase("https://api.deepseek.com/").apiBase, "https://api.deepseek.com");
  assert.equal(canonicalizeInferenceBase("https://example.test:8443/api/v1/").apiBase, "https://example.test:8443/api/v1");
  assert.equal(canonicalizeInferenceBase("http://[::1]:1234/v1").origin, "http://[::1]:1234");
  assert.equal(canonicalizeInferenceBase("https://EXAMPLE.test/v1").permissionPattern, "https://example.test/*");
});

test("ambiguous or credential-bearing inference bases are rejected before permission or fetch", () => {
  for (const value of [null, "", " https://example.test/v1", "http://example.test/v1", "http://localhost:1234/v1", "https://a.localhost/v1", "https://a:b@example.test/v1", "https://127.1/v1", "http://2130706433/v1", "http://0177.0.0.1/v1", "https://example.test./v1", "https://example.test/v1?token=secret", "https://example.test/v1#x", "https://example.test/a/../v1", "https://example.test/%76%31", "https://example.test//v1", "https://example.test/v1\\other", "https://[::ffff:127.0.0.1]/v1", "https://example.test:00080/v1", "https://example.test:65536/v1"]) {
    assert.throws(() => canonicalizeInferenceBase(value), String(value));
  }
});

test("configuration validation is immutable, bounded and rejects unsupported output modes", () => {
  const config = { provider: "custom", apiBase: "https://example.test/v1/", model: "model/org:tag", outputMode: "json_schema", writingStyle: "Warm and concise." };
  const checked = validateInferenceConfiguration(config);
  assert.equal(checked.apiBase, "https://example.test/v1"); assert.ok(Object.isFrozen(checked));
  for (const invalid of [{ ...config, provider: "unknown" }, { ...config, model: " model" }, { ...config, model: "x".repeat(257) }, { ...config, writingStyle: "x".repeat(4_001) }, { ...config, secret: "never" }, { ...config, provider: "deepseek" }, { ...config, outputMode: "text" }]) assert.throws(() => validateInferenceConfiguration(invalid));
});

test("response-token limit defaults to 16384 and validates an application-bounded integer", () => {
  const config = { provider: "custom", apiBase: "https://example.test/v1", model: "model", outputMode: "json_schema", writingStyle: "" };
  assert.equal(DEFAULT_MAX_RESPONSE_TOKENS, 16_384);
  assert.equal(validateInferenceConfiguration(config).maxResponseTokens, DEFAULT_MAX_RESPONSE_TOKENS);
  for (const maxResponseTokens of [1, 8_192, 16_384, MAX_RESPONSE_TOKENS]) assert.equal(validateInferenceConfiguration({ ...config, maxResponseTokens }).maxResponseTokens, maxResponseTokens);
  for (const maxResponseTokens of [null, "16384", 0, -1, 1.5, NaN, Infinity, MAX_RESPONSE_TOKENS + 1]) assert.throws(() => validateInferenceConfiguration({ ...config, maxResponseTokens }));
});

test("reasoning choices match provider adapters and reject unsupported or ambiguous controls", () => {
  const config = { apiBase: "https://example.test/v1", model: "model", outputMode: "json_object", writingStyle: "" };
  for (const { id: provider } of PROVIDER_PRESETS) {
    const choices = reasoningEffortsForProvider(provider);
    assert.ok(Object.isFrozen(choices));
    assert.equal(validateInferenceConfiguration({ ...config, provider }).reasoningEffort, provider === "deepseek" ? "none" : "default");
    for (const reasoningEffort of ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      if (choices.includes(reasoningEffort as any)) assert.equal(validateInferenceConfiguration({ ...config, provider, reasoningEffort }).reasoningEffort, reasoningEffort);
      else assert.throws(() => validateInferenceConfiguration({ ...config, provider, reasoningEffort }));
    }
    for (const reasoningEffort of [null, true, "auto", {}, []]) assert.throws(() => validateInferenceConfiguration({ ...config, provider, reasoningEffort }));
  }
  assert.deepEqual(reasoningEffortsForProvider("deepseek"), ["default", "none", "low", "high", "max"]);
  assert.deepEqual(reasoningEffortsForProvider("ollama"), ["default", "none", "low", "medium", "high"]);
  assert.deepEqual(reasoningEffortsForProvider("lmstudio"), reasoningEffortsForProvider("ollama"));
  assert.throws(() => validateInferenceConfiguration({ ...config, provider: "deepseek", thinking: "enabled", reasoningEffort: "low" }));
});

test("legacy thinking migrates to canonical effort without retaining the obsolete field", () => {
  const config = { provider: "deepseek", apiBase: "https://api.deepseek.com", model: "synthetic-model", outputMode: "json_object", writingStyle: "" };
  for (const [thinking, reasoningEffort] of [["enabled", "high"], ["disabled", "none"]]) {
    const checked = validateInferenceConfiguration({ ...config, thinking }, { allowLegacyThinking: true });
    assert.equal(checked.reasoningEffort, reasoningEffort);
    assert.equal(Object.hasOwn(checked, "thinking"), false);
    assert.throws(() => validateInferenceConfiguration({ ...config, thinking }));
  }
  for (const thinking of [null, true, "auto", { type: "enabled" }]) assert.throws(() => validateInferenceConfiguration({ ...config, thinking }));
  for (const provider of ["openai", "openrouter", "ollama", "lmstudio", "custom"]) assert.equal(validateInferenceConfiguration({ ...config, provider, thinking: "enabled" }, { allowLegacyThinking: true }).reasoningEffort, "default");
});
