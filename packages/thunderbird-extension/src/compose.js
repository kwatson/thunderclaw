const targets = new Map();
const undos = new Map();
const QUOTED_SELECTOR = 'blockquote[type="cite"], blockquote[cite], .moz-cite-prefix';
const NON_EDITABLE_TARGET_SELECTOR = `${QUOTED_SELECTOR}, .moz-signature`;
const SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR = 153;
const XHTML_NAMESPACE = "http:" + "//www.w3.org/1999/xhtml";
const LIST_ITEM_UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
let richApplyDisabled = false;

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function visibleText(element) {
  return element.innerText ?? element.textContent ?? "";
}

function editorSnapshot() {
  const clone = document.body.cloneNode(true);
  const quoted = Array.from(clone.querySelectorAll(QUOTED_SELECTOR));
  const quotedText = quoted.map(visibleText).filter(Boolean).join("\n");
  for (const element of quoted) element.remove();
  return { authoredText: visibleText(clone), quotedText };
}

function rangeIsInEditor(range) {
  const ancestor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer.parentNode
    : range.commonAncestorContainer;
  return ancestor && document.body.contains(ancestor);
}

function attributeTuples(element) {
  return Array.from(element.attributes, ({ namespaceURI, prefix, localName, name, value }) =>
    [namespaceURI ?? null, prefix ?? null, localName, name, value]);
}

function exactEmptyMozDirty(element) {
  return JSON.stringify(attributeTuples(element)) === JSON.stringify([[null, null, "_moz_dirty", "_moz_dirty", ""]]);
}

function supportedListShell(element) {
  return element?.namespaceURI === XHTML_NAMESPACE && ["UL", "OL"].includes(element.tagName)
    && (element.attributes.length === 0 || exactEmptyMozDirty(element));
}

function supportedPlainListItem(element) {
  return element?.namespaceURI === XHTML_NAMESPACE && element.tagName === "LI"
    && (element.attributes.length === 0 || exactEmptyMozDirty(element))
    && element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE
    && element.firstChild.data.trim().length > 0
    && !LIST_ITEM_UNSAFE_CHARACTERS.test(element.firstChild.data);
}

function exactReopenedDraftWhitespaceProfile(list, items) {
  const nodes = Array.from(list.childNodes);
  if (nodes.length !== items.length * 2 + 1) return undefined;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (index % 2 === 0) {
      if (node.nodeType !== Node.TEXT_NODE || node.data.length === 0 || !/^[\t\n\r ]+$/u.test(node.data)) return undefined;
    } else if (node !== items[(index - 1) / 2]) return undefined;
  }
  return { leading: nodes[0], leadingText: nodes[0].data,
    trailing: nodes.at(-1), trailingText: nodes.at(-1).data };
}

function directListItem(node) {
  let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (current && current !== document.body && current.tagName !== "LI") current = current.parentElement;
  const list = current?.parentElement;
  return current?.tagName === "LI" && supportedListShell(list) && list.parentNode === document.body
    ? { item: current, list }
    : undefined;
}

function structurallySpansWholeList(nodeRange) {
  if (nodeRange.startContainer === document.body && nodeRange.endContainer === document.body
    && nodeRange.endOffset === nodeRange.startOffset + 1) {
    const selected = document.body.childNodes[nodeRange.startOffset];
    if (selected?.nodeType === Node.ELEMENT_NODE && ["UL", "OL"].includes(selected.tagName)) return true;
  }
  const find = (node) => {
    let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (current && current !== document.body && current.tagName !== "LI") current = current.parentElement;
    const list = current?.parentElement;
    return current?.tagName === "LI" && ["UL", "OL"].includes(list?.tagName) && list.parentNode === document.body
      ? { item: current, list } : undefined;
  };
  const start = find(nodeRange.startContainer);
  const end = find(nodeRange.endContainer);
  return start && end && start.list === end.list
    && start.item === start.list.firstElementChild && end.item === end.list.lastElementChild;
}

function plainListTarget(list) {
  if (!supportedListShell(list) || list.parentNode !== document.body) return undefined;
  const items = Array.from(list.children);
  const childNodes = Array.from(list.childNodes);
  const directItemsOnly = childNodes.length === items.length
    && childNodes.every((node, index) => node === items[index]);
  const whitespaceProfile = directItemsOnly ? undefined : exactReopenedDraftWhitespaceProfile(list, items);
  if (items.length < 1 || items.length > 100 || (!directItemsOnly && !whitespaceProfile)
    || items.some((item) => !supportedPlainListItem(item))
    || items.reduce((sum, item) => sum + item.firstChild.data.length, 0) > 12_000) return undefined;
  return { list, elements: items, items: items.map((item) => item.firstChild.data), whitespaceProfile };
}

