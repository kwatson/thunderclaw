(() => {
  "use strict";

  const captures = new Map();
  const trials = new Map();
  const ALLOWED_ELEMENTS = new Set(["BODY", "DIV", "P", "BR", "STRONG", "B", "EM", "I", "U", "OL", "UL", "LI"]);
  const OBSERVED_MOZ_DIRTY_ELEMENTS = new Set(["P", "UL", "OL", "LI", "BR", "U"]);
  const XHTML_NAMESPACE = "http:" + "//www.w3.org/1999/xhtml";
  const PROTECTED_SELECTOR = [
    'blockquote[type="cite"]',
    "blockquote[cite]",
    ".moz-cite-prefix",
    ".moz-signature",
    ".moz-forward-container",
    'span[_moz_quote="true"]',
    '[contenteditable="false"]',
  ].join(",");
  const R0_AUTOMATION_BUILD_ID = "thunderclaw-rich-compose-r0@example.invalid:0.0.1";
  const R0_RUNTIME_CAPABILITY_TYPE = "rich-compose-r0.runtime-capability";
  const SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR = 153;
  const SAME_KIND_LIST_PRESETS = new Set([
    "same-kind-list-rewrite",
    "same-kind-list-add",
    "same-kind-list-remove",
    "same-kind-list-reorder",
  ]);
  const EXPLICIT_UNSUPPORTED_SELECTOR = "a,img,table,thead,tbody,tfoot,tr,td,th,hr,pre,code,h1,h2,h3,h4,h5,h6";
  let latestCaptureId;
  let latestCapturePlacement;
  let latestCaptureWholeListTargeted = false;
  let latestCaptureSameKindListEligible = false;
  let latestTrialId;
  let richApplyDisabled = false;
  let editorRevision = 0;
  const editorMutationObserver = new MutationObserver((records) => {
    if (records.length > 0) editorRevision += 1;
  });
  editorMutationObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  document.body.addEventListener("input", () => { editorRevision += 1; }, true);

  function syncEditorRevision() {
    if (editorMutationObserver.takeRecords().length > 0) editorRevision += 1;
    return editorRevision;
  }

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function isSameKindListPreset(preset) {
    return SAME_KIND_LIST_PRESETS.has(preset);
  }

  async function trustedRuntimeCapability() {
    try {
      const capability = await browser.runtime.sendMessage({
        type: R0_RUNTIME_CAPABILITY_TYPE,
        buildId: R0_AUTOMATION_BUILD_ID,
      });
      const keys = Object.keys(capability ?? {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["buildId", "instance", "minimumThunderbirdMajor", "sameKindListEligible"])
        || capability.buildId !== R0_AUTOMATION_BUILD_ID
        || !/^[0-9a-f]{32}$/u.test(capability.instance)
        || capability.minimumThunderbirdMajor !== SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR
        || typeof capability.sameKindListEligible !== "boolean") {
        return undefined;
      }
      return capability;
    } catch {
      return undefined;
    }
  }

  function attributeTuple(attribute) {
    return [attribute.namespaceURI ?? null, attribute.prefix ?? null, attribute.localName, attribute.name, attribute.value];
  }

  function compareTuples(first, second) {
    return JSON.stringify(first).localeCompare(JSON.stringify(second));
  }

  function canonicalDomState(node, typedSlot) {
    if (node === typedSlot) return { kind: "target-slot" };
    if (node.nodeType === Node.TEXT_NODE) return { kind: "text", nodeType: node.nodeType, data: node.data };
    if (node.nodeType === Node.COMMENT_NODE) return { kind: "comment", nodeType: node.nodeType, data: node.data };
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return {
        kind: "fragment",
        nodeType: node.nodeType,
        children: Array.from(node.childNodes, (child) => canonicalDomState(child, typedSlot)),
      };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      throw new Error(`Unsupported live DOM node type ${node.nodeType}.`);
    }
    return {
      kind: "element",
      nodeType: node.nodeType,
      namespaceURI: node.namespaceURI ?? null,
      localName: node.localName,
      nodeName: node.nodeName,
      attributes: Array.from(node.attributes, attributeTuple).sort(compareTuples),
      children: Array.from(node.childNodes, (child) => canonicalDomState(child, typedSlot)),
    };
  }

  function sameState(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
  }

  function diagnosticStateName(state) {
    if (state?.kind !== "element") return undefined;
    const name = String(state.localName ?? "").toLowerCase();
    return ["body", "p", "div", "span", "font", "ul", "ol", "li", "b", "strong", "i", "em", "u", "br"]
      .includes(name) ? name : "other";
  }

  function diagnosticAttributeProfile(state) {
    if (state?.kind !== "element") return undefined;
    if (state.attributes.length === 0) return "none";
    const expectedMozDirty = [[null, null, "_moz_dirty", "_moz_dirty", ""]];
    return sameState(state.attributes, expectedMozDirty) ? "exact-empty-moz-dirty" : "other";
  }

  function diagnosticStateDescriptor(state) {
    return {
      kind: ["element", "text", "comment", "fragment", "target-slot"].includes(state?.kind) ? state.kind : "other",
      characterCount: ["text", "comment"].includes(state?.kind) ? Math.min(state.data.length, 12_000) : undefined,
      name: diagnosticStateName(state),
      namespace: state?.kind === "element"
        ? (state.namespaceURI === XHTML_NAMESPACE ? "xhtml" : state.namespaceURI === null ? "null" : "other")
        : undefined,
      attributes: diagnosticAttributeProfile(state),
      childCount: Array.isArray(state?.children) ? Math.min(state.children.length, 32) : undefined,
    };
  }

  function firstCanonicalMismatch(expected, actual, path = []) {
    const boundedPath = path.slice(0, 16).map((index) => Math.min(index, 32));
    if (expected?.kind !== actual?.kind) {
      return { reason: "node-kind", path: boundedPath, expected: diagnosticStateDescriptor(expected), actual: diagnosticStateDescriptor(actual) };
    }
    if (expected?.kind === "text" || expected?.kind === "comment") {
      return expected.data === actual.data ? undefined
        : { reason: "character-data", path: boundedPath, expected: diagnosticStateDescriptor(expected), actual: diagnosticStateDescriptor(actual) };
    }
    if (expected?.kind === "element") {
      if (expected.namespaceURI !== actual.namespaceURI || expected.localName !== actual.localName || expected.nodeName !== actual.nodeName) {
        return { reason: "element-identity", path: boundedPath, expected: diagnosticStateDescriptor(expected), actual: diagnosticStateDescriptor(actual) };
      }
      if (!sameState(expected.attributes, actual.attributes)) {
        return { reason: "attributes", path: boundedPath, expected: diagnosticStateDescriptor(expected), actual: diagnosticStateDescriptor(actual) };
      }
    }
    const expectedChildren = expected?.children ?? [];
    const actualChildren = actual?.children ?? [];
    if (expectedChildren.length !== actualChildren.length) {
      return { reason: "child-count", path: boundedPath, expected: diagnosticStateDescriptor(expected), actual: diagnosticStateDescriptor(actual) };
    }
    for (let index = 0; index < expectedChildren.length; index += 1) {
      const mismatch = firstCanonicalMismatch(expectedChildren[index], actualChildren[index], [...path, index]);
      if (mismatch) return mismatch;
    }
    return undefined;
  }

  function boundedCount(value) {
    return Math.min(Number.isSafeInteger(value) && value >= 0 ? value : 0, 32);
  }

  const SHA256_CONSTANTS = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotateRight(value, count) {
    return (value >>> count) | (value << (32 - count));
  }

  function pureSha256(bytes) {
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLength = bytes.length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const hash = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
      for (let index = 16; index < 64; index += 1) {
        const first = words[index - 15];
        const second = words[index - 2];
        const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
        const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temporary1 = (h + sum1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temporary2 = (sum0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temporary1) >>> 0;
        d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  const textEncoder = new TextEncoder();
  if (pureSha256(textEncoder.encode("")) !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    || pureSha256(textEncoder.encode("abc")) !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
    throw new Error("Local SHA-256 self-test failed.");
  }

  async function diagnosticSha256(state) {
    const bytes = textEncoder.encode(JSON.stringify(state));
    const fallback = pureSha256(bytes);
    if (globalThis.crypto?.subtle?.digest) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const webCrypto = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (webCrypto !== fallback) throw new Error("WebCrypto and local SHA-256 disagree.");
      return `sha256:${webCrypto}`;
    }
    return `sha256:${fallback}`;
  }

  async function safeDiagnosticSha256(state) {
    try {
      return await diagnosticSha256(state);
    } catch {
      return "sha256:unavailable";
    }
  }

  function redactNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return { type: "text", length: node.data.length };
    if (node.nodeType === Node.COMMENT_NODE) return { type: "comment", length: node.data.length };
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return { type: "fragment", children: Array.from(node.childNodes, redactNode) };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return { type: `node-${node.nodeType}` };
    return {
      type: "element",
      name: node.localName,
      attributes: Array.from(node.attributes, (attribute) => attribute.name).sort(),
      children: Array.from(node.childNodes, redactNode),
    };
  }

  function nodePath(node) {
    const path = [];
    let current = node;
    while (current && current !== document.body) {
      const parent = current.parentNode;
      if (!parent) throw new Error("A selection boundary is detached from the compose body.");
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    if (current !== document.body) throw new Error("A selection boundary is outside the compose body.");
    return path;
  }

  function resolvePath(root, path) {
    let current = root;
    for (const index of path) {
      current = current?.childNodes[index];
      if (!current) throw new Error("A captured DOM path no longer resolves.");
    }
    return current;
  }

  function boundary(range) {
    return {
      startPath: nodePath(range.startContainer),
      startOffset: range.startOffset,
      endPath: nodePath(range.endContainer),
      endOffset: range.endOffset,
      commonAncestorPath: nodePath(range.commonAncestorContainer),
    };
  }

  function maskEmptyBoundaryPolicy(range) {
    return {
      before: range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0,
      after: range.endContainer.nodeType === Node.TEXT_NODE && range.endOffset === range.endContainer.data.length,
    };
  }

  function currentSelectionState() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1) {
      return { rangeCount: selection?.rangeCount ?? 0, collapsed: true };
    }
    const range = selection.getRangeAt(0);
    const inBody = rangeInBody(range);
    return {
      rangeCount: 1,
      collapsed: selection.isCollapsed,
      inBody,
      boundary: inBody ? boundary(range) : undefined,
      anchor: inBody ? { path: nodePath(selection.anchorNode), offset: selection.anchorOffset } : undefined,
      focus: inBody ? { path: nodePath(selection.focusNode), offset: selection.focusOffset } : undefined,
      textLength: range.toString().length,
    };
  }

  function currentSelectionStateMatches(expected) {
    return sameState(currentSelectionState(), expected);
  }

  function currentSelectionMatches(rangeBoundary) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    return rangeInBody(range) && JSON.stringify(boundary(range)) === JSON.stringify(rangeBoundary);
  }

  function restoreSelection(rangeBoundary) {
    const range = document.createRange();
    range.setStart(resolvePath(document.body, rangeBoundary.startPath), rangeBoundary.startOffset);
    range.setEnd(resolvePath(document.body, rangeBoundary.endPath), rangeBoundary.endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return currentSelectionMatches(rangeBoundary);
  }

  function restoreSelectionState(selectionState) {
    if (selectionState?.rangeCount !== 1 || selectionState.collapsed || !selectionState.inBody) return false;
    const anchor = resolvePath(document.body, selectionState.anchor.path);
    const focus = resolvePath(document.body, selectionState.focus.path);
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(anchor, selectionState.anchor.offset, focus, selectionState.focus.offset);
    } else {
      selection.collapse(anchor, selectionState.anchor.offset);
      selection.extend(focus, selectionState.focus.offset);
    }
    return currentSelectionStateMatches(selectionState);
  }

  function exactCloneWithMap(node, map) {
    const clone = node.cloneNode(false);
    map.set(node, clone);
    for (const child of node.childNodes) clone.append(exactCloneWithMap(child, map));
    return clone;
  }

  function pathFromRoot(root, node) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parent = current.parentNode;
      if (!parent) throw new Error("A tracked node is detached from its canonical root.");
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    if (current !== root) throw new Error("A tracked node is outside its canonical root.");
    return path;
  }

  function maskedBodyState(rangeBoundary, trackedNodes = [], options = {}) {
    const liveState = canonicalDomState(document.body);
    const cloneMap = new Map();
    const clone = exactCloneWithMap(document.body, cloneMap);
    if (!sameState(liveState, canonicalDomState(clone))) {
      throw new Error("cloneNode did not retain the exact live DOM attribute state.");
    }
    const range = document.createRange();
    const startNode = resolvePath(clone, rangeBoundary.startPath);
    const endNode = resolvePath(clone, rangeBoundary.endPath);
    const endLength = endNode.nodeType === Node.TEXT_NODE ? endNode.data.length : undefined;
    const originalCloneNodes = new Set(cloneMap.values());
    range.setStart(startNode, rangeBoundary.startOffset);
    range.setEnd(endNode, rangeBoundary.endOffset);
    range.deleteContents();
    const slot = document.createComment("");
    range.insertNode(slot);
    const removeIfSyntheticEmptyText = (node) => {
      if (node?.nodeType === Node.TEXT_NODE && node.data.length === 0 && !originalCloneNodes.has(node)) node.remove();
    };
    removeIfSyntheticEmptyText(slot.previousSibling);
    removeIfSyntheticEmptyText(slot.nextSibling);
    if (startNode.nodeType === Node.TEXT_NODE && rangeBoundary.startOffset === 0
      && startNode.data.length === 0 && startNode.parentNode) startNode.remove();
    if (endNode !== startNode && endNode.nodeType === Node.TEXT_NODE && rangeBoundary.endOffset === endLength
      && endNode.data.length === 0 && endNode.parentNode) endNode.remove();
    removeIfSyntheticEmptyText(slot.previousSibling);
    removeIfSyntheticEmptyText(slot.nextSibling);
    const preservedEmptyClones = new Set((options.preservedEmptyNodes ?? []).map((node) => cloneMap.get(node)).filter(Boolean));
    if (options.emptyBoundaryPolicy?.before && slot.previousSibling?.nodeType === Node.TEXT_NODE
      && slot.previousSibling.data.length === 0 && !preservedEmptyClones.has(slot.previousSibling)) slot.previousSibling.remove();
    if (options.emptyBoundaryPolicy?.after && slot.nextSibling?.nodeType === Node.TEXT_NODE
      && slot.nextSibling.data.length === 0 && !preservedEmptyClones.has(slot.nextSibling)) slot.nextSibling.remove();
    return {
      state: canonicalDomState(clone, slot),
      trackedPaths: trackedNodes.map((node) => {
        const trackedClone = cloneMap.get(node);
        if (!trackedClone || (trackedClone !== clone && !clone.contains(trackedClone))) {
          throw new Error("A tracked node was removed by the target mask.");
        }
        return pathFromRoot(clone, trackedClone);
      }),
    };
  }

  function rangeInBody(range) {
    const ancestor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
    return Boolean(ancestor && (ancestor === document.body || document.body.contains(ancestor)));
  }

  function boundaryAncestors(range, placement) {
    const found = new Set();
    const boundaryNodes = [range.startContainer];
    const endIsFollowingBlockOffsetZero = placement.placement === "blocks"
      && range.endContainer.nodeType === Node.ELEMENT_NODE
      && range.endContainer.parentNode === document.body
      && range.endOffset === 0;
    if (!endIsFollowingBlockOffsetZero) boundaryNodes.push(range.endContainer);
    for (const boundaryNode of boundaryNodes) {
      let current = boundaryNode.nodeType === Node.ELEMENT_NODE ? boundaryNode : boundaryNode.parentElement;
      while (current && current !== document.body) {
        found.add(current);
        current = current.parentElement;
      }
    }
    return found;
  }

  function semanticAttributeNames(element) {
    return Array.from(element.attributes, (attribute) => attribute.name)
      .sort();
  }

  function hasExactEmptyMozDirtyAttribute(element) {
    if (element.namespaceURI !== XHTML_NAMESPACE || element.attributes.length !== 1) return false;
    const attribute = element.attributes.item(0);
    return attribute.namespaceURI === null
      && attribute.prefix === null
      && attribute.localName === "_moz_dirty"
      && attribute.name === "_moz_dirty"
      && attribute.value === "";
  }

  function hasObservedThunderbirdAttributes(element) {
    return OBSERVED_MOZ_DIRTY_ELEMENTS.has(element.tagName)
      && hasExactEmptyMozDirtyAttribute(element);
  }

  function strictlySupportedElement(element) {
    return element.namespaceURI === XHTML_NAMESPACE
      && ALLOWED_ELEMENTS.has(element.tagName)
      && !element.matches(PROTECTED_SELECTOR)
      && !element.matches(EXPLICIT_UNSUPPORTED_SELECTOR)
      && element.attributes.length === 0;
  }

  function supportedInlineParagraphWrapper(element) {
    return strictlySupportedElement(element)
      || (ALLOWED_ELEMENTS.has(element.tagName)
        && !element.matches(PROTECTED_SELECTOR)
        && !element.matches(EXPLICIT_UNSUPPORTED_SELECTOR)
        && element.tagName === "P"
        && hasObservedThunderbirdAttributes(element));
  }

  function supportedInlineElement(element) {
    return strictlySupportedElement(element)
      || (["BR", "U"].includes(element.tagName) && hasObservedThunderbirdAttributes(element));
  }

  function supportedListWrapper(element) {
    return ["OL", "UL"].includes(element.tagName)
      && (strictlySupportedElement(element) || hasObservedThunderbirdAttributes(element));
  }

  function supportedListItem(element) {
    return element.tagName === "LI"
      && (strictlySupportedElement(element) || hasObservedThunderbirdAttributes(element));
  }

  function validateInlineNode(node, reasons) {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      reasons.push(`unsupported-inline-node-type:${node.nodeType}`);
      return;
    }
    if (!supportedInlineElement(node)) {
      reasons.push(`unsupported-inline-element:${node.localName}`);
      return;
    }
    if (node.tagName === "BR") {
      if (node.childNodes.length !== 0) reasons.push("line-break-has-children");
      return;
    }
    if (!["STRONG", "B", "EM", "I", "U"].includes(node.tagName)) {
      reasons.push(`block-or-list-in-inline-context:${node.localName}`);
      return;
    }
    for (const child of node.childNodes) validateInlineNode(child, reasons);
  }

  function validateInlineChildren(node, reasons) {
    for (const child of node.childNodes) validateInlineNode(child, reasons);
  }

  function validateParagraphBlock(node, reasons) {
    if (node.nodeType !== Node.ELEMENT_NODE || !["P", "DIV"].includes(node.tagName) || !strictlySupportedElement(node)) {
      reasons.push(`unsupported-paragraph-wrapper:${node.localName ?? node.nodeName}`);
      return;
    }
    validateInlineChildren(node, reasons);
  }

  function validateListBlock(node, reasons) {
    if (node.nodeType !== Node.ELEMENT_NODE || !supportedListWrapper(node)) {
      reasons.push(`unsupported-list-wrapper:${node.localName ?? node.nodeName}`);
      return;
    }
    if (node.childNodes.length === 0) reasons.push("empty-list");
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.ELEMENT_NODE || !supportedListItem(child)) {
        reasons.push(`list-child-is-not-plain-li:${child.localName ?? child.nodeName}`);
        continue;
      }
      validateInlineChildren(child, reasons);
    }
  }

  function validateBodyBlock(node, reasons) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      reasons.push(`top-level-node-is-not-block:${node.nodeType}`);
      return;
    }
    if (["P", "DIV"].includes(node.tagName)) validateParagraphBlock(node, reasons);
    else if (["OL", "UL"].includes(node.tagName)) validateListBlock(node, reasons);
    else reasons.push(`unsupported-top-level-element:${node.localName}`);
  }

  function validateInlineFragment(fragment, reasons) {
    if (fragment.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      reasons.push("selection-clone-is-not-fragment");
      return;
    }
    validateInlineChildren(fragment, reasons);
  }

  function inlineContainer(node) {
    let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (current && current !== document.body) {
      if (["P", "DIV", "LI"].includes(current.tagName)) return current;
      current = current.parentElement;
    }
    return undefined;
  }

  function normalizedCompleteBlockOffsets(range) {
    if (range.startContainer !== document.body) return undefined;
    const start = range.startOffset;
    let end;
    if (range.endContainer === document.body) {
      end = range.endOffset;
    } else if (range.endContainer.nodeType === Node.ELEMENT_NODE
      && range.endContainer.parentNode === document.body && range.endOffset === 0) {
      end = Array.prototype.indexOf.call(document.body.childNodes, range.endContainer);
    } else {
      return undefined;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > document.body.childNodes.length) {
      return undefined;
    }
    const selected = Array.from(document.body.childNodes).slice(start, end);
    if (selected.length === 0 || selected.some((node) => node.nodeType !== Node.ELEMENT_NODE
      || (!strictlySupportedElement(node) && !supportedListWrapper(node)))) {
      return undefined;
    }
    const reasons = [];
    for (const node of selected) validateBodyBlock(node, reasons);
    return reasons.length === 0 ? { start, end } : undefined;
  }

  function directListItem(node) {
    let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (current && current !== document.body && current.tagName !== "LI") current = current.parentElement;
    if (!current || current.tagName !== "LI") return undefined;
    const list = current.parentElement;
    if (!list || !["OL", "UL"].includes(list.tagName) || list.parentNode !== document.body) return undefined;
    return { item: current, list };
  }

  function boundaryIsContentEdge(container, offset, root, edge) {
    const limit = container.nodeType === Node.TEXT_NODE ? container.data.length : container.childNodes.length;
    if (offset !== (edge === "start" ? 0 : limit)) return false;
    let current = container;
    while (current !== root) {
      if (!current?.parentNode) return false;
      if (edge === "start" ? current.previousSibling : current.nextSibling) return false;
      current = current.parentNode;
    }
    return true;
  }

  function promotedFullList(range) {
    const start = directListItem(range.startContainer);
    const end = directListItem(range.endContainer);
    if (!start || !end || start.list !== end.list || start.item === end.item) return undefined;
    const items = Array.from(start.list.childNodes);
    if (items.length < 2 || start.item !== items[0] || end.item !== items.at(-1)) return undefined;
    const reasons = [];
    validateListBlock(start.list, reasons);
    if (reasons.length > 0) return undefined;
    if (start.item.firstChild?.nodeType === Node.COMMENT_NODE || start.item.firstChild?.tagName === "BR") return undefined;
    if (end.item.lastChild?.nodeType === Node.COMMENT_NODE || end.item.lastChild?.tagName === "BR") return undefined;
    if (!boundaryIsContentEdge(range.startContainer, range.startOffset, start.item, "start")
      || !boundaryIsContentEdge(range.endContainer, range.endOffset, end.item, "end")) return undefined;
    const effectiveRange = document.createRange();
    effectiveRange.setStartBefore(start.list);
    effectiveRange.setEndAfter(start.list);
    const index = Array.prototype.indexOf.call(document.body.childNodes, start.list);
    return { effectiveRange, blockOffsets: { start: index, end: index + 1 }, list: start.list };
  }

  function exactBodyWrapperList(range) {
    if (range.startContainer !== document.body || range.endContainer !== document.body
      || !Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)
      || range.startOffset < 0 || range.endOffset !== range.startOffset + 1
      || range.endOffset > document.body.childNodes.length) return undefined;
    const list = document.body.childNodes[range.startOffset];
    if (list?.nodeType !== Node.ELEMENT_NODE || !supportedListWrapper(list)
      || list.parentNode !== document.body || list.childNodes.length < 2) return undefined;
    const reasons = [];
    validateListBlock(list, reasons);
    if (reasons.length > 0) return undefined;
    return {
      effectiveRange: range.cloneRange(),
      blockOffsets: { start: range.startOffset, end: range.endOffset },
      list,
    };
  }

  function classifyPlacement(range) {
    const blocks = normalizedCompleteBlockOffsets(range);
    if (blocks) return { placement: "blocks", blockOffsets: blocks };
    if (range.startContainer === range.endContainer
      && range.startContainer.nodeType === Node.TEXT_NODE
      && range.startContainer.parentNode === document.body) {
      return { placement: "inline", inlineMode: "direct_body_text" };
    }
    const startBlock = inlineContainer(range.startContainer);
    const endBlock = inlineContainer(range.endContainer);
    if (startBlock && startBlock === endBlock) return { placement: "inline", inlineMode: "contained_block" };
    return { placement: "ineligible", reason: "partial-cross-block-or-noncanonical-block-boundary" };
  }

  function validatePlacementStructure(range, placement, reasons) {
    if (placement.placement === "inline") {
      validateInlineFragment(range.cloneContents(), reasons);
      if (placement.inlineMode === "direct_body_text") {
        if (range.startContainer !== range.endContainer
          || range.startContainer.nodeType !== Node.TEXT_NODE
          || range.startContainer.parentNode !== document.body) {
          reasons.push("direct-body-text-boundary-mismatch");
        }
        return;
      }
      const container = inlineContainer(range.startContainer);
      if (!container || container !== inlineContainer(range.endContainer)) {
        reasons.push("inline-boundaries-do-not-share-one-container");
        return;
      }
      if (["P", "DIV"].includes(container.tagName) && supportedInlineParagraphWrapper(container)) {
        if (container.parentNode !== document.body) reasons.push("paragraph-container-is-not-direct-body-child");
      } else if (container.tagName === "LI" && supportedListItem(container)) {
        const list = container.parentElement;
        if (!list || !supportedListWrapper(list)
          || list.parentNode !== document.body || container.parentNode !== list) {
          reasons.push("list-item-container-does-not-have-proven-direct-list-ancestry");
        }
      } else {
        reasons.push(`unsupported-inline-container:${container.localName}`);
      }
      return;
    }
    if (placement.placement === "blocks") {
      for (const node of Array.from(document.body.childNodes).slice(placement.blockOffsets.start, placement.blockOffsets.end)) {
        validateBodyBlock(node, reasons);
      }
    }
  }

  function classify(range) {
    const reasons = [];
    const promotion = exactBodyWrapperList(range) ?? promotedFullList(range);
    const effectiveRange = promotion?.effectiveRange ?? range;
    const placement = promotion
      ? { placement: "blocks", blockOffsets: promotion.blockOffsets, wholeListTargeted: true }
      : classifyPlacement(effectiveRange);
    if (![Node.TEXT_NODE, Node.ELEMENT_NODE].includes(range.startContainer.nodeType)) {
      reasons.push(`unsupported-start-boundary:${range.startContainer.nodeType}`);
    }
    if (![Node.TEXT_NODE, Node.ELEMENT_NODE].includes(range.endContainer.nodeType)) {
      reasons.push(`unsupported-end-boundary:${range.endContainer.nodeType}`);
    }
    const selectedElements = new Set(boundaryAncestors(effectiveRange, placement));
    for (const element of selectedElements) {
      if (element.namespaceURI !== XHTML_NAMESPACE) reasons.push(`not-xhtml:${element.localName}`);
      if (element.matches(PROTECTED_SELECTOR)) reasons.push(`protected:${element.localName}`);
      if (element.matches(EXPLICIT_UNSUPPORTED_SELECTOR)) reasons.push(`unsupported:${element.localName}`);
      if (!ALLOWED_ELEMENTS.has(element.tagName)) reasons.push(`not-allowlisted:${element.localName}`);
      if (element.hasAttribute("style")) reasons.push(`styled:${element.localName}`);
      const semanticAttributes = semanticAttributeNames(element);
      const isObservedHostElement = hasObservedThunderbirdAttributes(element);
      if (semanticAttributes.length > 0 && !isObservedHostElement) {
        reasons.push(`attributes:${element.localName}:${semanticAttributes.join(",")}`);
      }
    }
    if (placement.placement === "ineligible") reasons.push(placement.reason);
    else validatePlacementStructure(effectiveRange, placement, reasons);
    return {
      effectiveRange,
      listTarget: promotion?.list,
      classification: {
        eligible: reasons.length === 0,
        placement: reasons.length === 0 ? placement.placement : "ineligible",
        inlineMode: reasons.length === 0 ? placement.inlineMode : undefined,
        blockOffsets: reasons.length === 0 ? placement.blockOffsets : undefined,
        wholeListTargeted: reasons.length === 0 && placement.wholeListTargeted === true,
        reasons: [...new Set(reasons)].sort(),
      },
    };
  }

  function opaqueNodes() {
    const nodes = [];
    const recordRoot = (node) => {
      nodes.push(node);
    };
    const scanInline = (parent) => {
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) {
          recordRoot(child);
        } else if (child.tagName === "BR" && supportedInlineElement(child)) {
          if (child.childNodes.length !== 0) recordRoot(child);
        } else if (["STRONG", "B", "EM", "I", "U"].includes(child.tagName) && supportedInlineElement(child)) {
          scanInline(child);
        } else {
          recordRoot(child);
        }
      }
    };
    for (const child of document.body.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        continue;
      } else if (child.nodeType === Node.ELEMENT_NODE
        && ["P", "DIV"].includes(child.tagName)
        && supportedInlineParagraphWrapper(child)) {
        scanInline(child);
      } else if (child.nodeType === Node.ELEMENT_NODE
        && ["OL", "UL"].includes(child.tagName)
        && supportedListWrapper(child)) {
        for (const item of child.childNodes) {
          if (item.nodeType !== Node.ELEMENT_NODE || !supportedListItem(item)) recordRoot(item);
          else scanInline(item);
        }
      } else if (child.nodeType !== Node.ELEMENT_NODE || !strictlySupportedElement(child)) {
        recordRoot(child);
      } else {
        recordRoot(child);
      }
    }
    return nodes;
  }

  function nodeRecord(node) {
    return { node, path: nodePath(node), state: canonicalDomState(node) };
  }

  function referenceRecords(range) {
    const opaque = opaqueNodes().map(nodeRecord);
    const opaqueNodesSet = new Set(opaque.map(({ node }) => node));
    const ancestors = Array.from(boundaryAncestors(range, { placement: "inline" }))
      .filter((node) => !opaqueNodesSet.has(node))
      .map(nodeRecord);
    const emptyText = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.data.length === 0 && !range.intersectsNode(textNode)) emptyText.push(nodeRecord(textNode));
    }
    return { opaque, ancestors, emptyText };
  }

  function exactReferenceRecords(records) {
    return records.every(({ node, path, state }) => {
      if (!node.isConnected || !document.body.contains(node)) return false;
      let resolved;
      try {
        resolved = resolvePath(document.body, path);
      } catch {
        return false;
      }
      return resolved === node && sameState(canonicalDomState(node), state);
    });
  }

  function identityReferenceRecords(records) {
    return records.every(({ node, path }) => {
      if (!node.isConnected || !document.body.contains(node)) return false;
      try {
        return resolvePath(document.body, path) === node;
      } catch {
        return false;
      }
    });
  }

  function exactReferenceIdentityState(records) {
    return records.every(({ node, state }) => node.isConnected
      && document.body.contains(node)
      && sameState(canonicalDomState(node), state));
  }

  function connectedReferenceIdentity(records) {
    return records.every(({ node }) => node.isConnected && document.body.contains(node));
  }

  function refreshedReferenceRecords(records) {
    return records.map(({ node }) => nodeRecord(node));
  }

  function descendantReferenceRecords(parent) {
    const records = [];
    const walker = document.createTreeWalker(parent, NodeFilter.SHOW_ALL);
    let node;
    while ((node = walker.nextNode())) records.push(nodeRecord(node));
    return records;
  }

  function referenceList(references) {
    return [...references.opaque, ...references.ancestors, ...references.emptyText];
  }

  function assignMaskedReferencePaths(references, paths) {
    const records = referenceList(references);
    if (records.length !== paths.length) throw new Error("Masked reference cardinality changed.");
    records.forEach((record, index) => { record.maskedPath = paths[index]; });
  }

  function sameMaskedReferencePaths(references, paths) {
    const records = referenceList(references);
    return records.length === paths.length
      && records.every((record, index) => JSON.stringify(record.maskedPath) === JSON.stringify(paths[index]));
  }

  function mutationRevisionState() {
    return {
      editorRevision: syncEditorRevision(),
      richApplyDisabled,
    };
  }

  function exactPreBody(record) {
    return sameState(canonicalDomState(document.body), record.preState)
      && exactReferenceRecords(record.references.opaque)
      && exactReferenceRecords(record.references.ancestors)
      && exactReferenceRecords(record.references.emptyText)
      && exactReferenceRecords(record.references.preTarget ?? []);
  }

  function exactRestoration(record) {
    return exactPreBody(record) && currentSelectionStateMatches(record.originalSelectionState);
  }

  function noUndoRestoration(record) {
    let restored = false;
    try {
      restored = exactRestoration(record);
    } catch {
      restored = false;
    }
    if (!restored) richApplyDisabled = true;
    return {
      undoReturned: false,
      restored,
      richApplyDisabled,
      selectionAfterRollback: currentSelectionState(),
      reason: "final-body-already-equals-pre-state",
    };
  }

  function presetMatchesPlacement(preset, placement) {
    return (preset === "inline" && placement === "inline") || (preset === "blocks" && placement === "blocks");
  }

  function placementError(preset, placement) {
    return `The ${preset} fixture cannot apply to a ${placement} selection.`;
  }

  function verifyRevision(record) {
    return syncEditorRevision() === record.expectedRevision;
  }

  function settleTrialRevision(record, state) {
    record.expectedRevision = syncEditorRevision();
    record.state = state;
  }

  function beginEditorCommand() {
    syncEditorRevision();
  }

  function endEditorCommand() {
    return syncEditorRevision();
  }

  function invalidateTrialAfterNativeMismatch(record) {
    record.state = "invalid";
  }

  function validUndoState(record) {
    return record.state === "applied" || record.state === "redone";
  }

  function validRedoState(record) {
    return record.state === "undone";
  }

  function assertRevisionAndState(record, expectedState) {
    if (!expectedState(record) || !verifyRevision(record)) {
      throw new Error("The editor changed after this trial; refusing to consume a native undo unit.");
    }
  }

  async function inspect(exact) {
    syncEditorRevision();
    const state = canonicalDomState(document.body);
    return {
      exact,
      bodyFingerprint: await safeDiagnosticSha256(state),
      body: exact ? state : redactNode(document.body),
      selectionCount: window.getSelection()?.rangeCount ?? 0,
      selectionCollapsed: window.getSelection()?.isCollapsed ?? true,
      richApplyDisabled,
      editorRevision,
      protectedInventory: Array.from(document.body.querySelectorAll(PROTECTED_SELECTOR), (node) => ({
        name: node.localName,
        classes: Array.from(node.classList).sort(),
        attributes: Array.from(node.attributes, (attribute) => attribute.name).sort(),
      })),
    };
  }

  async function capture() {
    syncEditorRevision();
    if (richApplyDisabled) throw new Error("Rich Apply is disabled for this editor because exact rollback could not be verified.");
    const preliminarySelection = window.getSelection();
    if (!preliminarySelection || preliminarySelection.rangeCount !== 1 || preliminarySelection.isCollapsed) {
      throw new Error("Select a non-empty range in the compose body first.");
    }
    const preliminaryRange = preliminarySelection.getRangeAt(0).cloneRange();
    if (!rangeInBody(preliminaryRange)) throw new Error("The selection is outside the compose body.");
    const preliminaryClassification = classify(preliminaryRange).classification;
    const runtimeCapability = preliminaryClassification.eligible && preliminaryClassification.wholeListTargeted
      ? await trustedRuntimeCapability()
      : undefined;

    // Capability discovery may yield. Everything below is the authoritative,
    // synchronous compose snapshot captured after that trusted response.
    syncEditorRevision();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) throw new Error("Select a non-empty range in the compose body first.");
    const selectedRange = selection.getRangeAt(0).cloneRange();
    if (!rangeInBody(selectedRange)) throw new Error("The selection is outside the compose body.");
    const classified = classify(selectedRange);
    const range = classified.effectiveRange ?? selectedRange;
    const classification = classified.classification;
    const captureId = randomId();
    const preState = canonicalDomState(document.body);
    const capturedBoundary = boundary(range);
    const originalBoundary = boundary(selectedRange);
    const originalSelectionState = currentSelectionState();
    const references = referenceRecords(range);
    const emptyBoundaryPolicy = maskEmptyBoundaryPolicy(range);
    const masked = classification.eligible
      ? maskedBodyState(capturedBoundary, referenceList(references).map(({ node }) => node))
      : undefined;
    if (masked) assignMaskedReferencePaths(references, masked.trackedPaths);
    let sameKindList;
    if (classification.wholeListTargeted && runtimeCapability?.sameKindListEligible === true) {
      const list = classified.listTarget;
      if (!list || list.parentNode !== document.body || !supportedListWrapper(list)) {
        throw new Error("The promoted whole-list target lost its exact list ancestry.");
      }
      const verificationRange = document.createRange();
      verificationRange.setStartBefore(list.firstElementChild);
      verificationRange.setEndAfter(list.lastElementChild);
      const candidateReferences = referenceRecords(verificationRange);
      candidateReferences.preTarget = descendantReferenceRecords(list);
      const candidateMasked = maskedBodyState(
        boundary(verificationRange),
        referenceList(candidateReferences).map(({ node }) => node),
      );
      assignMaskedReferencePaths(candidateReferences, candidateMasked.trackedPaths);
      sameKindList = {
        range: selectedRange,
        boundary: originalBoundary,
        originalBoundary,
        originalSelectionState,
        maskedState: candidateMasked.state,
        references: candidateReferences,
        emptyBoundaryPolicy: maskEmptyBoundaryPolicy(verificationRange),
        listKind: list.localName,
        runtimeCapability,
      };
    }
    captures.set(captureId, {
      range,
      boundary: capturedBoundary,
      originalBoundary,
      originalSelectionState,
      selectedText: range.toString(),
      preState,
      preFingerprint: await safeDiagnosticSha256(preState),
      maskedState: masked?.state,
      references,
      emptyBoundaryPolicy,
      classification,
      editorRevision,
      sameKindList,
    });
    latestCaptureId = captureId;
    latestCapturePlacement = classification.placement;
    latestCaptureWholeListTargeted = classification.wholeListTargeted === true;
    latestCaptureSameKindListEligible = Boolean(sameKindList);
    return {
      captureId,
      selectedTextLength: range.toString().length,
      boundary: capturedBoundary,
      originalBoundary,
      wholeListTargeted: classification.wholeListTargeted === true,
      sameKindListEligible: Boolean(sameKindList),
      sameKindListMinimumThunderbirdMajor: SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR,
      preBodyFingerprint: await safeDiagnosticSha256(preState),
      classification,
      selectionFragment: redactNode(range.cloneContents()),
    };
  }

  function addText(parent, value) {
    parent.append(document.createTextNode(value));
  }

  function canonicalFragment(node, preset) {
    if (node.nodeType === Node.TEXT_NODE) return { type: "text", value: node.data };
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return { type: "fragment", children: Array.from(node.childNodes,
        (child) => canonicalFragment(child, preset)) };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) throw new Error("The fixture contains an unsupported node type.");
    if (node.namespaceURI !== XHTML_NAMESPACE) throw new Error("The fixture contains a non-XHTML element.");
    const attributes = Array.from(node.attributes, (attribute) => attribute.name);
    const exactBrowserAddedListItem = isSameKindListPreset(preset) && node.tagName === "LI";
    const observedEditorDecoration = (["B", "I", "U", "BR"].includes(node.tagName)
      || exactBrowserAddedListItem)
      && hasExactEmptyMozDirtyAttribute(node);
    if (attributes.length !== 0 && !observedEditorDecoration) {
      const error = new Error("The editor added an unsupported fixture attribute.");
      error.r0Diagnostic = (["B", "I", "U", "BR"].includes(node.tagName) || exactBrowserAddedListItem)
        ? `fixture-attribute-profile-${node.tagName.toLowerCase()}`
        : "fixture-attribute-profile-other";
      throw error;
    }
    const name = node.localName;
    if (!["p", "br", "b", "i", "u", "ol", "ul", "li"].includes(name)) {
      throw new Error("The editor added an unsupported fixture element.");
    }
    return { type: "element", name, children: Array.from(node.childNodes,
      (child) => canonicalFragment(child, preset)) };
  }

  function fixture(preset, nonce, listKind) {
    const fragment = document.createDocumentFragment();
    const tokens = {};
    let listFixture;
    let tokenShapes;
    const token = (name) => {
      const value = `TC_R0_${name}_${nonce}`;
      tokens[name] = value;
      return value;
    };
    if (preset === "inline") {
      const bold = document.createElement("b");
      addText(bold, token("BOLD"));
      fragment.append(bold, document.createTextNode(" "));
      const italic = document.createElement("i");
      addText(italic, token("ITALIC"));
      const combinedBold = document.createElement("b");
      const combinedItalic = document.createElement("i");
      addText(combinedItalic, token("COMBINED"));
      combinedBold.append(combinedItalic);
      const underline = document.createElement("u");
      addText(underline, token("UNDERLINE"));
      const boldUnderline = document.createElement("b");
      const boldUnderlineInner = document.createElement("u");
      addText(boldUnderlineInner, token("BOLD_UNDERLINE"));
      boldUnderline.append(boldUnderlineInner);
      const italicUnderline = document.createElement("i");
      const italicUnderlineInner = document.createElement("u");
      addText(italicUnderlineInner, token("ITALIC_UNDERLINE"));
      italicUnderline.append(italicUnderlineInner);
      const combinedUnderlineBold = document.createElement("b");
      const combinedUnderlineItalic = document.createElement("i");
      const combinedUnderline = document.createElement("u");
      addText(combinedUnderline, token("COMBINED_UNDERLINE"));
      combinedUnderlineItalic.append(combinedUnderline);
      combinedUnderlineBold.append(combinedUnderlineItalic);
      fragment.append(italic, document.createTextNode(" "), combinedBold,
        document.createTextNode(" "), underline,
        document.createTextNode(" "), boldUnderline,
        document.createTextNode(" "), italicUnderline,
        document.createTextNode(" "), combinedUnderlineBold,
        document.createElement("br"), document.createTextNode(token("LINE")));
    } else if (preset === "blocks") {
      const paragraphOne = document.createElement("p");
      addText(paragraphOne, token("PARAGRAPH"));
      paragraphOne.append(document.createElement("br"), document.createTextNode(token("BREAK")));
      const paragraphTwo = document.createElement("p");
      const bold = document.createElement("b");
      addText(bold, token("BOLD"));
      const italic = document.createElement("i");
      addText(italic, token("ITALIC"));
      const combinedBold = document.createElement("b");
      const combinedItalic = document.createElement("i");
      addText(combinedItalic, token("COMBINED"));
      combinedBold.append(combinedItalic);
      paragraphTwo.append(bold, document.createTextNode(" "), italic, document.createTextNode(" "), combinedBold);
      const ordered = document.createElement("ol");
      const orderedOne = document.createElement("li");
      const orderedTwo = document.createElement("li");
      addText(orderedOne, token("ORDERED_ONE"));
      addText(orderedTwo, token("ORDERED_TWO"));
      ordered.append(orderedOne, orderedTwo);
      const unordered = document.createElement("ul");
      const unorderedOne = document.createElement("li");
      const unorderedTwo = document.createElement("li");
      addText(unorderedOne, token("UNORDERED_ONE"));
      addText(unorderedTwo, token("UNORDERED_TWO"));
      unordered.append(unorderedOne, unorderedTwo);
      fragment.append(paragraphOne, paragraphTwo, ordered, unordered);
    } else if (isSameKindListPreset(preset)) {
      if (!["ul", "ol"].includes(listKind)) throw new Error("Same-kind list fixture requires a captured UL or OL.");
      const list = document.createElement(listKind);
      const appendItem = (name, marks = []) => {
        const item = document.createElement("li");
        let parent = item;
        for (const mark of marks) {
          const element = document.createElement(mark);
          parent.append(element);
          parent = element;
        }
        addText(parent, token(name));
        list.append(item);
        return {
          name,
          element: marks.at(-1) ?? "li",
          ancestors: marks.length === 0 ? [listKind] : [...marks.slice(0, -1).reverse(), "li", listKind],
        };
      };
      if (preset === "same-kind-list-rewrite") {
        tokenShapes = [appendItem("LIST_REWRITE_ONE"), appendItem("LIST_REWRITE_BOLD", ["b"]),
          appendItem("LIST_REWRITE_ITALIC_UNDERLINE", ["i", "u"])];
      } else if (preset === "same-kind-list-add") {
        tokenShapes = [appendItem("LIST_ADD_ONE"), appendItem("LIST_ADD_BOLD", ["b"]),
          appendItem("LIST_ADD_ITALIC_UNDERLINE", ["i", "u"]), appendItem("LIST_ADD_FOUR")];
      } else if (preset === "same-kind-list-remove") {
        tokenShapes = [appendItem("LIST_REMOVE_BOLD", ["b"]), appendItem("LIST_REMOVE_UNDERLINE", ["u"])];
      } else {
        tokenShapes = [appendItem("LIST_REORDER_THREE"), appendItem("LIST_REORDER_ONE", ["b"]),
          appendItem("LIST_REORDER_TWO", ["i"])];
      }
      fragment.append(list);
      listFixture = list;
    } else {
      throw new Error("Unknown local fixture preset.");
    }
    const container = document.createElement("div");
    container.append(fragment);
    const expectedFragment = document.createDocumentFragment();
    const expectedNodes = listFixture ? listFixture.childNodes : container.childNodes;
    for (const child of Array.from(expectedNodes)) expectedFragment.append(child.cloneNode(true));
    return {
      safeHtml: container.innerHTML,
      tokens,
      expectedStructure: canonicalFragment(expectedFragment, preset),
      ...(listFixture ? { listKind, tokenShapes } : {}),
    };
  }

  function tokenElements(value) {
    return Array.from(document.body.querySelectorAll("*"), (element) => element)
      .filter((element) => element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE && element.textContent === value);
  }

  function fixtureShape(preset, tokens) {
    const tokenShapes = arguments[2];
    const tokenNames = Object.keys(tokens);
    for (const name of tokenNames) {
      const occurrences = document.body.textContent.split(tokens[name]).length - 1;
      if (occurrences !== 1) {
        return { valid: false, detail: { reason: "token-occurrences", token: name, count: boundedCount(occurrences) } };
      }
    }
    const requireElement = (name, expectedName, expectedAncestorNames = []) => {
      const elements = tokenElements(tokens[name]);
      if (elements.length !== 1) {
        return { reason: "token-container-count", token: name, count: boundedCount(elements.length) };
      }
      const element = elements[0];
      if (element.namespaceURI !== XHTML_NAMESPACE || element.localName !== expectedName) {
        return { reason: "token-container", token: name, actual: diagnosticStateDescriptor(canonicalDomState(element)) };
      }
      let ancestor = element.parentElement;
      for (const expectedAncestorName of expectedAncestorNames) {
        if (ancestor?.namespaceURI !== XHTML_NAMESPACE || ancestor.localName !== expectedAncestorName) {
          return { reason: "token-parent", token: name,
            actual: diagnosticStateDescriptor(ancestor ? canonicalDomState(ancestor) : undefined) };
        }
        ancestor = ancestor.parentElement;
      }
      return undefined;
    };
    let detail;
    if (!isSameKindListPreset(preset)) {
      detail = requireElement("BOLD", "b")
        ?? requireElement("ITALIC", "i")
        ?? requireElement("COMBINED", "i", ["b"]);
    }
    if (preset === "inline") {
      detail ??= requireElement("UNDERLINE", "u")
        ?? requireElement("BOLD_UNDERLINE", "u", ["b"])
        ?? requireElement("ITALIC_UNDERLINE", "u", ["i"])
        ?? requireElement("COMBINED_UNDERLINE", "u", ["i", "b"]);
    }
    if (detail) return { valid: false, detail };
    if (preset === "blocks") {
      for (const name of ["ORDERED_ONE", "ORDERED_TWO"]) {
        detail = requireElement(name, "li", ["ol"]);
        if (detail) return { valid: false, detail };
      }
      for (const name of ["UNORDERED_ONE", "UNORDERED_TWO"]) {
        detail = requireElement(name, "li", ["ul"]);
        if (detail) return { valid: false, detail };
      }
      const paragraphs = tokenElements(tokens.PARAGRAPH);
      if (paragraphs.length !== 0) {
        return { valid: false, detail: { reason: "paragraph-token-container", count: boundedCount(paragraphs.length) } };
      }
      const paragraphNode = Array.from(document.body.children).find((element) => element.textContent.includes(tokens.PARAGRAPH));
      if (!paragraphNode || paragraphNode.namespaceURI !== XHTML_NAMESPACE || paragraphNode.localName !== "p") {
        return { valid: false, detail: { reason: "paragraph-container", actual: diagnosticStateDescriptor(paragraphNode ? canonicalDomState(paragraphNode) : undefined) } };
      }
      const breaks = Array.from(paragraphNode.childNodes)
        .filter((node) => node.nodeType === Node.ELEMENT_NODE && node.namespaceURI === XHTML_NAMESPACE && node.localName === "br");
      if (breaks.length !== 1) {
        return { valid: false, detail: { reason: "paragraph-break-count", count: boundedCount(breaks.length) } };
      }
    }
    if (isSameKindListPreset(preset)) {
      if (!Array.isArray(tokenShapes) || tokenShapes.length < 2 || tokenShapes.length > 4) {
        return { valid: false, detail: { reason: "list-token-shapes" } };
      }
      for (const shape of tokenShapes) {
        detail = requireElement(shape.name, shape.element, shape.ancestors);
        if (detail) return { valid: false, detail };
      }
    }
    return { valid: true };
  }

  function verifyFixture(preset, tokens) {
    return fixtureShape(preset, tokens, arguments[2]).valid;
  }

  function exactTokenTextNode(value) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.data === value) matches.push(node);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  function uniqueTokenTextSlice(value) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
      let offset = node.data.indexOf(value);
      while (offset !== -1) {
        matches.push({ node, offset });
        offset = node.data.indexOf(value, offset + value.length);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  function lowestCommonAncestor(first, second) {
    const ancestors = new Set();
    let current = first;
    while (current) {
      ancestors.add(current);
      current = current.parentNode;
    }
    current = second;
    while (current && !ancestors.has(current)) current = current.parentNode;
    return current;
  }

  function directChildUnder(node, ancestor) {
    let current = node;
    while (current?.parentNode && current.parentNode !== ancestor) current = current.parentNode;
    if (current?.parentNode !== ancestor) throw new Error("Fixture boundary is not under its common ancestor.");
    return current;
  }

  function insertedFixtureRange(preset, tokens) {
    const tokenShapes = arguments[2];
    const firstName = isSameKindListPreset(preset) ? tokenShapes?.[0]?.name
      : preset === "inline" ? "BOLD" : "PARAGRAPH";
    const lastName = isSameKindListPreset(preset) ? tokenShapes?.at(-1)?.name : "UNORDERED_TWO";
    const first = exactTokenTextNode(tokens[firstName]);
    const inlineLast = preset === "inline" ? uniqueTokenTextSlice(tokens.LINE) : undefined;
    const last = preset === "inline" ? inlineLast?.node : exactTokenTextNode(tokens[lastName]);
    if (!first || !last || (preset === "inline" && inlineLast.offset !== 0)) return undefined;
    const ancestor = lowestCommonAncestor(first, last);
    if (!ancestor || ancestor === document) return undefined;
    const firstChild = directChildUnder(first, ancestor);
    const lastChild = directChildUnder(last, ancestor);
    const range = document.createRange();
    range.setStartBefore(firstChild);
    if (preset === "inline") range.setEnd(last, inlineLast.offset + tokens.LINE.length);
    else range.setEndAfter(lastChild);
    return range;
  }

  function verifyExactConfinement(record, preset, generated) {
    const range = insertedFixtureRange(preset, generated.tokens, generated.tokenShapes);
    if (!range || !rangeInBody(range)) return { exact: false, detail: { reason: "fixture-range" } };
    if (JSON.stringify(canonicalFragment(range.cloneContents(), preset)) !== JSON.stringify(generated.expectedStructure)) {
      return { exact: false, detail: { reason: "fixture-structure" } };
    }
    const masked = maskedBodyState(boundary(range), referenceList(record.references).map(({ node }) => node), {
      emptyBoundaryPolicy: record.emptyBoundaryPolicy,
      preservedEmptyNodes: record.references.emptyText.map(({ node }) => node),
    });
    if (!sameState(masked.state, record.maskedState)) {
      return { exact: false, detail: firstCanonicalMismatch(record.maskedState, masked.state) ?? { reason: "canonical-state" } };
    }
    if (!sameMaskedReferencePaths(record.references, masked.trackedPaths)) {
      return { exact: false, detail: { reason: "masked-reference-paths" } };
    }
    return { exact: true };
  }

  function rollback(captureRecord) {
    document.body.focus();
    beginEditorCommand();
    let undoReturned = false;
    try {
      undoReturned = document.execCommand("undo");
    } catch {
      undoReturned = false;
    } finally {
      endEditorCommand();
    }
    let restored = false;
    try {
      if (undoReturned) restoreSelectionState(captureRecord.originalSelectionState);
      restored = undoReturned && exactRestoration(captureRecord);
    } catch {
      restored = false;
    }
    if (!restored) richApplyDisabled = true;
    return { undoReturned, restored, richApplyDisabled, selectionAfterRollback: currentSelectionState() };
  }

  async function apply(captureId, preset, induceFailure, editorMode) {
    if (richApplyDisabled) throw new Error("Rich Apply is disabled for this editor because exact rollback could not be verified.");
    if (editorMode?.isPlainText !== false || !["auto", "both", "html"].includes(editorMode.deliveryFormat)) {
      throw new Error("Rich Apply requires an HTML-capable editor with auto, both, or html delivery format.");
    }
    const captureRecord = captures.get(captureId);
    if (!captureRecord || !rangeInBody(captureRecord.range)) throw new Error("Capture expired; capture the current selection again.");
    if (!captureRecord.classification.eligible) {
      throw new Error(`Selection is ineligible: ${captureRecord.classification.reasons.join("; ")}`);
    }
    const sameKindListPreset = isSameKindListPreset(preset);
    if (captureRecord.classification.wholeListTargeted && !sameKindListPreset) {
      throw new Error("A complete list selection accepts only a same-kind whole-list replacement preset.");
    }
    if (sameKindListPreset && !captureRecord.sameKindList) {
      throw new Error("Same-kind whole-list replacement requires Thunderbird 153 or newer and an exact complete flat list selection.");
    }
    if (sameKindListPreset) {
      const currentCapability = await trustedRuntimeCapability();
      if (!currentCapability
        || JSON.stringify(currentCapability) !== JSON.stringify(captureRecord.sameKindList.runtimeCapability)) {
        throw new Error("The trusted Thunderbird runtime capability changed after capture; capture the list again.");
      }
    }
    const record = sameKindListPreset
      ? { ...captureRecord, ...captureRecord.sameKindList }
      : captureRecord;
    if (!sameKindListPreset && !presetMatchesPlacement(preset, record.classification.placement)) {
      throw new Error(placementError(preset, record.classification.placement));
    }
    if (syncEditorRevision() !== record.editorRevision
      || !sameState(canonicalDomState(document.body), record.preState)
      || JSON.stringify(boundary(record.range)) !== JSON.stringify(record.boundary)
      || !currentSelectionStateMatches(record.originalSelectionState)
      || !exactReferenceRecords(record.references.opaque)
      || !exactReferenceRecords(record.references.ancestors)
      || !exactReferenceRecords(record.references.emptyText)
      || !exactReferenceRecords(record.references.preTarget ?? [])) {
      throw new Error("The compose body or exact selection boundary changed after capture.");
    }
    const generated = fixture(preset, randomId().slice(0, 12), record.listKind);
    document.body.focus();
    if (!currentSelectionStateMatches(record.originalSelectionState)) {
      throw new Error("Focusing the compose editor changed the exact selection direction or boundary.");
    }
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    beginEditorCommand();
    let commandReturned = false;
    let commandError = false;
    let mutationCount = 0;
    let postRevision;
    let postcondition = false;
    let verificationError = false;
    let verificationFailedAt = "editor-command";
    let verificationFailureSubtype;
    let verificationFailureDetail;
    let postState;
    let postReferences;
    try {
      try {
        commandReturned = document.execCommand("insertHTML", false, generated.safeHtml);
      } catch {
        commandError = true;
      }
      mutationCount = observer.takeRecords().length;
      postRevision = endEditorCommand();
      if (commandError || !commandReturned || mutationCount <= 0) {
        verificationFailedAt = "editor-command-result";
      } else {
        verificationFailedAt = "fixture-shape";
        const shape = fixtureShape(preset, generated.tokens, generated.tokenShapes);
        const fixtureValid = shape.valid;
        if (!fixtureValid) verificationFailureDetail = shape.detail;
        verificationFailedAt = fixtureValid ? "exact-confinement" : verificationFailedAt;
        const confinement = fixtureValid ? verifyExactConfinement(record, preset, generated) : { exact: false };
        const exactConfinement = confinement.exact;
        if (fixtureValid && !exactConfinement) {
          verificationFailureSubtype = "canonical-mask-mismatch";
          verificationFailureDetail = confinement.detail;
        }
        verificationFailedAt = exactConfinement ? "opaque-references" : verificationFailedAt;
        const opaqueReferences = exactConfinement && exactReferenceIdentityState(record.references.opaque)
          && exactReferenceIdentityState(record.references.emptyText);
        verificationFailedAt = opaqueReferences ? "ancestor-references" : verificationFailedAt;
        const ancestorReferences = opaqueReferences && connectedReferenceIdentity(record.references.ancestors);
        verificationFailedAt = ancestorReferences ? "induced-failure" : verificationFailedAt;
        postcondition = ancestorReferences && !induceFailure;
        if (postcondition) verificationFailedAt = "complete";
      }
      if (postcondition) {
        postState = canonicalDomState(document.body);
        postReferences = {
          opaque: refreshedReferenceRecords(record.references.opaque),
          ancestors: refreshedReferenceRecords(record.references.ancestors),
          emptyText: refreshedReferenceRecords(record.references.emptyText),
        };
      }
    } catch (error) {
      verificationError = true;
      postcondition = false;
      const fixedSubtype = error?.r0Diagnostic;
      verificationFailureSubtype = [
        "fixture-attribute-profile-b",
        "fixture-attribute-profile-i",
        "fixture-attribute-profile-u",
        "fixture-attribute-profile-br",
        "fixture-attribute-profile-li",
        "fixture-attribute-profile-other",
      ].includes(fixedSubtype) ? fixedSubtype : `${verificationFailedAt}-exception`;
    } finally {
      try {
        mutationCount += observer.takeRecords().length;
      } catch {
        verificationError = true;
        postcondition = false;
      }
      observer.disconnect();
      if (postRevision === undefined) postRevision = endEditorCommand();
    }
    captures.delete(captureId);
    if (latestCaptureId === captureId) {
      latestCaptureId = undefined;
      latestCapturePlacement = undefined;
      latestCaptureWholeListTargeted = false;
      latestCaptureSameKindListEligible = false;
    }
    if (!postcondition) {
      let alreadyPreBody = false;
      try {
        alreadyPreBody = exactPreBody(record);
      } catch {
        alreadyPreBody = false;
      }
      if (alreadyPreBody) {
        try {
          restoreSelectionState(record.originalSelectionState);
        } catch {
          // Exact no-Undo restoration below fails closed.
        }
      }
      const noUndoResult = alreadyPreBody ? noUndoRestoration(record) : undefined;
      const rollbackResult = noUndoResult?.restored ? noUndoResult : rollback(record);
      return {
        applied: false,
        inducedFailure: Boolean(induceFailure),
        commandReturned,
        commandError,
        verificationError,
        verificationFailedAt,
        verificationFailureSubtype,
        verificationFailureDetail,
        mutationCount,
        rollback: rollbackResult,
        warning: rollbackResult.restored ? undefined : "The draft may have changed. Rich Apply is disabled for this editor.",
      };
    }
    const trialId = randomId();
    trials.set(trialId, {
      preState: record.preState,
      preFingerprint: record.preFingerprint,
      postState,
      postFingerprint: await safeDiagnosticSha256(postState),
      preReferences: record.references,
      postReferences,
      expectedRevision: postRevision,
      state: "applied",
      preset,
      safeHtml: generated.safeHtml,
      tokens: generated.tokens,
      tokenShapes: generated.tokenShapes,
      listKind: generated.listKind,
      preSelectionBoundary: record.originalBoundary,
      preSelectionState: record.originalSelectionState,
      postSelectionState: currentSelectionState(),
    });
    latestTrialId = trialId;
    return {
      applied: true,
      trialId,
      preset,
      method: "document.execCommand(insertHTML)",
      commandReturned,
      mutationCount,
      preBodyFingerprint: record.preFingerprint,
      postBodyFingerprint: await safeDiagnosticSha256(postState),
      safeHtml: generated.safeHtml,
      postcondition: true,
      adjacentOpaqueUnchanged: true,
      editorRevision: postRevision,
      selectionBeforeApply: { boundary: record.boundary, textLength: record.selectedText.length },
      selectionAfterApply: currentSelectionState(),
    };
  }

  function trial(trialId) {
    const value = trials.get(trialId);
    if (!value) throw new Error("Trial record is unavailable in this compose window.");
    return value;
  }

  async function undo(trialId) {
    const record = trial(trialId);
    assertRevisionAndState(record, validUndoState);
    if (!sameState(canonicalDomState(document.body), record.postState)
      || !exactReferenceRecords(record.postReferences.opaque)
      || !exactReferenceRecords(record.postReferences.ancestors)
      || !exactReferenceRecords(record.postReferences.emptyText)) {
      throw new Error("The draft changed after Apply; refusing to invoke Undo.");
    }
    document.body.focus();
    beginEditorCommand();
    const commandReturned = document.execCommand("undo");
    endEditorCommand();
    let exact = false;
    try {
      if (commandReturned) restoreSelectionState(record.preSelectionState);
      exact = commandReturned && sameState(canonicalDomState(document.body), record.preState)
        && exactReferenceRecords(record.preReferences.opaque)
        && exactReferenceRecords(record.preReferences.ancestors)
        && exactReferenceRecords(record.preReferences.emptyText)
        && exactReferenceRecords(record.preReferences.preTarget ?? [])
        && currentSelectionStateMatches(record.preSelectionState);
    } catch {
      exact = false;
    }
    if (exact) settleTrialRevision(record, "undone");
    else invalidateTrialAfterNativeMismatch(record);
    return {
      commandReturned,
      exact,
      bodyFingerprint: await safeDiagnosticSha256(canonicalDomState(document.body)),
      selectionAfterUndo: currentSelectionState(),
      editorRevision: record.expectedRevision,
    };
  }

  async function redo(trialId) {
    const record = trial(trialId);
    assertRevisionAndState(record, validRedoState);
    if (!sameState(canonicalDomState(document.body), record.preState)
      || !exactReferenceRecords(record.preReferences.opaque)
      || !exactReferenceRecords(record.preReferences.ancestors)
      || !exactReferenceRecords(record.preReferences.emptyText)
      || !exactReferenceRecords(record.preReferences.preTarget ?? [])) {
      throw new Error("The draft is not at this trial's exact pre-Apply state.");
    }
    document.body.focus();
    beginEditorCommand();
    const commandReturned = document.execCommand("redo");
    endEditorCommand();
    let exact = false;
    try {
      exact = commandReturned && sameState(canonicalDomState(document.body), record.postState)
        && verifyFixture(record.preset, record.tokens, record.tokenShapes)
        && exactReferenceRecords(record.postReferences.opaque)
        && exactReferenceRecords(record.postReferences.ancestors)
        && exactReferenceRecords(record.postReferences.emptyText)
        && sameState(currentSelectionState(), record.postSelectionState);
    } catch {
      exact = false;
    }
    if (exact) settleTrialRevision(record, "redone");
    else invalidateTrialAfterNativeMismatch(record);
    return {
      commandReturned,
      exact,
      bodyFingerprint: await safeDiagnosticSha256(canonicalDomState(document.body)),
      selectionAfterRedo: currentSelectionState(),
      editorRevision: record.expectedRevision,
    };
  }

  async function verify(trialId, expected) {
    const record = trial(trialId);
    syncEditorRevision();
    const expectedState = expected === "pre" ? record.preState : expected === "post" ? record.postState : undefined;
    const expectedReferences = expected === "pre" ? record.preReferences : expected === "post" ? record.postReferences : undefined;
    if (!expectedState || !expectedReferences) throw new Error("Unknown trial verification state.");
    let exact = false;
    try {
      exact = sameState(canonicalDomState(document.body), expectedState)
        && exactReferenceRecords(expectedReferences.opaque)
        && exactReferenceRecords(expectedReferences.ancestors)
        && exactReferenceRecords(expectedReferences.emptyText)
        && (expected !== "pre" || exactReferenceRecords(expectedReferences.preTarget ?? []))
        && (expected === "pre"
          ? currentSelectionStateMatches(record.preSelectionState)
          : sameState(currentSelectionState(), record.postSelectionState));
    } catch {
      exact = false;
    }
    if (exact) settleTrialRevision(record, expected === "pre" ? "undone" : "redone");
    return {
      expected,
      exact,
      actualFingerprint: await safeDiagnosticSha256(canonicalDomState(document.body)),
      expectedFingerprint: expected === "pre" ? record.preFingerprint : record.postFingerprint,
      editorRevision,
    };
  }

  async function handleMessage(message) {
    if (!message || typeof message.type !== "string" || !message.type.startsWith("rich-compose-r0.")) return undefined;
    try {
      const operation = message.type.slice("rich-compose-r0.".length);
      if (operation === "state") {
        const latestCapture = latestCaptureId ? captures.get(latestCaptureId) : undefined;
        if (!latestCapture) {
          latestCaptureId = undefined;
          latestCapturePlacement = undefined;
          latestCaptureWholeListTargeted = false;
          latestCaptureSameKindListEligible = false;
        }
        return { ok: true, value: { latestCaptureId, latestCapturePlacement,
          latestCaptureWholeListTargeted, latestCaptureSameKindListEligible,
          latestTrialId, ...mutationRevisionState() } };
      }
      if (operation === "inspect") return { ok: true, value: await inspect(message.exact === true) };
      if (operation === "capture") return { ok: true, value: await capture() };
      if (operation === "apply") {
        return {
          ok: true,
          value: await apply(message.captureId, message.preset, message.induceFailure === true, message.editorMode),
        };
      }
      if (operation === "undo") return { ok: true, value: await undo(message.trialId) };
      if (operation === "redo") return { ok: true, value: await redo(message.trialId) };
      if (operation === "verify") return { ok: true, value: await verify(message.trialId, message.expected) };
      return undefined;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "R0 compose operation failed." };
    }
  }

  browser.runtime.onMessage.addListener(handleMessage);

  // Development-only bridge for the network-disabled Marionette runner. It
  // shares the fixed operation handler and never accepts HTML or model data.
  document.addEventListener("thunderclaw-r0-automation-request", () => void (async () => {
    const sequence = document.documentElement.dataset.thunderclawR0AutomationSequence;
    let response;
    try {
      const request = JSON.parse(document.documentElement.dataset.thunderclawR0AutomationRequest || "null");
      if (!request || request.buildId !== R0_AUTOMATION_BUILD_ID
        || !["ping", "capture", "apply", "undo", "redo", "verify"].includes(request.operation)) {
        throw new Error("Unsupported R0 automation operation.");
      }
      const extra = request.extra ?? {};
      const keys = Object.keys(extra).sort();
      if (["ping", "capture"].includes(request.operation) && keys.length !== 0) {
        throw new Error("R0 automation Ping/Capture accepts no fields.");
      }
      if (request.operation === "apply") {
        const allowedKeys = ["captureId", "editorMode", "induceFailure", "preset"];
        if (JSON.stringify(keys) !== JSON.stringify(allowedKeys)
          || !/^[0-9a-f]{32}$/u.test(extra.captureId)
          || (!["inline", "blocks"].includes(extra.preset) && !isSameKindListPreset(extra.preset))
          || typeof extra.induceFailure !== "boolean"
          || extra.editorMode?.isPlainText !== false
          || !["auto", "both", "html"].includes(extra.editorMode?.deliveryFormat)) {
          throw new Error("R0 automation Apply fields are invalid.");
        }
      }
      if (["undo", "redo"].includes(request.operation)
        && (JSON.stringify(keys) !== JSON.stringify(["trialId"]) || !/^[0-9a-f]{32}$/u.test(extra.trialId))) {
        throw new Error("R0 automation trial fields are invalid.");
      }
      if (request.operation === "verify"
        && (JSON.stringify(keys) !== JSON.stringify(["expected", "trialId"])
          || !/^[0-9a-f]{32}$/u.test(extra.trialId) || !["pre", "post"].includes(extra.expected))) {
        throw new Error("R0 automation verification fields are invalid.");
      }
      response = request.operation === "ping" ? { ok: true, value: { ready: true } }
        : await handleMessage({ type: `rich-compose-r0.${request.operation}`, ...(request.extra ?? {}) });
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : "R0 automation failed." };
    }
    response.buildId = R0_AUTOMATION_BUILD_ID;
    document.documentElement.dataset.thunderclawR0AutomationResult = JSON.stringify(response);
    document.documentElement.dataset.thunderclawR0AutomationCompleted = sequence;
  })());
})();
