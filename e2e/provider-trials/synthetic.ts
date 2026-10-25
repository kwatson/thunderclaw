import { readFileSync } from "node:fs";
import { CONFIGURED_MODEL_ID } from "../../packages/thunderbird-extension/src/inference-client.js";
import type { TransformComposeRequest, TransformMessageRequest } from "../../packages/thunderbird-extension/src/direct-client-contract.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/provider-trials/newsletter.json", import.meta.url), "utf8")) as {
  subject: string; author: string; repetitions: number; paragraphs: string[];
};
export function newsletterSegments() {
  return Array.from({ length: fixture.repetitions }, (_, edition) => fixture.paragraphs.map((text, paragraph) => ({
    id: `newsletter-${edition}-${paragraph}`, text: `Edition ${edition + 1}: ${text}`,
  }))).flat();
}
export type ProviderTrial = { name: string; request: TransformComposeRequest | TransformMessageRequest };
export function syntheticTrials(): ProviderTrial[] {
  const text = "The team have reviewed the preliminary results. We cannot confirm delivery before Friday.";
  const actions: TransformComposeRequest["action"][] = ["improve", "proofread", "shorten", "tone", "translate", "summarize", "ask"];
  const instructions: Partial<Record<TransformComposeRequest["action"], string>> = {
    tone: "Use a professional, friendly tone.", translate: "Translate into French.", ask: "Change team to group; preserve every qualification.",
  };
  const compose = (name: string, action: TransformComposeRequest["action"]): ProviderTrial => ({ name, request: {
    protocolVersion: 1, requestId: name, runId: `run-${name}`, agentId: CONFIGURED_MODEL_ID,
    composeId: "synthetic-compose", composeGeneration: 1, action, instruction: instructions[action],
    contextHash: "synthetic-context", targetHash: `target-${name}`,
    document: { subject: "Synthetic draft", recipients: [], authoredText: text },
    target: { targetId: "selection", text, start: 0, end: text.length },
    limits: { maxOperations: 1, maxOutputCharacters: 8_000 },
  } });
  const trials = actions.map(action => compose(`compose-${action}`, action));
  const rich = compose("compose-rich-formatting", "proofread");
  if ("target" in rich.request) rich.request.target = { ...rich.request.target, selectionShape: "rich-blocks", blocks: [
    { type: "paragraph", spans: [{ text: "The team ", marks: ["bold"] }, { text: "have reviewed the preliminary results. ", marks: ["italic"] }, { text: "We cannot confirm delivery before Friday.", marks: ["underline"] }] },
  ] };
  const list = compose("compose-list", "proofread");
  if ("target" in list.request) list.request.target = { ...list.request.target, text: "Review results\nConfirm availability", end: "Review results\nConfirm availability".length, selectionShape: "flat-list-items", items: ["Review results", "Confirm availability"] };
  trials.push(rich, list);
  for (const action of ["summarize", "translate"] as const) {
    trials.push({ name: `received-newsletter-${action}-auto`, request: {
      protocolVersion: 1, requestId: `received-${action}`, runId: `received-run-${action}`, agentId: CONFIGURED_MODEL_ID,
      action, sourceLanguage: null, targetLanguage: action === "translate" ? "French" : "English", messageHash: "synthetic-newsletter",
      document: { subject: fixture.subject, author: fixture.author, segments: newsletterSegments() },
      limits: { maxSegments: 400, maxOutputCharacters: 100_000 },
    } });
  }
  return trials;
}

/** A bounded provider envelope, deliberately incomplete despite content being present. */
export const truncatedCompletion = Object.freeze({ choices: [{ finish_reason: "length", message: {
  role: "assistant", content: '{"detectedLanguage":"en","translations":["incomplete',
} }] });

export function syntheticCompletion(prompt: Record<string, unknown>) {
  if (Array.isArray(prompt.segments)) return prompt.action === "translate"
    ? { detectedLanguage: "en", translations: prompt.segments.map((_, index) => `Traduction synthétique ${index + 1}.`) }
    : { detectedLanguage: "en", summary: { title: "Synthetic observatory update", bullets: ["The sender describes preliminary results and a conditional Friday inspection."] } };
  return { ...(prompt.selectionShape === "rich-blocks" ? { blocks: prompt.blocks } : prompt.selectionShape === "flat-list-items" ? { items: prompt.items } : { text: prompt.text }), summary: "Synthetic deterministic result." };
}