function completePlainListSelection(range) {
  const start = directListItem(range.startContainer);
  const end = directListItem(range.endContainer);
  if (!start || !end || start.list !== end.list) return undefined;
  const target = plainListTarget(start.list);
  if (!target) return undefined;
  const items = target.elements;
  const first = items[0].firstChild;
  const last = items.at(-1).firstChild;
  if (start.item !== items[0] || end.item !== items.at(-1)
    || range.startContainer !== first || range.startOffset !== 0
    || range.endContainer !== last || range.endOffset !== last.data.length) return undefined;
  return target;
}

function exactBodyWrapperPlainListSelection(range) {
  if (range.startContainer !== document.body || range.endContainer !== document.body
    || !Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)
    || range.startOffset < 0 || range.endOffset !== range.startOffset + 1
    || range.endOffset > document.body.childNodes.length) return undefined;
  const list = document.body.childNodes[range.startOffset];
  const target = plainListTarget(list);
  return target && target.elements.length >= 2 ? target : undefined;
}

function directBodyRoot(node) {
  let current = node;
  while (current && current.parentNode !== document.body) current = current.parentNode;
  return current?.parentNode === document.body ? current : undefined;
}

function firstTextDescendant(node) {
  if (node.nodeType === Node.TEXT_NODE) return node;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  return walker.nextNode();
}

function lastTextDescendant(node) {
  if (node.nodeType === Node.TEXT_NODE) return node;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let last;
  let current;
  while ((current = walker.nextNode())) last = current;
  return last;
}

function supportedRichInline(node, marks = []) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (!node.data.length || LIST_ITEM_UNSAFE_CHARACTERS.test(node.data)) return undefined;
    return [{ text: node.data, ...(marks.length ? { marks: [...marks] } : {}) }];
  }
  if (node.nodeType !== Node.ELEMENT_NODE || node.namespaceURI !== XHTML_NAMESPACE
    || node.attributes.length !== 0 || !["B", "I", "U"].includes(node.tagName)
    || node.childNodes.length < 1) return undefined;
  const mark = node.tagName === "B" ? "bold" : node.tagName === "I" ? "italic" : "underline";
  if (marks.includes(mark)) return undefined;
  const ordered = ["bold", "italic", "underline"].filter((candidate) => [...marks, mark].includes(candidate));
  const spans = [];
  for (const child of node.childNodes) {
    const parsed = supportedRichInline(child, ordered);
    if (!parsed) return undefined;
    spans.push(...parsed);
  }
  return spans;
}

function supportedRichParagraph(element) {
  if (element?.nodeType !== Node.ELEMENT_NODE || element.namespaceURI !== XHTML_NAMESPACE
    || !["P", "DIV"].includes(element.tagName)
    || !(element.attributes.length === 0 || exactEmptyMozDirty(element))
    || element.childNodes.length < 1) return undefined;
  const spans = [];
  for (const child of element.childNodes) {
    const parsed = supportedRichInline(child);
    if (!parsed) return undefined;
    spans.push(...parsed);
  }
  return spans.some((span) => span.text.trim().length > 0) ? { type: "paragraph", spans } : undefined;
}

function supportedRichBoundaryBreak(node) {
  return node?.nodeType === Node.ELEMENT_NODE && node.namespaceURI === XHTML_NAMESPACE && node.tagName === "BR"
    && (node.attributes.length === 0 || exactEmptyMozDirty(node));
}

function supportedRichBodyTextRun(roots) {
  if (roots.length < 1 || roots.some((root) => root.parentNode !== document.body)) return undefined;
  const first = roots[0], last = roots.at(-1);
  const before = first.previousSibling, after = last.nextSibling;
  if (!before && !after) return undefined;
  if ((before && !supportedRichBoundaryBreak(before)) || (after && !supportedRichBoundaryBreak(after))) return undefined;
  const spans = [];
  for (const root of roots) {
    const parsed = supportedRichInline(root);
    if (!parsed) return undefined;
    spans.push(...parsed);
  }
  return spans.some((span) => span.text.trim().length > 0) ? { type: "paragraph", spans } : undefined;
}

