import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function popupHarness(name: "popup" | "message-popup") {
  const elements = new Map<string, any>();
  const calls: any[] = [];
  const element = (selector: string): any => {
    if (!elements.has(selector)) {
      const attributes = new Map<string, string>();
      elements.set(selector, {
        value: "", textContent: "", hidden: false, disabled: false,
        listeners: new Map<string, (event?: unknown) => unknown>(), attributes,
        addEventListener(type: string, listener: (event?: unknown) => unknown) { this.listeners.set(type, listener); },
        setAttribute(key: string, value: string) { attributes.set(key, value); },
        removeAttribute(key: string) { attributes.delete(key); },
        focus() { this.focused = true; },
        append(child: any) { if (selector === "#agent") this.value = child.value; },
        replaceChildren() {},
      });
    }
    return elements.get(selector);
  };
  element("#action").value = name === "popup" ? "improve" : "summarize";
  const source = await readFile(new URL(`../packages/thunderbird-extension/src/${name}.js`, import.meta.url), "utf8");
  vm.runInNewContext(source, {
    document: { querySelector: element, createElement() { return {}; } },
    window: { addEventListener() {}, close() {} },
    browser: {
      tabs: { async query() { return [{ id: 1 }]; } },
      runtime: { async sendMessage(message: any) {
        calls.push(structuredClone(message));
        if (message.type.endsWith(".initialize")) return {
          agents: [{ agentId: "model", model: "model" }], selectedAgentId: "model",
          selection: { text: "Draft" }, preferredLanguage: "English", capture: { characters: 5 },
          detected: { languages: [{ language: "fr" }] },
        };
        return { jobId: "job", state: "error", error: "Synthetic completion" };
      } },
    },
    setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { calls, element, async emit(selector: string, type: string) { await element(selector).listeners.get(type)?.(); } };
}

test("compose action prompts identify missing tone, language and custom instructions before sending", async () => {
  const h = await popupHarness("popup");
  for (const [action, label, placeholder, error] of [
    ["tone", "Desired tone (required)", "warm and professional", "Describe the tone you want"],
    ["translate", "Target language (required)", "Spanish", "Enter a target language"],
    ["ask", "Instruction (required)", "Describe how to revise", "Enter an instruction"],
  ]) {
    h.element("#action").value = action;
    await h.emit("#action", "change");
    assert.equal(h.element("#instruction-label").textContent, label);
    assert.ok(h.element("#instruction").placeholder.includes(placeholder!));
    assert.equal(h.element("#instruction").required, true);
    h.element("#instruction").value = " \n ";
    await h.emit("#run", "click");
    assert.equal(h.element("#instruction").focused, true);
    assert.equal(h.element("#instruction").attributes.get("aria-invalid"), "true");
    assert.ok(h.element("#error").textContent.includes(error!));
    assert.equal(h.calls.some((message) => message.type === "popup.transform"), false);
  }
});

test("compose action prompts preserve freeform instructions and optional default actions", async () => {
  const h = await popupHarness("popup");
  for (const [action, instruction] of [["tone", "Warm, concise and reassuring"], ["translate", "To French; preserve product names"], ["ask", "Use three paragraphs"], ["improve", ""]]) {
    h.element("#action").value = action;
    await h.emit("#action", "change");
    h.element("#instruction").value = ` ${instruction} `;
    await h.emit("#run", "click");
    const sent = h.calls.at(-1);
    assert.equal(sent.type, "popup.transform");
    assert.equal(sent.action, action);
    assert.equal(sent.instruction, instruction);
  }
  assert.equal(h.element("#instruction").required, false);
  assert.equal(h.element("#instruction-label").textContent, "Instruction (optional)");
});

test("received message translation accepts Auto-detect source without requiring a source language", async () => {
  const h = await popupHarness("message-popup");
  h.element("#action").value = "translate";
  await h.emit("#action", "change");
  assert.equal(h.element("#source-language").placeholder, "Auto-detect (fr)");
  for (const source of ["", "Auto-detect", "AUTO-DETECT", "French"]) {
    h.element("#source-language").value = source;
    await h.emit("#run", "click");
    const sent = h.calls.at(-1);
    assert.equal(sent.type, "messagePopup.transform");
    assert.equal(sent.sourceLanguage, source === "French" ? "French" : null);
    assert.equal(sent.targetLanguage, "English");
  }
  h.element("#target-language").value = " ";
  const count = h.calls.length;
  await h.emit("#run", "click");
  assert.equal(h.calls.length, count);
  assert.equal(h.element("#error").textContent, "Choose a target language.");
});
