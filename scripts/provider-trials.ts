import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DirectClientError, type ConnectionBinding } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { InferenceClient } from "../packages/thunderbird-extension/src/inference-client.js";
import { canonicalizeInferenceBase, DEFAULT_MAX_RESPONSE_TOKENS, PROVIDER_PRESETS, validateInferenceConfiguration } from "../packages/thunderbird-extension/src/inference-provider.js";
import { syntheticCompletion, syntheticTrials, truncatedCompletion } from "../e2e/provider-trials/synthetic.js";

const usage = `ThunderClaw synthetic provider trials
Usage: mise exec -- npx tsx scripts/provider-trials.ts [--case NAME]
       mise exec -- npx tsx scripts/provider-trials.ts --live --provider ID --api-base URL --model ID
         [--api-key-file PATH] [--output-mode json_schema|json_object]
         [--max-response-tokens N] [--reasoning-effort LEVEL] [--case NAME]
Default: deterministic in-memory provider, no network or saved credentials.
--live explicitly sends synthetic fixtures to the selected provider (up to 11 paid calls).
Keys are read only from --api-key-file; raw keys and user message inputs are unsupported.
Use --case received-newsletter-translate-auto for the long auto-detection regression.
`;

export async function runProviderTrials(argv: string[], write: (line: string) => void = console.log): Promise<number> {
  if (argv.includes("--help")) { write(usage); return 0; }
  let live = false;
  const values = new Map<string, string>();
  const allowed = new Set(["--provider", "--api-base", "--model", "--api-key-file", "--output-mode", "--max-response-tokens", "--reasoning-effort", "--case"]);
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--live" && !live) { live = true; continue; }
    if (!allowed.has(name) || values.has(name) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error("Invalid provider trial arguments. Use --help; never pass a raw API key.");
    }
    values.set(name, argv[++index]);
  }
  if (!live && [...values.keys()].some(name => name !== "--case")) throw new Error("Provider settings require the explicit --live option.");
  if (live && ["--provider", "--api-base", "--model"].some(name => !values.has(name))) throw new Error("Live trials require --provider, --api-base and --model.");
  const preset = PROVIDER_PRESETS.find(preset => preset.id === values.get("--provider"));
  const configuration = validateInferenceConfiguration({
    provider: values.get("--provider") ?? "custom", apiBase: values.get("--api-base") ?? "http://127.0.0.1:1/v1",
    model: values.get("--model") ?? "synthetic-model", outputMode: values.get("--output-mode") ?? preset?.outputMode ?? "json_schema", writingStyle: "Clear and concise.",
    maxResponseTokens: Number(values.get("--max-response-tokens") ?? DEFAULT_MAX_RESPONSE_TOKENS), reasoningEffort: values.get("--reasoning-effort") ?? "none",
  });
  const selected = syntheticTrials().filter(trial => !values.has("--case") || trial.name === values.get("--case"));
  if (!selected.length) throw new Error("Unknown synthetic trial case. Use --help.");
  let key = "";
  if (live && values.has("--api-key-file")) {
    try { key = (await readFile(values.get("--api-key-file")!, "utf8")).trim(); }
    catch { throw new Error("Could not read the API key file."); }
  }
  const endpoint = canonicalizeInferenceBase(configuration.apiBase);
  const binding: ConnectionBinding = { apiBase: endpoint.apiBase, origin: endpoint.origin, permissionId: endpoint.permissionPattern,
    credential: { mode: "device_credential", credentialId: "synthetic-provider-trial" }, epoch: 1 };
  const mockFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(syntheticCompletion(JSON.parse(body.messages[1].content))) } }] });
  };
  const client = new InferenceClient(configuration, key, binding, live ? {} : { fetchImpl: mockFetch });
  let failures = 0;
  for (const trial of selected) {
    const request = trial.request;
    const started = Date.now();
    try {
      if ("target" in request) {
        await client.openCompose(request);
        await client.transformCompose(request);
      } else await client.transformMessage(request);
      write(JSON.stringify({ mode: live ? "live" : "mock", case: trial.name, status: "passed", validation: "structured-output-contract", elapsedMs: Date.now() - started,
        ...( "document" in request && "segments" in request.document ? { sourceSegments: request.document.segments.length,
          sourceCharacters: request.document.segments.reduce((total, segment) => total + segment.text.length, 0) } : {}) }));
    } catch (error) {
      failures++;
      write(JSON.stringify({ mode: live ? "live" : "mock", case: trial.name, status: "failed", elapsedMs: Date.now() - started,
        code: error instanceof DirectClientError ? error.code : "TRIAL_FAILED",
        message: error instanceof DirectClientError ? error.message : "The synthetic trial failed." }));
      // Explicit live runs stop on the first failure; no retries or extra spending.
      if (live) break;
    }
  }
  // The token-exhaustion reproducer is always local, including during live runs.
  const truncated = new InferenceClient({ ...configuration, provider: "custom" }, "", binding, { fetchImpl: async () => Response.json(truncatedCompletion) });
  try {
    await truncated.transformMessage(syntheticTrials().find(trial => trial.name === "received-newsletter-translate-auto")!.request as Parameters<InferenceClient["transformMessage"]>[0]);
    failures++;
    write(JSON.stringify({ mode: "mock", case: "truncated-output", status: "failed", code: "TRUNCATION_NOT_REJECTED" }));
  } catch (error) {
    const expected = error instanceof DirectClientError && error.code === "INFERENCE_OUTPUT_LIMIT" && /Increase Response token limit/u.test(error.message);
    if (!expected) failures++;
    write(JSON.stringify({ mode: "mock", case: "truncated-output", status: expected ? "passed" : "failed",
      code: error instanceof DirectClientError ? error.code : "TRIAL_FAILED",
      message: error instanceof DirectClientError ? error.message : "The synthetic truncation check failed." }));
  }
  return failures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runProviderTrials(process.argv.slice(2)); }
  catch (error) {
    // Configuration and file errors above are fixed local strings, never provider output.
    console.error(error instanceof DirectClientError || error instanceof Error ? error.message : "Provider trial setup failed.");
    process.exitCode = 1;
  }
}