function completeRichBlockSelection(range) {
  let roots;
  if (range.startContainer === document.body && range.endContainer === document.body
    && range.startOffset >= 0 && range.endOffset > range.startOffset
    && range.endOffset <= document.body.childNodes.length) {
    roots = Array.from(document.body.childNodes).slice(range.startOffset, range.endOffset);
  } else {
    const startRoot = directBodyRoot(range.startContainer);
    const endRoot = directBodyRoot(range.endContainer);
    if (!startRoot || !endRoot) return undefined;
    const children = Array.from(document.body.childNodes);
    const startIndex = children.indexOf(startRoot);
    const endIndex = children.indexOf(endRoot);
    if (startIndex < 0 || endIndex < startIndex
      || range.startContainer !== firstTextDescendant(startRoot) || range.startOffset !== 0) return undefined;
    const last = lastTextDescendant(endRoot);
    if (!last || range.endContainer !== last || range.endOffset !== last.data.length) return undefined;
    roots = children.slice(startIndex, endIndex + 1);
  }
  if (roots.length < 1 || roots.length > 50) return undefined;
  let blocks = roots.map(supportedRichParagraph);
  if (blocks.some((block) => !block)) {
    const bodyTextBlock = supportedRichBodyTextRun(roots);
    if (!bodyTextBlock) return undefined;
    blocks = [bodyTextBlock];
  }
  const characters = blocks.reduce((sum, block) => sum + block.spans.reduce((subtotal, span) => subtotal + span.text.length, 0), 0);
  return characters <= 12_000 ? { roots, blocks } : undefined;
}

function trustedListCapability(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["instance", "minimumThunderbirdMajor", "richBlockEligible", "sameKindListEligible"])
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.instance)
    || value.minimumThunderbirdMajor !== SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR
    || typeof value.sameKindListEligible !== "boolean" || typeof value.richBlockEligible !== "boolean") return undefined;
  return { ...value };
}

function nodePath(node) {
  const path = [];
  let current = node;
  while (current && current !== document.body) {
    const parent = current.parentNode;
    if (!parent) throw new Error("A tracked compose node was detached.");
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  if (current !== document.body) throw new Error("A tracked compose node is outside the editor.");
  return path;
}

function resolvePath(path) {
  return path.reduce((node, index) => node.childNodes[index], document.body);
}

function selectionState() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!rangeIsInEditor(range)) return undefined;
  return {
    boundary: { startPath: nodePath(range.startContainer), startOffset: range.startOffset,
      endPath: nodePath(range.endContainer), endOffset: range.endOffset },
    anchor: { path: nodePath(selection.anchorNode), offset: selection.anchorOffset },
    focus: { path: nodePath(selection.focusNode), offset: selection.focusOffset },
  };
}

function restoreSelectionState(state) {
  const selection = window.getSelection();
  const anchor = resolvePath(state.anchor.path);
  const focus = resolvePath(state.focus.path);
  selection.removeAllRanges();
  if (typeof selection.setBaseAndExtent === "function") selection.setBaseAndExtent(anchor, state.anchor.offset, focus, state.focus.offset);
  else { selection.collapse(anchor, state.anchor.offset); selection.extend(focus, state.focus.offset); }
  return JSON.stringify(selectionState()) === JSON.stringify(state);
}

function canonicalNode(node, targetList) {
  if (node === targetList) {
    return { type: "element", name: node.localName, namespace: node.namespaceURI, attributes: attributeTuples(node),
      children: [{ type: "target-list-items" }] };
  }
  if (node.nodeType === Node.TEXT_NODE) return { type: "text", value: node.data };
  if (node.nodeType === Node.COMMENT_NODE) return { type: "comment", value: node.data };
  if (node.nodeType !== Node.ELEMENT_NODE) throw new Error("Unsupported compose DOM node.");
  return { type: "element", name: node.localName, namespace: node.namespaceURI, attributes: attributeTuples(node),
    children: Array.from(node.childNodes, (child) => canonicalNode(child, targetList)) };
}

function nodeRecord(node, shallow = false) {
  return { node, path: nodePath(node), state: shallow
    ? { type: "element", name: node.localName, namespace: node.namespaceURI, attributes: attributeTuples(node) }
    : canonicalNode(node) };
}

function exactRecords(records) {
  return records.every((record) => {
    try {
      if (!record.node.isConnected || resolvePath(record.path) !== record.node) return false;
      const state = record.shallow
        ? { type: "element", name: record.node.localName, namespace: record.node.namespaceURI, attributes: attributeTuples(record.node) }
        : canonicalNode(record.node);
      return JSON.stringify(state) === JSON.stringify(record.state);
    } catch { return false; }
  });
}

function listIdentityRecords(list) {
  const external = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
  let node;
  while ((node = walker.nextNode())) {
    if (list.contains(node) && node !== list) continue;
    const record = nodeRecord(node, node === list);
    record.shallow = node === list;
    external.push(record);
  }
  const preTarget = [];
  const targetWalker = document.createTreeWalker(list, NodeFilter.SHOW_ALL);
  while ((node = targetWalker.nextNode())) preTarget.push(nodeRecord(node));
  return { external, preTarget };
}

