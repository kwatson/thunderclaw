import { canonicalizeInferenceBase, DEFAULT_MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS, PROVIDER_PRESETS, reasoningEffortsForProvider, supportsModelDiscovery, validateInferenceConfiguration, type InferenceConfiguration, type ProviderId, type ReasoningEffort } from "./inference-provider.js";
import { inferenceFailureMessage } from "./inference-client.js";
import { randomId } from "./random-id.js";

declare const browser: any;
const PORT_NAME = "thunderclaw-inference-options-v1";
function element<T extends HTMLElement>(id: string): T {
  const item = document.getElementById(id);
  if (!item) throw new Error(`Missing options element: ${id}`);
  return item as T;
}
element("build-version").textContent = `Version ${browser.runtime.getManifest().version}`;
const form = element<HTMLFormElement>("connection-form");
const consent = element<HTMLInputElement>("consent-accepted");
const provider = element<HTMLSelectElement>("provider");
const endpoint = element<HTMLInputElement>("endpoint");
const key = element<HTMLInputElement>("api-key");
const removeKey = element<HTMLInputElement>("remove-key");
const model = element<HTMLInputElement>("model");
const mode = element<HTMLSelectElement>("output-mode");
const maxResponseTokens = element<HTMLInputElement>("max-response-tokens");
const thinking = element<HTMLSelectElement>("thinking");
const thinkingProviderHelp = element<HTMLElement>("thinking-provider-help");
const style = element<HTMLTextAreaElement>("writing-style");
const state = element<HTMLElement>("state");
const result = element<HTMLElement>("result");
const models = element<HTMLButtonElement>("available-models");
const modelList = element<HTMLElement>("model-options");
const modelChoices = element<HTMLElement>("model-choices");
const modelStatus = element<HTMLElement>("model-status");
const modelProviderHelp = element<HTMLElement>("model-provider-help");
const save = element<HTMLButtonElement>("save");
const load = element<HTMLButtonElement>("load-models");
const test = element<HTMLButtonElement>("test");
const forget = element<HTMLButtonElement>("forget");
const port = browser.runtime.connect({ name: PORT_NAME });
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let busy = false;
let configured = false;
let closed = false;
let dirty = false;
let discoveryGeneration = 0;
let discovering = false;
let modelOptions: HTMLElement[] = [];
let activeModel = -1;
let modelSearch = "";
let modelSearchTime = 0;
let savedKeyScope: { provider: string; apiBase: string } | undefined;
class SettingsActionError extends Error {
  constructor(readonly kind: string, readonly code?: string) { super("Settings action failed"); }
}
function actionError(error: unknown, discovery = false): string {
  if (error instanceof SettingsActionError && error.code) {
    if (error.code === "INVALID_RESPONSE_TOKEN_LIMIT") return `Enter a whole-number response token limit from 1 to ${MAX_RESPONSE_TOKENS.toLocaleString("en-US")}.`;
    const message = inferenceFailureMessage(error.code);
    if (message) return message;
  }
  const messages: Record<string, string> = {
    configuration: "Check the API base URL, API key, and structured output mode.",
    permission: "Endpoint access was not granted. Try again and allow access to your chosen endpoint.",
    authentication: "The endpoint did not accept the API key. Check or replace the key and try again.",
    network: "Could not reach the endpoint. Check the API base URL and your connection, then try again.",
    timeout: "The request timed out. Check your connection and try again.",
    contract: discovery ? "The endpoint returned an unsupported model list. Enter an exact model ID manually, or check the API base URL." : "The model returned an unsupported result. Check its structured output support.",
    storage: "ThunderClaw could not save or load local settings. Reopen settings and try again.",
    backend: "The endpoint could not complete the request. Try again later.",
    rate_limit: "The endpoint is limiting requests. Wait a moment and try again.",
    cancellation: "The connection changed. Try again with the current settings.",
    closed: "The settings connection closed. Reopen settings.",
  };
  return error instanceof SettingsActionError && Object.hasOwn(messages, error.kind) ? messages[error.kind] : "The connection action failed. Check the endpoint settings and try again.";
}
function showModels(message: string, error = false): void {
  modelStatus.textContent = message;
  modelStatus.dataset.kind = error ? "error" : "success";
  modelStatus.setAttribute("role", error ? "alert" : "status");
}
function show(message: string, error = false): void {
  result.textContent = message;
  result.dataset.kind = error ? "error" : "success";
  result.setAttribute("role", error ? "alert" : "status");
}
function request(method: string, extra: Record<string, unknown> = {}): Promise<any> {
  if (closed) return Promise.reject(new SettingsActionError("closed"));
  const requestId = randomId();
  return new Promise((resolve, reject) => {
    // Model discovery and the synthetic test may use the client's 180-second network budget.
    const timer = setTimeout(() => { pending.delete(requestId); reject(new SettingsActionError("timeout")); }, ["listModels", "test"].includes(method) ? 195_000 : 15_000);
    pending.set(requestId, { resolve, reject, timer });
    try { port.postMessage({ requestId, method, ...extra }); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(new SettingsActionError("closed")); }
  });
}
port.onMessage.addListener((message: any) => {
  if (!message || typeof message.requestId !== "string") return;
  const item = pending.get(message.requestId);
  if (!item) return;
  pending.delete(message.requestId);
  clearTimeout(item.timer);
  if (message.ok === true) item.resolve(message.value);
  else item.reject(new SettingsActionError(typeof message.error?.kind === "string" ? message.error.kind : "unknown", typeof message.error?.code === "string" && inferenceFailureMessage(message.error.code) ? message.error.code : undefined));
});
port.onDisconnect.addListener(() => {
  closed = true;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new SettingsActionError("closed")); }
  pending.clear();
  key.value = "";
  show("The settings connection closed. Reopen settings.", true);
  if (discovering) showModels("The settings connection closed. Reopen settings.", true);
  controls();
});
function controls(): void {
  const canDiscover = supportsModelDiscovery(provider.value as ProviderId);
  save.disabled = busy || closed;
  load.disabled = busy || closed || !canDiscover;
  test.disabled = busy || closed || !configured || dirty;
  forget.disabled = busy || closed || !configured;
  load.textContent = discovering ? "Loading models…" : "Load models";
  load.setAttribute("aria-busy", String(discovering));
  modelProviderHelp.textContent = canDiscover ? "" : "Fireworks AI: copy the exact full model, router, or deployment ID from Fireworks and enter it manually. For example: accounts/fireworks/models/deepseek-v4p1-flash-1017. Load models is unavailable.";
  model.placeholder = canDiscover ? "Enter an exact model ID" : "accounts/fireworks/models/deepseek-v4p1-flash-1017";
  models.disabled = busy || closed;
  if (models.disabled) closeModelList();
}
function render(value: any, populate = false): void {
  configured = value.configured === true;
  savedKeyScope = value.hasKey === true && value.configuration ? { provider: value.configuration.provider, apiBase: value.configuration.apiBase } : undefined;
  const messages: Record<string, string> = { not_configured: "Set up your inference connection.", permission_required: "Endpoint access is required. Save or test to grant access.", key_required: "This provider needs an API key.", untested: "Connection saved. Test it before generating.", ready: "Connection tested and ready." };
  state.textContent = messages[value.phase] ?? "Check your connection settings.";
  state.dataset.phase = String(value.phase);
  element("connection-panel").dataset.phase = String(value.phase);
  if (populate && value.configured) consent.checked = true;
  element("migration").hidden = value.legacyMigration !== true;
  element("key-status").textContent = value.hasKey ? "A key is saved. Enter a new key to replace it." : "No key saved.";
  if (populate && value.configuration) {
    const config = validateInferenceConfiguration(value.configuration);
    provider.value = config.provider; endpoint.value = config.apiBase; model.value = config.model; mode.value = config.outputMode; style.value = config.writingStyle;
    maxResponseTokens.value = String(config.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS);
    renderThinking(config.reasoningEffort);
  }
  if (value.permissionCleanupPending) show("Connection updated. Old host access could not be removed; review ThunderClaw permissions in Add-ons Manager.", true);
  controls();
}
function renderThinking(effort: ReasoningEffort = provider.value === "deepseek" ? "none" : "default"): void {
  const labels: Record<ReasoningEffort, string> = { default: "Model default", none: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Maximum" };
  thinking.replaceChildren(...reasoningEffortsForProvider(provider.value as ProviderId).map((value) => {
    const option = document.createElement("option"); option.value = value; option.textContent = labels[value]; return option;
  }));
  thinking.value = effort;
  thinkingProviderHelp.textContent = provider.value === "ollama" || provider.value === "lmstudio"
    ? "Some local models use their own thinking levels; use Model default if unsure."
    : provider.value === "fireworks"
      ? "Fireworks models may reject or reinterpret an explicit thinking level. Use Model default when unsure."
    : provider.value === "custom"
      ? "Choosing a level other than Model default requires your compatible server to support OpenAI reasoning_effort."
      : provider.value === "deepseek" ? "Off is the default for DeepSeek email editing and translation." : "Model default leaves the thinking level to your model and server.";
}
function responseConfiguration(): Pick<InferenceConfiguration, "maxResponseTokens" | "reasoningEffort"> {
  const limit = Number(maxResponseTokens.value);
  if (!maxResponseTokens.value.trim() || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESPONSE_TOKENS) throw new SettingsActionError("configuration", "INVALID_RESPONSE_TOKEN_LIMIT");
  return { maxResponseTokens: limit, reasoningEffort: thinking.value as ReasoningEffort };
}
function configuration(): InferenceConfiguration { return validateInferenceConfiguration({ provider: provider.value, apiBase: endpoint.value, model: model.value, outputMode: mode.value, writingStyle: style.value, ...responseConfiguration() }); }
async function run(operation: () => Promise<void>, reportError: (error: unknown) => void = (error) => show(actionError(error), true)): Promise<void> {
  if (busy || closed) return;
  busy = true; controls();
  try { await operation(); } catch (error) { reportError(error); }
  finally { busy = false; controls(); }
}
function closeModelList(): void {
  modelList.hidden = true;
  models.setAttribute("aria-expanded", "false");
  models.removeAttribute("aria-activedescendant");
  modelSearch = "";
}
function syncModelChoice(): void {
  const selected = modelOptions.find((option) => option.dataset.value === model.value);
  models.textContent = selected?.textContent ?? "Choose a model…";
  for (const option of modelOptions) option.setAttribute("aria-selected", String(option === selected));
}
function activateModel(index: number): void {
  activeModel = index;
  for (const [i, option] of modelOptions.entries()) option.dataset.active = String(i === index);
  const option = modelOptions[index];
  if (option) {
    models.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  }
}
function openModelList(last = false): void {
  if (models.disabled || !modelOptions.length) return;
  modelList.hidden = false;
  models.setAttribute("aria-expanded", "true");
  const selected = modelOptions.findIndex((option) => option.dataset.value === model.value);
  activateModel(selected >= 0 ? selected : last ? modelOptions.length - 1 : 0);
}
function chooseModel(index: number): void {
  const option = modelOptions[index];
  if (!option || models.disabled) return;
  model.value = option.dataset.value!;
  syncModelChoice();
  closeModelList();
  markDirty();
  models.focus();
}
function resetModelChoices(): void {
  closeModelList();
  modelOptions = [];
  modelList.replaceChildren();
  models.textContent = "Choose a model…";
  modelChoices.hidden = true;
}
function clearModels(): void { discoveryGeneration += 1; resetModelChoices(); showModels(discovering ? "Settings changed. Waiting for the previous model request to finish." : ""); }
function markDirty(invalidateModels = false): void { dirty = true; if (invalidateModels) clearModels(); controls(); }
provider.addEventListener("change", () => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === provider.value);
  if (preset) { endpoint.value = preset.apiBase; mode.value = preset.outputMode; model.value = ""; key.value = ""; }
  renderThinking();
  markDirty(true);
});
for (const input of [endpoint, key, removeKey]) input.addEventListener("input", () => markDirty(true));
for (const input of [model, mode, style, thinking, maxResponseTokens]) input.addEventListener("input", () => { if (input === model) syncModelChoice(); markDirty(); });
thinking.addEventListener("change", () => markDirty());
models.addEventListener("click", () => { if (modelList.hidden) openModelList(); else closeModelList(); });
models.addEventListener("keydown", (event) => {
  if (models.disabled || !modelOptions.length) return;
  const open = !modelList.hidden;
  if (event.key === "Tab") { closeModelList(); return; }
  if (event.key === "Escape") { if (open) event.preventDefault(); closeModelList(); return; }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (open) chooseModel(activeModel); else openModelList();
    return;
  }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (!open) openModelList(event.key === "ArrowUp");
    else if (event.key === "ArrowDown") activateModel(Math.min(activeModel + 1, modelOptions.length - 1));
    else if (event.key === "ArrowUp") activateModel(Math.max(activeModel - 1, 0));
    if (event.key === "Home") activateModel(0);
    if (event.key === "End") activateModel(modelOptions.length - 1);
    return;
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    if (!open) openModelList();
    const now = Date.now();
    modelSearch = now - modelSearchTime > 700 ? event.key : modelSearch + event.key;
    modelSearchTime = now;
    const search = modelSearch.toLocaleLowerCase();
    const repeated = [...search].every((character) => character === search[0]);
    for (let offset = 1; offset <= modelOptions.length; offset += 1) {
      const index = (activeModel + offset) % modelOptions.length;
      if (modelOptions[index].textContent?.toLocaleLowerCase().startsWith(repeated ? search[0] : search)) { activateModel(index); break; }
    }
  }
});
document.addEventListener("pointerdown", (event) => { if (!modelChoices.contains(event.target as Node)) closeModelList(); });
modelChoices.addEventListener("focusout", (event) => { if (!modelChoices.contains(event.relatedTarget as Node | null)) closeModelList(); });
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || closed) return;
  let config: InferenceConfiguration;
  let permission: Promise<boolean>;
  try {
    if (!consent.checked) { show("Confirm that selected email content may be sent to your chosen endpoint.", true); return; }
    config = configuration();
    // Thunderbird requires the permission request to start in this user gesture.
    permission = browser.permissions.request({ origins: [canonicalizeInferenceBase(config.apiBase).permissionPattern] });
  } catch (error) { show(error instanceof SettingsActionError ? actionError(error) : "Enter a valid API base URL, model ID, and output mode.", true); return; }
  const apiKey = key.value;
  const keyAction = removeKey.checked ? "remove" : apiKey ? "replace" : "preserve";
  key.value = "";
  show("Saving connection…");
  void run(async () => {
    if (!await permission) { show("Endpoint access was not granted.", true); return; }
    const value = await request("save", { configuration: config, keyAction, consentAccepted: true, ...(keyAction === "replace" ? { apiKey } : {}) });
    dirty = false; removeKey.checked = false; render(value, true); show("Connection saved. Test it before generating.");
  });
});
load.addEventListener("click", () => {
  if (busy || closed || !supportsModelDiscovery(provider.value as ProviderId)) return;
  let permission: Promise<boolean>;
  let draft: Record<string, unknown>;
  const apiKey = removeKey.checked ? "" : key.value || undefined;
  try {
    const apiBase = canonicalizeInferenceBase(endpoint.value);
    draft = { provider: provider.value, apiBase: apiBase.apiBase, model: model.value, outputMode: mode.value, writingStyle: style.value, ...responseConfiguration() };
    validateInferenceConfiguration({ ...draft, model: "thunderclaw-model-discovery" });
    const requiresKey = PROVIDER_PRESETS.find((item) => item.id === provider.value)?.requiresKey;
    const hasSavedKey = savedKeyScope?.provider === provider.value && savedKeyScope.apiBase === apiBase.apiBase;
    if (requiresKey && !apiKey && (removeKey.checked || !hasSavedKey)) { showModels("Enter an API key for this provider, then click Load models. You can choose a model before saving.", true); return; }
    if (apiKey && (apiKey.length > 4096 || /[\s\u0000-\u001F\u007F]/u.test(apiKey))) { showModels("Enter an API key without spaces or line breaks, then try again.", true); return; }
    permission = browser.permissions.request({ origins: [apiBase.permissionPattern] });
  } catch (error) { showModels(error instanceof SettingsActionError ? actionError(error) : "Enter a valid API base URL and structured output mode, then try again.", true); return; }
  const generation = discoveryGeneration;
  discovering = true;
  resetModelChoices();
  showModels("Loading models from your chosen endpoint…");
  void run(async () => {
    if (!await permission) throw new SettingsActionError("permission");
    if (generation !== discoveryGeneration) return;
    const ids = await request("listModels", { configuration: draft, ...(apiKey !== undefined ? { apiKey } : {}) });
    if (generation !== discoveryGeneration) return;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256 || /[\u0000-\u001F\u007F]/u.test(id))) throw new SettingsActionError("contract");
    if (ids.length === 0) { showModels("The endpoint returned no models. Enter an exact model ID manually, or check which models your provider makes available."); return; }
    for (const [index, id] of ids.entries()) {
      const option = document.createElement("div");
      option.id = `model-option-${generation}-${index}`;
      option.setAttribute("role", "option");
      option.dataset.value = id;
      option.textContent = id;
      // Keep focus on the combobox until click commits the choice.
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => chooseModel(index));
      modelOptions.push(option);
      modelList.append(option);
    }
    syncModelChoice();
    modelChoices.hidden = false;
    showModels(`${ids.length} ${ids.length === 1 ? "model" : "models"} loaded. Choose a model below, or enter an exact model ID. Then save and test.`);
  }, (error) => { if (generation === discoveryGeneration) showModels(actionError(error, true), true); }).finally(() => {
    discovering = false;
    if (!closed && generation !== discoveryGeneration) showModels(supportsModelDiscovery(provider.value as ProviderId)
      ? "Settings changed. Load models again for this connection."
      : "Settings changed. Enter the exact model ID manually for Fireworks AI.");
    controls();
  });
});
test.addEventListener("click", () => {
  if (busy || closed || dirty) return;
  let permission: Promise<boolean>;
  try { permission = browser.permissions.request({ origins: [canonicalizeInferenceBase(endpoint.value).permissionPattern] }); }
  catch { show("Enter a valid API base URL.", true); return; }
  show("Testing the saved connection with synthetic text…");
  void run(async () => {
    if (!await permission) { show("Endpoint access was not granted.", true); return; }
    render(await request("test")); show("The selected model passed the synthetic connection test.");
  });
});
forget.addEventListener("click", () => { if (busy || closed) return; show("Removing the saved connection and key…"); void run(async () => {
  render(await request("forget")); key.value = ""; model.value = ""; style.value = ""; maxResponseTokens.value = String(DEFAULT_MAX_RESPONSE_TOKENS); renderThinking(); removeKey.checked = false; dirty = false;
  clearModels();
  show("Connection and key removed from this device. Revoke the key with your provider separately if needed.");
}); });
endpoint.value = PROVIDER_PRESETS[0].apiBase;
maxResponseTokens.value = String(DEFAULT_MAX_RESPONSE_TOKENS);
renderThinking();
void run(async () => { render(await request("state"), true); });
