/* Shared, text-only rendering for locally compared, validated compose content. */
globalThis.ThunderClawPreview = (() => {
  const MAX_DIFF_TOKENS = 400;
  const MAX_DIFF_CELLS = 40_000;
  const MAX_DIFF_PARTS = 500;

  function text(parent, value) { parent.append(document.createTextNode(value)); }
  function marked(parent, tag, value) {
    const node = document.createElement(tag);
    text(node, value);
    parent.append(node);
  }
  function tokens(value) { return value.match(/\s+|\S+/gu) ?? []; }

  function changedText(parent, original, proposed) {
    if (original === proposed) { text(parent, original); return; }
    const before = tokens(original); const after = tokens(proposed);
    if (before.length > MAX_DIFF_TOKENS || after.length > MAX_DIFF_TOKENS || before.length * after.length > MAX_DIFF_CELLS) {
      marked(parent, "del", original); marked(parent, "ins", proposed); return;
    }
    const width = after.length + 1;
    const table = new Uint16Array((before.length + 1) * width);
    for (let i = before.length - 1; i >= 0; i -= 1) for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    const parts = []; let i = 0; let j = 0;
    while (i < before.length || j < after.length) {
      let kind; let value;
      if (i < before.length && j < after.length && before[i] === after[j]) { kind = "same"; value = before[i++]; j += 1; }
      else if (i < before.length && (j === after.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) { kind = "del"; value = before[i++]; }
      else { kind = "ins"; value = after[j++]; }
      if (parts.at(-1)?.kind === kind) parts.at(-1).value += value;
      else parts.push({ kind, value });
      if (parts.length > MAX_DIFF_PARTS) { parent.replaceChildren(); marked(parent, "del", original); marked(parent, "ins", proposed); return; }
    }
    for (const part of parts) part.kind === "same" ? text(parent, part.value) : marked(parent, part.kind, part.value);
  }

  function spans(parent, values) {
    if (!Array.isArray(values)) throw new Error("The rich preview is invalid.");
    for (const span of values) {
      if (!span || typeof span.text !== "string") throw new Error("The rich preview is invalid.");
      const marks = span.marks ?? [];
      if (!Array.isArray(marks)) throw new Error("The rich preview is invalid.");
      let node = document.createTextNode(span.text);
      for (const mark of [...marks].reverse()) {
        const tag = { bold: "b", italic: "i", underline: "u" }[mark];
        if (!tag) throw new Error("The rich preview is invalid.");
        const wrapper = document.createElement(tag); wrapper.append(node); node = wrapper;
      }
      parent.append(node);
    }
  }

  function rich(parent, blocks) {
    if (!Array.isArray(blocks)) throw new Error("The rich preview is invalid.");
    for (const block of blocks) {
      if (block?.type === "paragraph") {
        const paragraph = document.createElement("p"); spans(paragraph, block.spans); parent.append(paragraph);
      } else if (block?.type === "unordered_list" || block?.type === "ordered_list") {
        if (!Array.isArray(block.items)) throw new Error("The rich preview is invalid.");
        const list = document.createElement(block.type === "unordered_list" ? "ul" : "ol");
        for (const item of block.items) {
          const li = document.createElement("li"); spans(li, item?.spans); list.append(li);
        }
        parent.append(list);
      } else throw new Error("The rich preview is invalid.");
    }
  }

  function list(parent, kind, items) {
    if (!["ul", "ol"].includes(kind) || !Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new Error("The list preview is invalid.");
    const node = document.createElement(kind);
    for (const item of items) { const li = document.createElement("li"); text(li, item); node.append(li); }
    parent.append(node);
  }

  function render(container, result, view) {
    if (!container || !result || !["changes", "original", "proposed"].includes(view)) throw new Error("The preview is invalid.");
    container.replaceChildren();
    const original = result.original;
    const proposed = result.replacement;
    if (typeof original !== "string" || typeof proposed !== "string") throw new Error("The preview is invalid.");
    if (result.selectionShape === "flat-list-items") {
      const before = result.originalItems; const after = result.replacementItems;
      if (result.listKind !== "ul" && result.listKind !== "ol") throw new Error("The list preview is invalid.");
      if (view !== "changes") { list(container, result.listKind, view === "original" ? before : after); return; }
      if (!Array.isArray(before) || !Array.isArray(after) || before.some((v) => typeof v !== "string") || after.some((v) => typeof v !== "string")) throw new Error("The list preview is invalid.");
      const node = document.createElement(result.listKind === "ol" ? "ol" : "ul");
      for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
        const li = document.createElement("li");
        if (before[i] === after[i]) text(li, before[i]);
        else { if (before[i] !== undefined) marked(li, "del", before[i]); if (after[i] !== undefined) marked(li, "ins", after[i]); }
        node.append(li);
      }
      container.append(node); return;
    }
    if (result.selectionShape === "rich-blocks") {
      const before = result.originalBlocks; const after = result.replacementBlocks;
      if (view !== "changes") { rich(container, view === "original" ? before : after); return; }
      if (JSON.stringify(before) === JSON.stringify(after)) rich(container, before);
      else { const removed = document.createElement("del"); rich(removed, before); container.append(removed);
        const inserted = document.createElement("ins"); rich(inserted, after); container.append(inserted); }
      return;
    }
    if (result.selectionShape !== "text-range") throw new Error("The preview shape is invalid.");
    if (view === "original") text(container, original);
    else if (view === "proposed") text(container, proposed);
    else changedText(container, original, proposed);
  }
  return Object.freeze({ render });
})();