function exactListPreBody(record) {
  return JSON.stringify(canonicalNode(document.body, record.list)) === JSON.stringify(record.maskedState)
    && exactRecords(record.external) && exactRecords(record.preTarget);
}

function exactListPreState(record) {
  return exactListPreBody(record) && JSON.stringify(selectionState()) === JSON.stringify(record.preSelection);
}

function richBlockRecord(range, selection, rich, capability) {
  const bodyChildren = Array.from(document.body.childNodes);
  const startIndex = bodyChildren.indexOf(rich.roots[0]);
  const endIndex = startIndex + rich.roots.length;
  const beforeRoots = bodyChildren.slice(0, startIndex).map((node) => ({ node, state: canonicalNode(node) }));
  const afterRoots = bodyChildren.slice(endIndex).map((node) => ({ node, state: canonicalNode(node) }));
  const externalRecords = [];
  for (const entry of [...beforeRoots, ...afterRoots]) {
    externalRecords.push(entry);
    const walker = document.createTreeWalker(entry.node, NodeFilter.SHOW_ALL);
    let externalNode;
    while ((externalNode = walker.nextNode())) externalRecords.push({ node: externalNode, state: canonicalNode(externalNode) });
  }
  const preTarget = [];
  for (const root of rich.roots) {
    preTarget.push({ node: root, state: canonicalNode(root) });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    let node;
    while ((node = walker.nextNode())) preTarget.push({ node, state: canonicalNode(node) });
  }
  const text = rich.blocks.map((block) => block.spans.map((span) => span.text).join("")).join("\n\n");
  return { kind: "rich-blocks", range, text, blocks: rich.blocks, capability,
    roots: rich.roots, beforeRoots, afterRoots, externalRecords, preTarget,
    bodyAttributes: attributeTuples(document.body), preBodyState: canonicalNode(document.body),
    preSelection: selection };
}

function exactLooseRecords(records) {
  return records.every((record) => record.node.isConnected
    && JSON.stringify(canonicalNode(record.node)) === JSON.stringify(record.state));
}

function exactRichOutside(record) {
  if (JSON.stringify(attributeTuples(document.body)) !== JSON.stringify(record.bodyAttributes)
    || !exactLooseRecords(record.externalRecords)) return false;
  const children = Array.from(document.body.childNodes);
  if (children.length < record.beforeRoots.length + record.afterRoots.length) return false;
  return record.beforeRoots.every((entry, index) => children[index] === entry.node)
    && record.afterRoots.every((entry, index) => children[children.length - record.afterRoots.length + index] === entry.node);
}

function exactRichPreState(record) {
  return JSON.stringify(canonicalNode(document.body)) === JSON.stringify(record.preBodyState)
    && exactLooseRecords(record.preTarget) && exactRichOutside(record)
    && JSON.stringify(selectionState()) === JSON.stringify(record.preSelection);
}

function selectExactRichRoots(record) {
  const first = record.roots[0], last = record.roots.at(-1);
  if (!first?.isConnected || !last?.isConnected || first.parentNode !== document.body || last.parentNode !== document.body) return false;
  const children = Array.from(document.body.childNodes);
  const start = children.indexOf(first), end = children.indexOf(last);
  if (start < 0 || end !== start + record.roots.length - 1
    || !record.roots.every((root, index) => children[start + index] === root)) return false;
  const range = document.createRange();
  range.setStart(document.body, start); range.setEnd(document.body, end + 1);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  return selection.rangeCount === 1 && selection.getRangeAt(0).startContainer === document.body
    && selection.getRangeAt(0).startOffset === start && selection.getRangeAt(0).endContainer === document.body
    && selection.getRangeAt(0).endOffset === end + 1;
}

function validRichSpans(spans) {
  const marks = ["bold", "italic", "underline"];
  return Array.isArray(spans) && spans.length >= 1 && spans.length <= 100
    && spans.some((span) => typeof span?.text === "string" && span.text.trim().length > 0)
    && spans.every((span) => span && typeof span === "object"
      && JSON.stringify(Object.keys(span).sort()) === JSON.stringify(span.marks === undefined ? ["text"] : ["marks", "text"])
      && typeof span.text === "string"
      && span.text.length > 0 && !LIST_ITEM_UNSAFE_CHARACTERS.test(span.text)
      && (span.marks === undefined || (Array.isArray(span.marks) && span.marks.length >= 1
        && span.marks.length <= marks.length && new Set(span.marks).size === span.marks.length
        && JSON.stringify(span.marks) === JSON.stringify(marks.filter((mark) => span.marks.includes(mark))))));
}

function validRichBlocks(blocks) {
  let characters = 0;
  const valid = Array.isArray(blocks) && blocks.length >= 1 && blocks.length <= 50
    && blocks.every((block) => {
      if (!block || typeof block !== "object") return false;
      if (block.type === "paragraph" && validRichSpans(block.spans)) {
        if (JSON.stringify(Object.keys(block).sort()) !== JSON.stringify(["spans", "type"])) return false;
        characters += block.spans.reduce((sum, span) => sum + span.text.length, 0); return true;
      }
      if (["unordered_list", "ordered_list"].includes(block.type) && Array.isArray(block.items)
        && block.items.length >= 1 && block.items.length <= 100
        && block.items.every((item) => item && typeof item === "object"
          && JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["spans"])
          && validRichSpans(item.spans))) {
        if (JSON.stringify(Object.keys(block).sort()) !== JSON.stringify(["items", "type"])) return false;
        characters += block.items.reduce((sum, item) => sum + item.spans.reduce((subtotal, span) => subtotal + span.text.length, 0), 0);
        return true;
      }
      return false;
    });
  return valid && characters <= 12_000;
}

function appendRichSpans(document, parent, spans) {
  for (const span of spans) {
    let node = document.createTextNode(span.text);
    for (const mark of [...(span.marks ?? [])].reverse()) {
      const element = document.createElement(mark === "bold" ? "b" : mark === "italic" ? "i" : "u");
      element.append(node); node = element;
    }
    parent.append(node);
  }
}

function buildRichContainer(blocks) {
  const container = document.createElement("div");
  for (const block of blocks) {
    const root = document.createElement(block.type === "paragraph" ? "p"
      : block.type === "unordered_list" ? "ul" : "ol");
    if (block.type === "paragraph") appendRichSpans(document, root, block.spans);
    else for (const value of block.items) {
      const item = document.createElement("li"); appendRichSpans(document, item, value.spans); root.append(item);
    }
    container.append(root);
  }
  return container;
}

function exactRichInline(node, spans) {
  const expected = document.createElement("span");
  appendRichSpans(document, expected, spans);
  return JSON.stringify(Array.from(node.childNodes, (child) => canonicalNode(child)))
    === JSON.stringify(Array.from(expected.childNodes, (child) => canonicalNode(child)));
}

function exactAppliedRich(record, blocks) {
  if (!exactRichOutside(record)) return false;
  const children = Array.from(document.body.childNodes);
  const generated = children.slice(record.beforeRoots.length, children.length - record.afterRoots.length);
  if (generated.length !== blocks.length) return false;
  return generated.every((root, index) => {
    const block = blocks[index];
    const expectedName = block.type === "paragraph" ? "P" : block.type === "unordered_list" ? "UL" : "OL";
    if (root.nodeType !== Node.ELEMENT_NODE || root.namespaceURI !== XHTML_NAMESPACE || root.tagName !== expectedName
      || !exactEmptyMozDirty(root)) return false;
    if (block.type === "paragraph") return exactRichInline(root, block.spans);
    return root.childNodes.length === block.items.length && Array.from(root.childNodes).every((item, itemIndex) =>
      item.nodeType === Node.ELEMENT_NODE && item.namespaceURI === XHTML_NAMESPACE && item.tagName === "LI"
      && item.attributes.length === 0 && exactRichInline(item, block.items[itemIndex].spans));
  });
}

function validReplacementItems(items) {
  return Array.isArray(items) && items.length >= 1 && items.length <= 100
    && items.reduce((sum, item) => sum + (typeof item === "string" ? item.length : 0), 0) <= 12_000
    && items.every((item) => typeof item === "string" && item.trim().length > 0
      && !LIST_ITEM_UNSAFE_CHARACTERS.test(item));
}

function exactAppliedList(record, items) {
  const childNodes = Array.from(record.list.childNodes);
  const generated = record.whitespaceProfile ? childNodes.slice(1, -1) : childNodes;
  const whitespaceExact = !record.whitespaceProfile || (childNodes.length === items.length + 2
    && childNodes[0] === record.whitespaceProfile.leading && childNodes.at(-1) === record.whitespaceProfile.trailing
    && childNodes[0].data === record.whitespaceProfile.leadingText
    && childNodes.at(-1).data === record.whitespaceProfile.trailingText);
  return record.list.isConnected && whitespaceExact && generated.length === items.length
    && generated.every((item, index) => item.nodeType === Node.ELEMENT_NODE
      && item.namespaceURI === XHTML_NAMESPACE && item.tagName === "LI" && exactEmptyMozDirty(item)
      && item.childNodes.length === 1 && item.firstChild.nodeType === Node.TEXT_NODE && item.firstChild.data === items[index])
    && JSON.stringify(canonicalNode(document.body, record.list)) === JSON.stringify(record.maskedState)
    && exactRecords(record.external);
}

function capture(runtimeCapabilityValue) {
  if (richApplyDisabled) throw new Error("Rich Apply is disabled for this draft because exact rollback could not be verified.");
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    throw new Error("Select text in the message body before opening ThunderClaw.");
  }
  const range = selection.getRangeAt(0).cloneRange();
  if (!rangeIsInEditor(range)) throw new Error("The selection is outside the message body.");
  for (const element of document.body.querySelectorAll(NON_EDITABLE_TARGET_SELECTOR)) {
    if (range.intersectsNode(element)) throw new Error("Quoted history and signatures are context only and cannot be edited.");
  }
  const text = range.toString();
  if (!text.trim()) throw new Error("Select non-empty text in the message body.");
  const completeList = exactBodyWrapperPlainListSelection(range) ?? completePlainListSelection(range);
  if (!completeList && structurallySpansWholeList(range)) {
    throw new Error("Whole-list editing currently requires complete flat list items containing plain text only.");
  }
  const capability = trustedListCapability(runtimeCapabilityValue);
  if (completeList && capability?.sameKindListEligible !== true) {
    throw new Error("Whole-list editing requires Thunderbird 153 or newer.");
  }
  const targetId = randomId();
  const richTarget = !completeList && capability?.richBlockEligible === true
    ? completeRichBlockSelection(range) : undefined;
  if (completeList) {
    const records = listIdentityRecords(completeList.list);
    const preSelection = selectionState();
    const listText = completeList.items.join("\n");
    targets.set(targetId, { kind: "flat-list-items", range, text: listText, items: completeList.items,
      list: completeList.list, listKind: completeList.list.localName, capability, preSelection,
      whitespaceProfile: completeList.whitespaceProfile,
      maskedState: canonicalNode(document.body, completeList.list), ...records });
  } else if (richTarget) {
    targets.set(targetId, richBlockRecord(range, selectionState(), richTarget, capability));
  } else {
    targets.set(targetId, { kind: "text-range", range, text });
  }
  if (targets.size > 32) targets.delete(targets.keys().next().value);
  return completeList
    ? { targetId, text: completeList.items.join("\n"), items: completeList.items,
        selectionShape: "flat-list-items", listKind: completeList.list.localName, ...editorSnapshot() }
    : richTarget
      ? { targetId, text: targets.get(targetId).text, selectionShape: "rich-blocks", ...editorSnapshot() }
    : { targetId, text, selectionShape: "text-range", ...editorSnapshot() };
}

function inspect(targetId) {
  const target = targets.get(targetId);
  if (!target || !rangeIsInEditor(target.range)) throw new Error("The original selection is no longer available.");
  if (target.kind === "flat-list-items") {
    if (!exactListPreState(target)) throw new Error("The original list selection changed. Run ThunderClaw again.");
    return { targetId, text: target.text, items: target.items, selectionShape: "flat-list-items",
      listKind: target.listKind, ...editorSnapshot() };
  }
  if (target.kind === "rich-blocks") {
    if (!exactRichPreState(target)) throw new Error("The original rich-block selection changed. Run ThunderClaw again.");
    return { targetId, text: target.text, selectionShape: "rich-blocks", ...editorSnapshot() };
  }
  return { targetId, text: target.range.toString(), selectionShape: "text-range", ...editorSnapshot() };
}

function applyTextRange(targetId, expectedText, replacement) {
  const target = targets.get(targetId);
  if (!target || !rangeIsInEditor(target.range) || target.range.toString() !== expectedText) {
    targets.delete(targetId);
    throw new Error("The selected text changed. Run ThunderClaw again on the current draft.");
  }

  const selection = window.getSelection();
  document.body.focus();
  selection.removeAllRanges();
  selection.addRange(target.range);
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  document.execCommand("insertText", false, replacement);
  const editorMutated = observer.takeRecords().length > 0;
  observer.disconnect();
  if (!editorMutated) {
    throw new Error("Thunderbird did not apply the replacement through its editor.");
  }

  const undoId = randomId();
  undos.set(undoId, { kind: "text-range", expectedBodyHtml: document.body.innerHTML });
  targets.delete(targetId);
  if (undos.size > 16) undos.delete(undos.keys().next().value);
  return {
    applied: true,
    undoId,
    method: "editor-command",
  };
}

function applyFlatList(targetId, expectedText, replacementItems, runtimeCapabilityValue) {
  const target = targets.get(targetId);
  const capability = trustedListCapability(runtimeCapabilityValue);
  if (!target || target.kind !== "flat-list-items" || expectedText !== target.text
    || JSON.stringify(capability) !== JSON.stringify(target.capability)
    || capability?.sameKindListEligible !== true || !validReplacementItems(replacementItems)) {
    targets.delete(targetId);
    throw new Error("The whole-list suggestion is invalid or stale. Run ThunderClaw again.");
  }
  if (!exactListPreState(target)) {
    targets.delete(targetId);
    throw new Error("The selected list changed. Run ThunderClaw again on the current draft.");
  }
  const wrapper = document.createElement(target.listKind);
  for (const value of replacementItems) {
    const item = document.createElement("li");
    item.append(document.createTextNode(value));
    wrapper.append(item);
  }
  const container = document.createElement("div");
  container.append(wrapper);
  document.body.focus();
  if (JSON.stringify(selectionState()) !== JSON.stringify(target.preSelection)) {
    throw new Error("Focusing the compose editor changed the exact list selection.");
  }
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  let commandReturned = false;
  try { commandReturned = document.execCommand("insertHTML", false, container.innerHTML); } catch { commandReturned = false; }
  const mutated = observer.takeRecords().length > 0;
  observer.disconnect();
  const exact = commandReturned && mutated && exactAppliedList(target, replacementItems);
  if (!exact) {
    let restored = false;
    let alreadyPreBody = false;
    try { alreadyPreBody = exactListPreBody(target); } catch { alreadyPreBody = false; }
    if (mutated && !alreadyPreBody) {
      document.body.focus();
      const undone = document.execCommand("undo");
      try { if (undone) restoreSelectionState(target.preSelection); } catch { /* fail closed below */ }
      try { restored = undone && exactListPreState(target); } catch { restored = false; }
    } else {
      try { restoreSelectionState(target.preSelection); restored = exactListPreState(target); } catch { restored = false; }
    }
    if (!restored) richApplyDisabled = true;
    targets.delete(targetId);
    throw new Error(restored
      ? "Thunderbird rejected the exact whole-list replacement and restored the draft."
      : "Thunderbird could not verify exact whole-list rollback. Rich Apply is disabled for this draft.");
  }
  const undoId = randomId();
  undos.set(undoId, { kind: "flat-list-items", expectedPostState: canonicalNode(document.body),
    target, postSelection: selectionState() });
  targets.delete(targetId);
  if (undos.size > 16) undos.delete(undos.keys().next().value);
  return { applied: true, undoId, method: "editor-command", selectionShape: "flat-list-items" };
}

function applyRichBlocks(targetId, expectedText, blocks, runtimeCapabilityValue) {
  const target = targets.get(targetId);
  const capability = trustedListCapability(runtimeCapabilityValue);
  if (!target || target.kind !== "rich-blocks" || expectedText !== target.text
    || capability?.richBlockEligible !== true || JSON.stringify(capability) !== JSON.stringify(target.capability)
    || !validRichBlocks(blocks) || !exactRichPreState(target)) {
    targets.delete(targetId);
    throw new Error("The rich-block suggestion is invalid or stale. Run ThunderClaw again.");
  }
  const container = buildRichContainer(blocks);
  document.body.focus();
  if (JSON.stringify(selectionState()) !== JSON.stringify(target.preSelection)) {
    throw new Error("Focusing the compose editor changed the exact rich-block selection.");
  }
  if (!selectExactRichRoots(target)) {
    throw new Error("Thunderbird could not select the exact rich-block wrappers.");
  }
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  let commandReturned = false;
  try { commandReturned = document.execCommand("insertHTML", false, container.innerHTML); } catch { commandReturned = false; }
  const mutated = observer.takeRecords().length > 0;
  observer.disconnect();
  const exact = commandReturned && mutated && exactAppliedRich(target, blocks);
  if (!exact) {
    let restored = false;
    const alreadyPreBody = JSON.stringify(canonicalNode(document.body)) === JSON.stringify(target.preBodyState)
      && exactLooseRecords(target.preTarget) && exactRichOutside(target);
    if (mutated && !alreadyPreBody) {
      document.body.focus();
      const undone = document.execCommand("undo");
      try { if (undone) restoreSelectionState(target.preSelection); restored = undone && exactRichPreState(target); } catch { restored = false; }
    } else {
      try { restoreSelectionState(target.preSelection); restored = exactRichPreState(target); } catch { restored = false; }
    }
    if (!restored) richApplyDisabled = true;
    targets.delete(targetId);
    throw new Error(restored
      ? "Thunderbird rejected the exact rich-block replacement and restored the draft."
      : "Thunderbird could not verify exact rich-block rollback. Rich Apply is disabled for this draft.");
  }
  const undoId = randomId();
  undos.set(undoId, { kind: "rich-blocks", expectedPostState: canonicalNode(document.body),
    target, postSelection: selectionState() });
  targets.delete(targetId);
  if (undos.size > 16) undos.delete(undos.keys().next().value);
  return { applied: true, undoId, method: "editor-command", selectionShape: "rich-blocks" };
}

function apply(targetId, expectedText, operationType, replacement, replacementItems, replacementBlocks, runtimeCapabilityValue) {
  const target = targets.get(targetId);
  if (target?.kind === "flat-list-items") {
    if (operationType !== "replace_flat_list_items" || replacement !== replacementItems?.join("\n")) {
      throw new Error("Whole-list Apply requires an exact flat-list item operation.");
    }
    return applyFlatList(targetId, expectedText, replacementItems, runtimeCapabilityValue);
  }
  if (target?.kind === "rich-blocks") {
    if (operationType !== "replace_rich_blocks" || replacementItems !== undefined || replacement !== undefined) {
      throw new Error("Rich Apply requires an exact rich-block operation.");
    }
    return applyRichBlocks(targetId, expectedText, replacementBlocks, runtimeCapabilityValue);
  }
  if (operationType !== "replace_text_range" || replacementItems !== undefined) {
    throw new Error("Text Apply requires an exact text-range operation.");
  }
  return applyTextRange(targetId, expectedText, replacement);
}

function undo(undoId) {
  const record = undos.get(undoId);
  if (!record) throw new Error("This applied change can no longer be undone.");
  if (record.kind === "flat-list-items") {
    if (JSON.stringify(canonicalNode(document.body)) !== JSON.stringify(record.expectedPostState)
      || JSON.stringify(selectionState()) !== JSON.stringify(record.postSelection)
      || !exactRecords(record.target.external)) {
      undos.delete(undoId);
      throw new Error("The draft changed after Apply, so ThunderClaw will not overwrite the newer edit.");
    }
    document.body.focus();
    const undone = document.execCommand("undo");
    let exact = false;
    try { if (undone) restoreSelectionState(record.target.preSelection); exact = undone && exactListPreState(record.target); } catch { exact = false; }
    undos.delete(undoId);
    if (!exact) {
      richApplyDisabled = true;
      throw new Error("Thunderbird could not verify exact whole-list Undo. Rich Apply is disabled for this draft.");
    }
    return { undone: true, method: "editor-command", selectionShape: "flat-list-items" };
  }
  if (record.kind === "rich-blocks") {
    if (JSON.stringify(canonicalNode(document.body)) !== JSON.stringify(record.expectedPostState)
      || JSON.stringify(selectionState()) !== JSON.stringify(record.postSelection)
      || !exactRichOutside(record.target)) {
      undos.delete(undoId);
      throw new Error("The draft changed after Apply, so ThunderClaw will not overwrite the newer edit.");
    }
    document.body.focus();
    const undone = document.execCommand("undo");
    let exact = false;
    try { if (undone) restoreSelectionState(record.target.preSelection); exact = undone && exactRichPreState(record.target); } catch { exact = false; }
    undos.delete(undoId);
    if (!exact) {
      richApplyDisabled = true;
      throw new Error("Thunderbird could not verify exact rich-block Undo. Rich Apply is disabled for this draft.");
    }
    return { undone: true, method: "editor-command", selectionShape: "rich-blocks" };
  }
  if (document.body.innerHTML !== record.expectedBodyHtml) {
    undos.delete(undoId);
    throw new Error("The draft changed after Apply, so ThunderClaw will not overwrite the newer edit.");
  }
  document.body.focus();
  const undone = document.execCommand("undo");
  undos.delete(undoId);
  if (!undone) throw new Error("Thunderbird could not undo the applied change.");
  return { undone: true, method: "editor-command" };
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return undefined;
  try {
    if (message.type === "thunderclaw.capture") return Promise.resolve({ ok: true, value: capture(message.runtimeCapability) });
    if (message.type === "thunderclaw.inspect") return Promise.resolve({ ok: true, value: inspect(message.targetId) });
    if (message.type === "thunderclaw.apply") {
      return Promise.resolve({ ok: true, value: apply(message.targetId, message.expectedText, message.operationType,
        message.replacement, message.replacementItems, message.replacementBlocks, message.runtimeCapability) });
    }
    if (message.type === "thunderclaw.undo") {
      return Promise.resolve({ ok: true, value: undo(message.undoId) });
    }
    return undefined;
  } catch (error) {
    return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : "ThunderClaw compose operation failed." });
  }
});
