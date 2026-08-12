import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const compose = await readFile(path.join(root, "source", "compose.js"), "utf8");
const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-rich-compose-adversarial-"));
const page = path.join(temporary, "harness.html");

const harness = String.raw`
<!doctype html>
<meta charset="utf-8">
<body contenteditable="true"></body>
<script>
let composeListener;
let runtimeCapability = {
  buildId: "thunderclaw-rich-compose-r0@example.invalid:0.0.1",
  instance: "0123456789abcdef0123456789abcdef",
  minimumThunderbirdMajor: 153,
  sameKindListEligible: true,
};
let delayedCapabilityResolver;
let delayRuntimeCapability = false;
globalThis.browser = { runtime: {
  async sendMessage() {
    if (!delayRuntimeCapability) return runtimeCapability;
    return new Promise((resolve) => { delayedCapabilityResolver = () => resolve(runtimeCapability); });
  },
  onMessage: { addListener(value) { composeListener = value; } },
} };
</script>
<script>${compose.replaceAll("</script", "<\\/script")}</script>
<script>
(async () => {
  const results = {};
  const nativeInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  Object.defineProperty(document.body, "innerHTML", {
    configurable: true,
    get() {
      const clone = this.cloneNode(true);
      for (const element of clone.querySelectorAll("*")) {
        element.removeAttribute("_moz_dirty");
        element.removeAttribute("data-gecko-hidden");
      }
      return nativeInnerHTML.get.call(clone);
    },
    set(value) { nativeInnerHTML.set.call(this, value); },
  });
  const request = async (type, extra = {}) => composeListener({ type: "rich-compose-r0." + type, ...extra });
  let automationSequence = 0;
  const automation = async (operation, extra = {}, buildId = "thunderclaw-rich-compose-r0@example.invalid:0.0.1") => {
    const sequence = String(++automationSequence);
    document.documentElement.dataset.thunderclawR0AutomationSequence = sequence;
    document.documentElement.dataset.thunderclawR0AutomationRequest = JSON.stringify({ buildId, operation, extra });
    document.dispatchEvent(new Event("thunderclaw-r0-automation-request"));
    for (let attempt = 0; attempt < 100
      && document.documentElement.dataset.thunderclawR0AutomationCompleted !== sequence; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const response = JSON.parse(document.documentElement.dataset.thunderclawR0AutomationResult);
    for (const name of ["thunderclawR0AutomationSequence", "thunderclawR0AutomationRequest",
      "thunderclawR0AutomationResult", "thunderclawR0AutomationCompleted"]) delete document.documentElement.dataset[name];
    return response;
  };
  const textNode = (element = document.body) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  };
  const selectText = (element, start = 0, end) => {
    const node = textNode(element);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end ?? node.data.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const selectBodyBlocks = (start, end, followingOffsetZero = false) => {
    const range = document.createRange();
    range.setStart(document.body, start);
    if (followingOffsetZero) range.setEnd(document.body.childNodes[end], 0);
    else range.setEnd(document.body, end);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const selectWholeListText = (list = document.body.querySelector("ul,ol")) => {
    const range = document.createRange();
    const first = textNode(list.firstElementChild);
    const last = textNode(list.lastElementChild);
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  };
  const selectWholeListTextBackward = (list = document.body.querySelector("ul,ol")) => {
    const first = textNode(list.firstElementChild);
    const last = textNode(list.lastElementChild);
    getSelection().setBaseAndExtent(last, last.data.length, first, 0);
  };
  const reset = (html) => {
    document.body.innerHTML = html;
    getSelection().removeAllRanges();
  };
  const geckoLegacySerialization = () => {
    const clone = document.body.cloneNode(true);
    for (const element of clone.querySelectorAll("*")) {
      element.removeAttribute("_moz_dirty");
      element.removeAttribute("data-gecko-hidden");
    }
    return clone.innerHTML;
  };
  const geckoLegacyHiddenAttributeView = (elements) => Array.from(elements, (element) => ({
    name: element.localName,
    attributes: Array.from(element.attributes, ({ name, value }) => [name, value])
      .filter(([name]) => !["_moz_dirty", "data-gecko-hidden"].includes(name))
      .sort(),
  }));
  const editor = ({ normalizePrefix = false, undoRestores = true, undoRequiresPostCommandSelection = false, restoreOriginalTargetIdentities = true, mutate = true, transientNoNet = false, replaceOpaque = false, relocateOpaque = false, preserveOpaque = false, mozDirtyMutation, mozDirtySelector, decorateInsertedBreak = false, decorateInsertedFixture, decorateInsertedListItems, sameKindListMerge = false, foreignInsertedBold = false, wrapInsertedFixture = false, mergeInsertedLineSuffix = false, pruneSelectedBoundaryText = false, removeOriginalEmptySibling = false, hiddenTargetMutation = false, verificationException = false, throwAfterMutation = false, rollbackVerificationException = false, undoThrows = false } = {}) => {
    let before;
    let after;
    let beforeNodes;
    let afterNodes;
    let beforeLiveRecords;
    let retainedRecords;
    let preTargetRecords;
    let removedOriginalEmptyRecord;
    let geckoHiddenNodes;
    let originalOpaque;
    let beforeSelection;
    let afterSelection;
    const preservedOpaque = [];
    if (preserveOpaque) {
      for (const node of document.querySelectorAll("[data-r0-opaque]")) preservedOpaque.push({ node, marker: node.dataset.r0Opaque, snapshot: node.cloneNode(true) });
      const comments = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
      let comment;
      while ((comment = comments.nextNode())) {
        if (comment.data.includes("r0-adjacent")) preservedOpaque.push({ node: comment, marker: comment.data, snapshot: comment.cloneNode(true) });
      }
    }
    const restorePreservedOpaque = () => {
      for (const preserved of preservedOpaque) {
        let clone;
        if (preserved.node.nodeType === Node.COMMENT_NODE) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
          while ((clone = walker.nextNode()) && clone.data !== preserved.marker) {}
        } else {
          clone = document.querySelector('[data-r0-opaque="' + preserved.marker + '"]');
        }
        restoreRetained(preserved.node, preserved.snapshot);
        if (clone !== preserved.node) clone.replaceWith(preserved.node);
      }
    };
    const restoreRetained = (node, snapshot) => {
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
        node.data = snapshot.data;
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE && snapshot.nodeType === Node.ELEMENT_NODE) {
        for (const attribute of Array.from(node.attributes)) node.removeAttributeNode(attribute);
        for (const attribute of Array.from(snapshot.attributes)) {
          if (attribute.namespaceURI) node.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
          else node.setAttribute(attribute.name, attribute.value);
        }
      }
      node.replaceChildren(...Array.from(snapshot.childNodes, (child) => child.cloneNode(true)));
    };
    const pathOf = (node) => {
      const path = [];
      let current = node;
      while (current !== document.body) {
        const parent = current.parentNode;
        path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
        current = parent;
      }
      return path;
    };
    const resolve = (path) => path.reduce((node, index) => node.childNodes[index], document.body);
    const selectionBoundary = () => {
      const selection = getSelection();
      const range = selection.getRangeAt(0);
      return { startPath: pathOf(range.startContainer), startOffset: range.startOffset,
        endPath: pathOf(range.endContainer), endOffset: range.endOffset,
        anchorPath: pathOf(selection.anchorNode), anchorOffset: selection.anchorOffset,
        focusPath: pathOf(selection.focusNode), focusOffset: selection.focusOffset };
    };
    const restoreSelection = (value) => {
      const selection = getSelection();
      selection.removeAllRanges();
      selection.setBaseAndExtent(resolve(value.anchorPath), value.anchorOffset,
        resolve(value.focusPath), value.focusOffset);
    };
    const allLiveNodes = () => {
      const nodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      return nodes;
    };
    const restoreRetainedRecords = (phase) => {
      const pathName = phase + "Path";
      const snapshotName = phase + "Snapshot";
      for (const record of [...(retainedRecords ?? [])].sort((a, b) => a[pathName].length - b[pathName].length)) {
        const clone = resolve(record[pathName]);
        restoreRetained(record.node, record[snapshotName]);
        if (clone !== record.node) clone.replaceWith(record.node);
      }
    };
    const counts = { insertHTML: 0, undo: 0, redo: 0, legacyBefore: undefined, legacyAfter: undefined, legacyHiddenBefore: undefined, legacyHiddenAfter: undefined };
    document.execCommand = (command, _ui, value) => {
      if (command === "insertHTML") {
        counts.insertHTML += 1;
        before = document.body.innerHTML;
        counts.legacyBefore = geckoLegacySerialization();
        geckoHiddenNodes = Array.from(document.querySelectorAll("[_moz_dirty],[data-gecko-hidden]"));
        counts.legacyHiddenBefore = geckoLegacyHiddenAttributeView(geckoHiddenNodes);
        beforeNodes = Array.from(document.body.childNodes, (node) => node.cloneNode(true));
        beforeLiveRecords = allLiveNodes().map((node) => ({ node, beforePath: pathOf(node), beforeSnapshot: node.cloneNode(true) }));
        beforeSelection = selectionBoundary();
        if (replaceOpaque) originalOpaque = document.querySelector("[data-private]");
        if (transientNoNet) {
          document.body.setAttribute("data-transient", "yes");
          document.body.removeAttribute("data-transient");
          return false;
        }
        if (!mutate) return false;
        const range = getSelection().getRangeAt(0);
        const selectedStartNode = range.startContainer;
        const selectedEndNode = range.endContainer;
        const selectedStartOffset = range.startOffset;
        const selectedEndOffset = range.endOffset;
        const selectedStartLength = selectedStartNode.nodeType === Node.TEXT_NODE ? selectedStartNode.data.length : undefined;
        const selectedEndLength = selectedEndNode.nodeType === Node.TEXT_NODE ? selectedEndNode.data.length : undefined;
        const template = document.createElement("template");
        template.innerHTML = value;
        if (sameKindListMerge) {
          const directItem = selectedStartNode.parentElement?.closest("li");
          const targetList = directItem?.parentElement ?? (selectedStartNode === document.body
            ? document.body.childNodes[selectedStartOffset] : undefined);
          const insertedList = template.content.firstElementChild;
          preTargetRecords = beforeLiveRecords.filter(({ node }) => targetList?.contains(node) && node !== targetList);
          if (selectedStartNode !== document.body) range.deleteContents();
          if (!targetList || !["UL", "OL"].includes(targetList.tagName)
            || insertedList?.tagName !== targetList.tagName) {
            throw new Error("synthetic same-kind list merge received mismatched wrappers");
          }
          targetList.replaceChildren(...Array.from(insertedList.childNodes));
          const postRange = document.createRange();
          postRange.setStartBefore(targetList.firstElementChild);
          postRange.setEndAfter(targetList.lastElementChild);
          getSelection().removeAllRanges();
          getSelection().addRange(postRange);
        } else {
          range.deleteContents();
          range.insertNode(template.content);
        }
        if (decorateInsertedListItems) {
          const inserted = Array.from(document.querySelectorAll("li"))
            .filter((candidate) => !beforeLiveRecords.some(({ node }) => node === candidate));
          for (const candidate of inserted) candidate.setAttribute("_moz_dirty", "");
          const target = inserted[0];
          if (decorateInsertedListItems === "wrong-value") target?.setAttribute("_moz_dirty", "changed");
          if (decorateInsertedListItems === "additional") target?.setAttribute("data-extra", "hostile");
          if (decorateInsertedListItems === "namespaced") {
            target?.removeAttribute("_moz_dirty");
            target?.setAttributeNS("urn:thunderclaw:foreign", "_moz_dirty", "");
          }
        }
        if (pruneSelectedBoundaryText) {
          for (const node of allLiveNodes()) {
            if (node.nodeType === Node.TEXT_NODE && node.data.length === 0
              && !beforeLiveRecords.some(({ node: original }) => original === node)) node.remove();
          }
          if (selectedStartNode.nodeType === Node.TEXT_NODE && selectedStartOffset === 0
            && selectedStartNode.data.length === 0 && selectedStartNode.parentNode) selectedStartNode.remove();
          if (selectedEndNode !== selectedStartNode && selectedEndNode.nodeType === Node.TEXT_NODE
            && selectedEndOffset === selectedEndLength && selectedEndNode.data.length === 0 && selectedEndNode.parentNode) selectedEndNode.remove();
          if (selectedEndNode === selectedStartNode && selectedStartOffset === 0 && selectedEndOffset === selectedStartLength
            && selectedStartNode.data.length === 0 && selectedStartNode.parentNode) selectedStartNode.remove();
        }
        if (removeOriginalEmptySibling) {
          removedOriginalEmptyRecord = beforeLiveRecords.find(({ node }) => node.nodeType === Node.TEXT_NODE && node.data.length === 0
            && node !== selectedStartNode && node !== selectedEndNode);
          removedOriginalEmptyRecord?.node.remove();
        }
        if (decorateInsertedBreak) {
          const insertedBreak = Array.from(document.querySelectorAll("br")).find((candidate) => !beforeLiveRecords.some(({ node }) => node === candidate));
          insertedBreak?.setAttribute("_moz_dirty", decorateInsertedBreak === true ? "" : decorateInsertedBreak);
        }
        if (decorateInsertedFixture) {
          const inserted = Array.from(document.querySelectorAll("b,i,u,br"))
            .filter((candidate) => !beforeLiveRecords.some(({ node }) => node === candidate));
          for (const candidate of inserted) candidate.setAttribute("_moz_dirty", "");
          if (decorateInsertedFixture === "wrong-value-b") inserted.find(({ tagName }) => tagName === "B")?.setAttribute("_moz_dirty", "changed");
          if (decorateInsertedFixture === "additional-i") inserted.find(({ tagName }) => tagName === "I")?.setAttribute("data-extra", "hostile");
          if (decorateInsertedFixture === "wrong-value-u") inserted.find(({ tagName }) => tagName === "U")?.setAttribute("_moz_dirty", "changed");
          if (decorateInsertedFixture === "additional-u") inserted.find(({ tagName }) => tagName === "U")?.setAttribute("class", "hostile");
          if (decorateInsertedFixture === "namespaced-br") {
            const target = inserted.find(({ tagName }) => tagName === "BR");
            target?.removeAttribute("_moz_dirty");
            target?.setAttributeNS("urn:thunderclaw:foreign", "_moz_dirty", "");
          }
          if (decorateInsertedFixture === "namespaced-u") {
            const target = inserted.find(({ tagName }) => tagName === "U");
            target?.removeAttribute("_moz_dirty");
            target?.setAttributeNS("urn:thunderclaw:foreign", "_moz_dirty", "");
          }
          if (decorateInsertedFixture === "foreign-u") {
            const target = inserted.find(({ tagName }) => tagName === "U");
            const replacement = document.createElementNS("urn:thunderclaw:foreign", "u");
            replacement.setAttribute("_moz_dirty", "");
            replacement.append(...Array.from(target.childNodes));
            target.replaceWith(replacement);
          }
          if (decorateInsertedFixture === "wrong-tag-u") {
            const target = inserted.find(({ tagName }) => tagName === "U");
            const replacement = document.createElement("span");
            replacement.setAttribute("_moz_dirty", "");
            replacement.append(...Array.from(target.childNodes));
            target.replaceWith(replacement);
          }
          if (decorateInsertedFixture === "foreign-strong") {
            const target = inserted.find(({ tagName }) => tagName === "B");
            const replacement = document.createElement("strong");
            replacement.setAttribute("_moz_dirty", "");
            replacement.append(...Array.from(target.childNodes));
            target.replaceWith(replacement);
          }
        }
        if (foreignInsertedBold) {
          const target = Array.from(document.querySelectorAll("b"))
            .find((candidate) => !beforeLiveRecords.some(({ node }) => node === candidate));
          const replacement = document.createElementNS("urn:thunderclaw:foreign", "b");
          replacement.append(...Array.from(target.childNodes));
          target.replaceWith(replacement);
        }
        if (wrapInsertedFixture) {
          const insertedToken = Array.from(document.querySelectorAll("b"))
            .find((candidate) => candidate.textContent.startsWith("TC_R0_BOLD_"));
          const container = insertedToken?.parentElement;
          if (container?.tagName === "LI") {
            const wrapper = document.createElement("span");
            wrapper.append(...Array.from(container.childNodes));
            container.append(wrapper);
          }
        }
        if (mergeInsertedLineSuffix) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let line;
          while ((line = walker.nextNode()) && !line.data.startsWith("TC_R0_LINE_")) {}
          if (line?.nextSibling?.nodeType === Node.TEXT_NODE) {
            line.data += line.nextSibling.data;
            line.nextSibling.remove();
          }
        }
        if (normalizePrefix) textNode(document.body.firstElementChild).data = "NORMALIZED ";
        const mozDirtyTarget = mozDirtySelector ? document.querySelector(mozDirtySelector) : document.body.firstElementChild;
        if (mozDirtyMutation === "remove") mozDirtyTarget.removeAttribute("_moz_dirty");
        if (mozDirtyMutation === "change") mozDirtyTarget.setAttribute("_moz_dirty", "changed");
        if (hiddenTargetMutation) document.querySelector("[data-gecko-hidden]")?.setAttribute("data-gecko-hidden", "changed");
        if (replaceOpaque) {
          const opaque = document.querySelector("[data-private]");
          opaque.replaceWith(opaque.cloneNode(true));
        }
        if (relocateOpaque) {
          const opaque = document.querySelector("[data-private]");
          opaque.parentNode.insertBefore(opaque, opaque.parentNode.firstChild);
        }
        counts.legacyAfter = geckoLegacySerialization();
        counts.legacyHiddenAfter = geckoLegacyHiddenAttributeView(geckoHiddenNodes);
        if (verificationException) document.body.append(document.createProcessingInstruction("r0", "verification"));
        after = document.body.innerHTML;
        afterNodes = Array.from(document.body.childNodes, (node) => node.cloneNode(true));
        afterSelection = selectionBoundary();
        retainedRecords = beforeLiveRecords
          .filter(({ node }) => node.isConnected && document.body.contains(node))
          .map((record) => ({ ...record, afterPath: pathOf(record.node), afterSnapshot: record.node.cloneNode(true) }));
        if (throwAfterMutation) throw new Error("synthetic insert failure after mutation");
        return true;
      }
      if (command === "undo") {
        counts.undo += 1;
        if (undoThrows) throw new Error("synthetic undo failure");
        if (undoRequiresPostCommandSelection
          && JSON.stringify(selectionBoundary()) !== JSON.stringify(afterSelection)) return false;
        if (undoRestores) {
          document.body.replaceChildren(...beforeNodes.map((node) => node.cloneNode(true)));
          restoreRetainedRecords("before");
          if (restoreOriginalTargetIdentities) {
            for (const record of [...(preTargetRecords ?? [])].sort((a, b) => a.beforePath.length - b.beforePath.length)) {
              const clone = resolve(record.beforePath);
              restoreRetained(record.node, record.beforeSnapshot);
              if (clone !== record.node) clone.replaceWith(record.node);
            }
          }
          if (removedOriginalEmptyRecord) {
            const clone = resolve(removedOriginalEmptyRecord.beforePath);
            restoreRetained(removedOriginalEmptyRecord.node, removedOriginalEmptyRecord.beforeSnapshot);
            if (clone !== removedOriginalEmptyRecord.node) clone.replaceWith(removedOriginalEmptyRecord.node);
          }
          if (originalOpaque) document.querySelector("[data-private]")?.replaceWith(originalOpaque);
          restorePreservedOpaque();
          restoreSelection(beforeSelection);
          if (rollbackVerificationException) document.body.append(document.createProcessingInstruction("r0", "rollback"));
        }
        return true;
      }
      if (command === "redo") {
        counts.redo += 1;
        document.body.replaceChildren(...afterNodes.map((node) => node.cloneNode(true)));
        restoreRetainedRecords("after");
        restorePreservedOpaque();
        restoreSelection(afterSelection);
        return true;
      }
      return false;
    };
    return counts;
  };
  const captureFirst = async (html = "<p>prefix TARGET suffix</p>") => {
    reset(html);
    const target = document.body.firstElementChild;
    const node = textNode(target);
    const start = node.data.indexOf("TARGET");
    selectText(target, start, start + 6);
    const response = await request("capture");
    if (!response.ok) throw new Error("captureFirst failed: " + JSON.stringify(response));
    return response;
  };

  const hostile = [
    '<blockquote type="cite">selected</blockquote>',
    '<blockquote cite="mid:test">selected</blockquote>',
    '<div class="moz-cite-prefix">selected</div>',
    '<div class="moz-signature">selected</div>',
    '<div class="moz-forward-container">selected</div>',
    '<span _moz_quote="true">selected</span>',
    '<span contenteditable="false">selected</span>',
    '<a href="https://example.invalid">selected</a>',
    '<span style="color:red">selected</span>',
    '<div _moz_dirty="">selected</div>',
    '<p _moz_dirty="true">selected</p>',
    '<p _moz_dirty="" data-extra="hostile">selected</p>',
    '<ul _moz_dirty="true"><li _moz_dirty="">selected</li></ul>',
    '<ol _moz_dirty=""><li _moz_dirty="" data-extra="hostile">selected</li></ol>',
    '<strong _moz_dirty="">selected</strong>',
    '<p><b _moz_dirty="">selected</b></p>',
    '<p><i _moz_dirty="">selected</i></p>',
    '<p><u _moz_dirty="changed">selected</u></p>',
    '<p><u _moz_dirty="" class="hostile">selected</u></p>',
    '<p><u style="text-decoration:underline">selected</u></p>',
    '<p><u data-private="hostile">selected</u></p>',
    '<p><strong data-private="hostile">selected</strong></p>',
    '<table><tbody><tr><td>selected</td></tr></tbody></table>',
    '<code>selected</code>',
    '<ul><li><p>paragraph in item</p></li></ul>',
    '<div><p>first nested block</p><p>second nested block</p></div>',
    '<strong>top-level strong</strong>',
    '<li>top-level list item</li>',
  ];
  results.hostile = [];
  for (const html of hostile) {
    reset(html);
    selectText(document.body.firstElementChild);
    const response = await request("capture");
    results.hostile.push({ html, eligible: response.value.classification.eligible, reasons: response.value.classification.reasons });
  }
  const xhtmlNamespace = "http://www.w3.org/1999/xhtml";
  const foreignNamespace = "urn:thunderclaw:foreign";
  const oldHostPredicateWouldAccept = (element) => ["P", "UL", "OL", "LI", "BR", "U"].includes(element.tagName)
    && element.attributes.length === 1
    && element.hasAttribute("_moz_dirty")
    && element.getAttribute("_moz_dirty") === "";
  const installNamespaceCase = (tagName, foreignElement, namespacedAttribute) => {
    reset("");
    const namespace = foreignElement ? foreignNamespace : xhtmlNamespace;
    const element = document.createElementNS(namespace, tagName.toUpperCase());
    if (namespacedAttribute) element.setAttributeNS(foreignNamespace, "_moz_dirty", "");
    else element.setAttribute("_moz_dirty", "");
    let selectedRoot = element;
    if (["ul", "ol"].includes(tagName.toLowerCase())) {
      const item = document.createElement("li");
      item.setAttribute("_moz_dirty", "");
      item.textContent = "selected";
      element.append(item);
    } else if (tagName.toLowerCase() === "li") {
      const list = document.createElement("ul");
      list.setAttribute("_moz_dirty", "");
      element.textContent = "selected";
      list.append(element);
      selectedRoot = element;
      document.body.append(list);
    } else if (tagName.toLowerCase() === "br") {
      const paragraph = document.createElement("p");
      paragraph.setAttribute("_moz_dirty", "");
      paragraph.append(document.createTextNode("before"), element, document.createTextNode("after"));
      document.body.append(paragraph);
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return element;
    } else if (tagName.toLowerCase() === "u") {
      const paragraph = document.createElement("p");
      paragraph.setAttribute("_moz_dirty", "");
      element.textContent = "selected";
      paragraph.append(element);
      document.body.append(paragraph);
    } else {
      element.textContent = "selected";
    }
    if (!document.body.contains(element)) document.body.append(element);
    selectText(selectedRoot);
    return element;
  };
  results.foreignNamespace = [];
  results.namespacedMozDirty = [];
  for (const tagName of ["p", "ul", "ol", "li", "br", "u"]) {
    const foreignElement = installNamespaceCase(tagName, true, false);
    results.foreignNamespace.push({ tagName, oldPredicateAccepted: oldHostPredicateWouldAccept(foreignElement),
      classification: (await request("capture")).value.classification });
    const namespacedAttributeElement = installNamespaceCase(tagName, false, true);
    const attribute = namespacedAttributeElement.attributes.item(0);
    results.namespacedMozDirty.push({ tagName,
      oldPredicateAccepted: oldHostPredicateWouldAccept(namespacedAttributeElement),
      tuple: [attribute.namespaceURI, attribute.prefix, attribute.localName, attribute.name, attribute.value],
      classification: (await request("capture")).value.classification });
  }
  reset('<p>before <strong data-private="hostile">selected</strong> after</p>');
  {
    const paragraph = document.body.firstElementChild;
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.lastChild, paragraph.lastChild.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.intersectedAttributedHostile = (await request("capture")).value.classification;
  }
  reset('<ul><li>outer<ul><li>nested</li></ul></li></ul>');
  selectBodyBlocks(0, 1);
  results.selectedNestedList = (await request("capture")).value.classification;
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">four</li><li _moz_dirty="">seventh</li><li _moz_dirty="">tri</li></ul>');
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const last = textNode(document.body.firstElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "blocks",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.promotedFullList = { captured, applied, counts };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">four</li><li _moz_dirty="">seventh</li><li _moz_dirty="">tri</li></ul>');
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const last = textNode(document.body.firstElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const ping = await automation("ping");
    const rejected = await automation("capture", {}, "not-the-r0-build");
    const captured = await automation("capture");
    const counts = editor();
    const applied = await automation("apply", { captureId: captured.value.captureId, preset: "blocks", induceFailure: false,
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.automationBridge = { ping, rejected, captured, applied, counts,
      documentElementAttributes: Array.from(document.documentElement.attributes, ({ name }) => name) };
  }
  {
    reset('<ol _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ol>');
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const last = textNode(document.body.firstElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.promotedObservedOrderedList = await request("capture");
  }
  const selectBodyWrapper = (start, backward = false) => {
    const selection = getSelection();
    selection.removeAllRanges();
    if (backward) selection.setBaseAndExtent(document.body, start + 1, document.body, start);
    else {
      const range = document.createRange();
      range.setStart(document.body, start);
      range.setEnd(document.body, start + 1);
      selection.addRange(range);
    }
  };
  results.bodyWrapperLists = [];
  for (const [withCanaries, backward, preset] of [[false, false, "same-kind-list-rewrite"],
    [false, true, "same-kind-list-add"], [true, false, "same-kind-list-remove"],
    [true, true, "same-kind-list-reorder"]]) {
    reset((withCanaries ? '<!--before-->' : '')
      + '<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>'
      + (withCanaries ? '<!--after-->' : ''));
    const list = document.querySelector("ul");
    const canaries = Array.from(document.body.childNodes).filter((node) => node.nodeType === Node.COMMENT_NODE);
    const start = Array.prototype.indexOf.call(document.body.childNodes, list);
    selectBodyWrapper(start, backward);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("BODY wrapper capture failed: " + JSON.stringify(captured));
    const stateAfterCapture = await request("state");
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "exact", preserveOpaque: true });
    const applied = await request("apply", { captureId: captured.value.captureId, preset,
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    const stateAfterApply = await request("state");
    results.bodyWrapperLists.push({ withCanaries, backward, preset, start, captured, stateAfterCapture,
      applied, stateAfterApply, counts, wrapperSame: list.isConnected && document.querySelector("ul") === list,
      canariesSame: canaries.every((node) => node.isConnected) });
  }
  results.bodyWrapperNegatives = [];
  for (const [name, html, start, end] of [
    ["off-by-one", '<!--before--><ul><li>one</li><li>two</li></ul>', 0, 2],
    ["multiple-lists", '<ul><li>one</li><li>two</li></ul><ol><li>three</li><li>four</li></ol>', 0, 2],
    ["non-list", '<p>one</p>', 0, 1],
    ["nested-list", '<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>', 0, 1],
    ["attributes", '<ul data-extra="hostile"><li>one</li><li>two</li></ul>', 0, 1],
    ["protected", '<ul contenteditable="false"><li>one</li><li>two</li></ul>', 0, 1],
  ]) {
    reset(html);
    const range = document.createRange();
    range.setStart(document.body, start);
    range.setEnd(document.body, end);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    results.bodyWrapperNegatives.push({ name, captured });
  }
  results.sameKindLists = [];
  for (const kind of ["ul", "ol"]) {
    for (const [preset, expectedCount] of [["same-kind-list-rewrite", 3], ["same-kind-list-add", 4],
      ["same-kind-list-remove", 2], ["same-kind-list-reorder", 3]]) {
      reset('<!--r0-adjacent-before--><' + kind + ' _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></' + kind + '><!--r0-adjacent-after-->');
      const wrapper = document.querySelector(kind);
      const canaries = Array.from(document.body.childNodes).filter((node) => node.nodeType === Node.COMMENT_NODE);
      selectWholeListText(wrapper);
      const captured = await request("capture");
      const stateAfterCapture = await request("state");
      const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "exact", preserveOpaque: true });
      const applied = await request("apply", { captureId: captured.value.captureId, preset,
        editorMode: { isPlainText: false, deliveryFormat: "auto" } });
      const stateAfterApply = await request("state");
      if (!applied.value?.trialId) throw new Error("same-kind " + kind + "/" + preset + " failed: " + JSON.stringify(applied));
      const applyState = {
        wrapperSame: wrapper.isConnected && document.querySelector(kind) === wrapper,
        canariesSame: canaries.every((node) => node.isConnected),
        count: wrapper.children.length,
        itemAttributes: Array.from(wrapper.children, (item) =>
          Array.from(item.attributes, ({ namespaceURI, prefix, localName, name, value }) =>
            [namespaceURI, prefix, localName, name, value])),
      };
      const undone = await request("undo", { trialId: applied.value.trialId });
      const redone = await request("redo", { trialId: applied.value.trialId });
      results.sameKindLists.push({ kind, preset, expectedCount, captured, stateAfterCapture,
        applied, stateAfterApply, applyState, undone, redone, counts });
    }
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListTextBackward();
    const beforeDirection = {
      anchorPath: [0, 2, 0], anchorOffset: 5,
      focusPath: [0, 0, 0], focusOffset: 0,
    };
    const captured = await request("capture");
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "exact" });
    const applied = await request("apply", { captureId: captured.value.captureId, preset: "same-kind-list-rewrite",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    results.sameKindListBackward = { captured, applied, undone, redone, counts, beforeDirection };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListText();
    delayRuntimeCapability = true;
    const capturePromise = request("capture");
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.body.querySelector("li:nth-child(2)").firstChild.data = "changed-during-capability";
    selectText(document.body.querySelector("li:nth-child(2)"));
    delayRuntimeCapability = false;
    delayedCapabilityResolver();
    const captured = await capturePromise;
    results.delayedCapabilityCapture = { captured, selectedText: getSelection().toString() };
  }
  results.sameKindListBadAttributes = [];
  for (const variant of ["wrong-value", "additional", "namespaced"]) {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListText();
    const captured = await request("capture");
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: variant });
    const response = await request("apply", { captureId: captured.value.captureId, preset: "same-kind-list-rewrite",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.sameKindListBadAttributes.push({ variant, captured, response, counts });
  }
  {
    runtimeCapability = { ...runtimeCapability, sameKindListEligible: false };
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListText();
    const captured = await request("capture");
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "exact" });
    const response = await request("apply", { captureId: captured.value.captureId, preset: "same-kind-list-rewrite",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.sameKindListOldRuntime = { captured, response, counts };
    runtimeCapability = { ...runtimeCapability, sameKindListEligible: true };
  }
  results.sameKindListMalformedCapabilities = [];
  for (const [name, malformed] of [
    ["missing", undefined],
    ["wrong-build", { ...runtimeCapability, buildId: "wrong" }],
    ["bad-instance", { ...runtimeCapability, instance: "not-a-token" }],
    ["wrong-minimum", { ...runtimeCapability, minimumThunderbirdMajor: 152 }],
    ["non-boolean", { ...runtimeCapability, sameKindListEligible: "true" }],
    ["additional-field", { ...runtimeCapability, hostile: true }],
  ]) {
    runtimeCapability = malformed;
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListText();
    const captured = await request("capture", { runtimeCapability: { sameKindListEligible: true } });
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "exact" });
    const response = await request("apply", { captureId: captured.value.captureId, preset: "same-kind-list-rewrite",
      runtimeCapability: { sameKindListEligible: true },
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.sameKindListMalformedCapabilities.push({ name, captured, response, counts });
  }
  runtimeCapability = {
    buildId: "thunderclaw-rich-compose-r0@example.invalid:0.0.1",
    instance: "0123456789abcdef0123456789abcdef",
    minimumThunderbirdMajor: 153,
    sameKindListEligible: true,
  };
  {
    reset('<ul _moz_dirty=""><li _moz_dirty=""><u _moz_dirty="">one</u></li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListText();
    const captured = await request("capture");
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "exact" });
    runtimeCapability = { ...runtimeCapability, instance: "fedcba9876543210fedcba9876543210" };
    const response = await request("apply", { captureId: captured.value.captureId, preset: "same-kind-list-rewrite",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.sameKindListStaleCapability = { captured, response, counts };
    runtimeCapability = { ...runtimeCapability, instance: "0123456789abcdef0123456789abcdef" };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListText();
    const captured = await request("capture");
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "exact" });
    const response = await request("apply", { captureId: captured.value.captureId, preset: "blocks",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.wholeListLegacyBlocksRejected = { captured, response, counts };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">four</li><li _moz_dirty="">seventh</li><li _moz_dirty="">tri</li></ul>');
    const item = document.body.firstElementChild.children[1];
    selectText(item);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("liveWholeTextPrunedBoundaries Capture failed: " + JSON.stringify(captured));
    const counts = editor({ mutate: false });
    const forged = await request("apply", {
      captureId: captured.value.captureId,
      preset: "blocks",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const liveCounts = editor();
    const before = document.body.cloneNode(true);
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const afterApply = document.body.cloneNode(true);
    const undone = await request("undo", { trialId: applied.value.trialId });
    const afterUndo = document.body.cloneNode(true);
    const redone = await request("redo", { trialId: applied.value.trialId });
    const afterRedo = document.body.cloneNode(true);
    results.singleListItem = { captured, forged, counts, applied, undone, redone, liveCounts,
      states: [before, afterApply, afterUndo, afterRedo].map((body) => Array.from(body.querySelectorAll("ul,li"), (node) => [node.localName, Array.from(node.attributes, ({ name, value }) => [name, value])])) };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">four</li><li _moz_dirty="">tri</li></ul>');
    const item = document.body.firstElementChild.children[1];
    const range = document.createRange();
    range.setStart(item, 0);
    range.setEnd(item, 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("partialTextPrunedBoundaries Capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedBreak: true });
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const insertedBreak = Array.from(document.querySelectorAll("br")).find((node) => node.hasAttribute("_moz_dirty"));
    const insertedBreakTuple = insertedBreak
      ? Array.from(insertedBreak.attributes, ({ namespaceURI, prefix, localName, name, value }) => [namespaceURI, prefix, localName, name, value])
      : undefined;
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    results.liveElementBoundaryDecoratedBreak = { captured, applied, undone, redone, counts, insertedBreakTuple };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">four</li><li _moz_dirty="">tri</li></ul>');
    const item = document.body.firstElementChild.children[1];
    const range = document.createRange();
    range.setStart(item, 0);
    range.setEnd(item, 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("genuineEmptySiblings Capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedBreak: "changed" });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.liveElementBoundaryWrongBreakDecoration = { response, counts };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">four</li><li _moz_dirty="">tri</li></ul>');
    const item = document.body.firstElementChild.children[1];
    const range = document.createRange();
    range.setStart(item, 0);
    range.setEnd(item, 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("genuineEmptySiblingDrift Capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedFixture: "exact-all" });
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const decorated = Array.from(document.querySelectorAll("b,i,u,br"), (node) => ({
      name: node.localName,
      attributes: Array.from(node.attributes, ({ namespaceURI, prefix, localName, name, value }) => [namespaceURI, prefix, localName, name, value]),
    }));
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    results.liveAllGeneratedDecorations = { captured, applied, undone, redone, counts, decorated };
  }
  results.wrongGeneratedDecorations = [];
  for (const variant of ["wrong-value-b", "additional-i", "namespaced-br", "foreign-strong",
    "wrong-value-u", "additional-u", "namespaced-u", "foreign-u", "wrong-tag-u"]) {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">four</li><li _moz_dirty="">tri</li></ul>');
    const item = document.body.firstElementChild.children[1];
    const range = document.createRange();
    range.setStart(item, 0);
    range.setEnd(item, 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("prunedBoundaryNeighbors Capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedFixture: variant });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.wrongGeneratedDecorations.push({ variant, response, counts });
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">elevenchars</li><li _moz_dirty="">tri</li></ul>');
    const item = document.body.firstElementChild.children[1];
    selectText(item);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("pruned whole-text live capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedFixture: "exact-all", pruneSelectedBoundaryText: true });
    const applied = await request("apply", { captureId: captured.value.captureId, preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    results.liveWholeTextPrunedBoundaries = { captured, applied, undone, redone, counts };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">prefix TARGET suffix</li></ul>');
    const item = document.body.firstElementChild.firstElementChild;
    const node = item.firstChild;
    const start = node.data.indexOf("TARGET");
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 6);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("pruned partial-text live capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedFixture: "exact-all", pruneSelectedBoundaryText: true });
    const applied = await request("apply", { captureId: captured.value.captureId, preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.partialTextPrunedBoundaries = { captured, applied, counts,
      text: document.body.firstElementChild.firstElementChild.textContent };
  }
  const installGenuineEmptySiblings = () => {
    reset("");
    const list = document.createElement("ul");
    list.setAttribute("_moz_dirty", "");
    const item = document.createElement("li");
    item.setAttribute("_moz_dirty", "");
    const before = document.createTextNode("");
    const target = document.createTextNode("elevenchars");
    const after = document.createTextNode("");
    item.append(before, target, after);
    list.append(item);
    document.body.append(list);
    const range = document.createRange();
    range.setStart(target, 0);
    range.setEnd(target, target.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return { item, before, target, after };
  };
  {
    const fixture = installGenuineEmptySiblings();
    const captured = await request("capture");
    if (!captured.ok) throw new Error("genuine empty siblings capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedFixture: "exact-all", pruneSelectedBoundaryText: true });
    const applied = await request("apply", { captureId: captured.value.captureId, preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    const preservedAfterApply = fixture.item.firstChild === fixture.before && fixture.item.lastChild === fixture.after;
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    results.genuineEmptySiblings = { captured, applied, undone, redone, counts, preservedAfterApply };
  }
  {
    installGenuineEmptySiblings();
    const captured = await request("capture");
    if (!captured.ok) throw new Error("genuine empty sibling drift capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedFixture: "exact-all", pruneSelectedBoundaryText: true, removeOriginalEmptySibling: true });
    const response = await request("apply", { captureId: captured.value.captureId, preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.genuineEmptySiblingDrift = { response, counts };
  }
  {
    const fixture = installGenuineEmptySiblings();
    const captured = await request("capture");
    const counts = editor({ decorateInsertedFixture: "exact-all", pruneSelectedBoundaryText: true });
    const applied = await request("apply", { captureId: captured.value.captureId, preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    document.execCommand("undo");
    fixture.before.replaceWith(fixture.before.cloneNode(true));
    const verified = await request("verify", { trialId: applied.value.trialId, expected: "pre" });
    results.manualUndoEmptyIdentityDrift = { verified, counts };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">elevenchars<!--r0-adjacent--><br _moz_dirty=""><a data-r0-opaque="neighbor" href="#">opaque</a></li></ul>');
    const item = document.body.firstElementChild.firstElementChild;
    const comment = item.childNodes[1];
    const markedBreak = item.querySelector("br");
    const opaque = item.querySelector("a");
    const range = document.createRange();
    range.setStart(item.firstChild, 0);
    range.setEnd(item.firstChild, item.firstChild.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("pruned neighbors capture failed: " + JSON.stringify(captured));
    const counts = editor({ decorateInsertedFixture: "exact-all", pruneSelectedBoundaryText: true, preserveOpaque: true });
    const applied = await request("apply", { captureId: captured.value.captureId, preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" } });
    results.prunedBoundaryNeighbors = { captured, applied, counts,
      identities: [comment.isConnected && item.contains(comment), markedBreak.isConnected && item.contains(markedBreak), opaque.isConnected && item.contains(opaque)] };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">elevenchars</li><li _moz_dirty="">tri</li></ul>');
    const item = document.body.firstElementChild.children[1];
    const range = document.createRange();
    range.setStart(item, 0);
    range.setEnd(item, 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const captured = await request("capture");
    const counts = editor({ decorateInsertedFixture: "exact-all", wrapInsertedFixture: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.geckoLikeInsertedWrapperMismatch = { captured, response, counts };
  }
  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">four</li><li _moz_dirty="">seventh</li><li _moz_dirty="">tri</li></ul>');
    selectText(document.body.firstElementChild.children[1]);
    const captured = await request("capture");
    const counts = editor({ mozDirtyMutation: "change", mozDirtySelector: "ul" });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.listAttributeDrift = { response, counts };
  }
  {
    reset('<p _moz_dirty="">prefix TARGET suffix<br _moz_dirty=""></p>');
    const paragraph = document.body.firstElementChild;
    const node = textNode(paragraph);
    const start = node.data.indexOf("TARGET");
    selectText(paragraph, start, start + 6);
    const captured = await request("capture");
    const counts = editor();
    const snapshots = [document.body.cloneNode(true)];
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    snapshots.push(document.body.cloneNode(true));
    const undone = await request("undo", { trialId: applied.value.trialId });
    snapshots.push(document.body.cloneNode(true));
    const redone = await request("redo", { trialId: applied.value.trialId });
    snapshots.push(document.body.cloneNode(true));
    results.breakAttributes = { captured, applied, undone, redone, counts,
      states: snapshots.map((body) => Array.from(body.querySelectorAll("p,br"), (element) => [element.localName, Array.from(element.attributes, ({ name, value }) => [name, value])])) };
  }
  {
    reset('<p _moz_dirty="">prefix TARGET suffix<br _moz_dirty=""></p>');
    const paragraph = document.body.firstElementChild;
    const node = textNode(paragraph);
    const start = node.data.indexOf("TARGET");
    selectText(paragraph, start, start + 6);
    const captured = await request("capture");
    const counts = editor({ mozDirtyMutation: "remove", mozDirtySelector: "br[_moz_dirty]" });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.breakAttributeDrift = { response, counts };
  }
  {
    reset('<ul><li>first</li><li>last</li></ul>');
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const last = textNode(document.body.firstElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.offByOneList = (await request("capture")).value.classification;
  }
  {
    reset('<ul><li><br>first</li><li>last</li></ul>');
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const last = textNode(document.body.firstElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.leadingBreakList = (await request("capture")).value.classification;
  }
  {
    reset('<ul><li><!--private-->first</li><li>last</li></ul>');
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const last = textNode(document.body.firstElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.commentedList = (await request("capture")).value.classification;
  }
  {
    reset('<ul><li>first</li><li>second</li></ul><ol><li>third</li><li>last</li></ol>');
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const last = textNode(document.body.lastElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.multipleLists = (await request("capture")).value.classification;
  }
  reset('<p>before</p>');
  {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.append("list in paragraph");
    list.append(item);
    document.body.firstElementChild.append(list);
    const range = document.createRange();
    range.selectNodeContents(document.body.firstElementChild);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.listInParagraph = (await request("capture")).value.classification;
  }
  reset('<br><p>following</p>');
  selectBodyBlocks(0, 1);
  results.topLevelBreak = (await request("capture")).value.classification;
  reset('<div><p>first nested block</p><p>second nested block</p></div>');
  {
    const first = textNode(document.body.firstElementChild.firstElementChild);
    const second = textNode(document.body.firstElementChild.lastElementChild);
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(second, second.data.length - 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.inlineAcrossNestedBlocks = (await request("capture")).value.classification;
  }

  reset('<p>A<!--private-marker-->B</p>');
  {
    const range = document.createRange();
    range.setStart(document.body.firstElementChild, 0);
    range.setEnd(document.body.firstElementChild, 3);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.selectedComment = (await request("capture")).value.classification;
  }
  {
    const comment = document.body.firstElementChild.childNodes[1];
    const range = document.createRange();
    range.setStart(comment, 0);
    range.setEnd(comment, comment.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.commentBoundary = (await request("capture")).value.classification;
  }

  reset('<p>one</p><p>two</p><p>three</p>');
  selectBodyBlocks(0, 2);
  results.blockPlacement = (await request("capture")).value.classification;
  selectBodyBlocks(0, 2, true);
  results.followingOffsetZeroPlacement = (await request("capture")).value.classification;
  reset('<p>one</p><p>two</p><p>three</p>');
  selectBodyBlocks(0, 2);
  {
    const captured = await request("capture");
    const counts = editor();
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "blocks",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.blockApply = { response, counts };
  }
  reset('<p>one</p><p>two</p><p>three</p>');
  selectBodyBlocks(0, 2, true);
  {
    const captured = await request("capture");
    const counts = editor();
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "blocks",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.followingOffsetZeroApply = { response, counts };
  }
  reset('<p>one</p><p>two</p><p>three</p>');
  {
    const first = textNode(document.body.childNodes[0]);
    const second = textNode(document.body.childNodes[1]);
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(second, 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    results.partialCrossBlock = (await request("capture")).value.classification;
  }

  reset('<p>selected</p><blockquote type="cite">opaque</blockquote>');
  selectText(document.body.firstElementChild);
  results.adjacentProtected = (await request("capture")).value.classification;
  reset('<p>one</p><p>two</p><blockquote type="cite">opaque</blockquote>');
  selectBodyBlocks(0, 2, true);
  results.followingProtectedOffsetZero = (await request("capture")).value.classification;

  const blockedModes = [
    { isPlainText: true, deliveryFormat: "auto" },
    { isPlainText: false, deliveryFormat: "plaintext" },
    { isPlainText: false, deliveryFormat: "missing" },
    { isPlainText: false, deliveryFormat: "unknown" },
  ];
  results.blockedModes = [];
  for (const editorMode of blockedModes) {
    const captured = await captureFirst();
    const counts = editor({ mutate: false });
    const response = await request("apply", { captureId: captured.value.captureId, preset: "inline", editorMode });
    results.blockedModes.push({ editorMode, response, counts });
  }

  {
    const captured = await captureFirst();
    const counts = editor({ mutate: false });
    document.body.firstElementChild.append(" drift");
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.bodyDrift = { response, counts };
  }

  {
    const captured = await captureFirst();
    const paragraph = document.body.firstElementChild;
    selectText(paragraph, 0, 6);
    const counts = editor({ mutate: false });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.selectionDrift = { response, counts };
  }

  {
    const captured = await captureFirst();
    const counts = editor({ foreignInsertedBold: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.foreignInsertedFixture = { response, counts };
  }

  {
    const captured = await captureFirst('<p _moz_dirty="">prefix TARGET suffix</p>');
    const counts = editor({ mutate: false });
    document.body.firstElementChild.setAttribute("_moz_dirty", "changed");
    document.body.firstElementChild.setAttribute("_moz_dirty", "");
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.preApplyRevision = { response, counts };
  }

  {
    const captured = await captureFirst();
    const counts = editor({ mutate: false });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.noMutationFailure = { response, counts };
  }

  {
    const captured = await captureFirst();
    const counts = editor({ transientNoNet: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.transientNoNet = { response, counts };
  }

  {
    const captured = await captureFirst();
    const counts = editor({ mutate: false });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "blocks",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.presetMismatch = { response, counts };
  }

  {
    const captured = await captureFirst();
    const counts = editor({ normalizePrefix: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.unexpectedAdjacentNormalization = { response, counts, body: document.body.innerHTML };
  }

  {
    const captured = await captureFirst("<p>TARGET</p>");
    const counts = editor({ undoRequiresPostCommandSelection: true });
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "both" },
    });
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    document.body.append("unrelated change");
    const undoAfterDrift = await request("undo", { trialId: applied.value.trialId });
    results.undoRedo = { applied, undone, redone, undoAfterDrift, counts };
  }

  {
    const captured = await captureFirst("<p>TARGET suffix</p>");
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    document.execCommand("undo");
    selectText(document.body.firstElementChild, 7, 13);
    const verified = await request("verify", { trialId: applied.value.trialId, expected: "pre" });
    results.manualUndoSelectionDrift = { captured, applied, verified, counts };
  }

  {
    const captured = await captureFirst("<p>TARGET</p>");
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const identical = document.body.innerHTML;
    document.body.firstElementChild.append("temporary edit");
    document.body.innerHTML = identical;
    const refused = await request("undo", { trialId: applied.value.trialId });
    results.editRevertIdentical = { applied, refused, counts };
  }

  {
    const captured = await captureFirst("<p>TARGET</p>");
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    document.body.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" }));
    const refused = await request("undo", { trialId: applied.value.trialId });
    results.inputRevision = { applied, refused, counts };
  }

  {
    const captured = await captureFirst('<p _moz_dirty="">TARGET</p>');
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    document.body.firstElementChild.setAttribute("_moz_dirty", "changed");
    document.body.firstElementChild.setAttribute("_moz_dirty", "");
    const refused = await request("undo", { trialId: applied.value.trialId });
    results.hiddenDriftBeforeUndo = { applied, refused, counts };
  }
  {
    const captured = await captureFirst('<p _moz_dirty="">TARGET</p>');
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const undone = await request("undo", { trialId: applied.value.trialId });
    document.body.firstElementChild.setAttribute("_moz_dirty", "changed");
    document.body.firstElementChild.setAttribute("_moz_dirty", "");
    const refused = await request("redo", { trialId: applied.value.trialId });
    results.hiddenDriftBeforeRedo = { applied, undone, refused, counts };
  }

  {
    const marker = "TC_R0_EXACT_TARGET_SLOT";
    reset("<p>" + marker + " SELECTME " + marker + "</p>");
    const paragraph = document.body.firstElementChild;
    const node = textNode(paragraph);
    const start = node.data.indexOf("SELECTME");
    selectText(paragraph, start, start + 8);
    const captured = await request("capture");
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.typedSlotCollision = { applied, counts, text: document.body.textContent };
  }

  {
    reset('<p _moz_dirty="">prefix TARGET suffix</p>');
    const paragraph = document.body.firstElementChild;
    const node = textNode(paragraph);
    const start = node.data.indexOf("TARGET");
    selectText(paragraph, start, start + 6);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("moz-dirty inline Capture failed: " + JSON.stringify(captured));
    selectBodyBlocks(0, 1);
    const blockCapture = await request("capture");
    selectText(paragraph, start, start + 6);
    const before = {
      present: paragraph.hasAttribute("_moz_dirty"),
      value: paragraph.getAttribute("_moz_dirty"),
      attributes: Array.from(paragraph.attributes, ({ name, value }) => [name, value]),
    };
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const appliedParagraph = document.body.firstElementChild;
    const afterApply = {
      present: appliedParagraph.hasAttribute("_moz_dirty"),
      value: appliedParagraph.getAttribute("_moz_dirty"),
      attributes: Array.from(appliedParagraph.attributes, ({ name, value }) => [name, value]),
    };
    const undone = await request("undo", { trialId: applied.value.trialId });
    const undoneParagraph = document.body.firstElementChild;
    const afterUndo = {
      present: undoneParagraph.hasAttribute("_moz_dirty"),
      value: undoneParagraph.getAttribute("_moz_dirty"),
      attributes: Array.from(undoneParagraph.attributes, ({ name, value }) => [name, value]),
    };
    const redone = await request("redo", { trialId: applied.value.trialId });
    const redoneParagraph = document.body.firstElementChild;
    const afterRedo = {
      present: redoneParagraph.hasAttribute("_moz_dirty"),
      value: redoneParagraph.getAttribute("_moz_dirty"),
      attributes: Array.from(redoneParagraph.attributes, ({ name, value }) => [name, value]),
    };
    results.mozDirtyParagraph = { captured, blockCapture, applied, undone, redone, before, afterApply, afterUndo, afterRedo, counts };
  }
  {
    reset('<p _moz_dirty="">TARGET</p>');
    selectText(document.body.firstElementChild);
    const nativeCloneNode = Node.prototype.cloneNode;
    Node.prototype.cloneNode = function cloneWithoutHiddenAttribute(deep) {
      const clone = nativeCloneNode.call(this, deep);
      if (clone.nodeType === Node.ELEMENT_NODE) clone.removeAttribute("_moz_dirty");
      return clone;
    };
    let response;
    try {
      response = await request("capture");
    } finally {
      Node.prototype.cloneNode = nativeCloneNode;
    }
    results.cloneAttributeLoss = response;
  }
  results.mozDirtyConfinement = [];
  for (const mozDirtyMutation of ["remove", "change"]) {
    reset('<p _moz_dirty="">prefix TARGET suffix</p>');
    const paragraph = document.body.firstElementChild;
    const node = textNode(paragraph);
    const start = node.data.indexOf("TARGET");
    selectText(paragraph, start, start + 6);
    const captured = await request("capture");
    if (!captured.ok) throw new Error("moz-dirty confinement Capture failed: " + JSON.stringify(captured));
    const counts = editor({ mozDirtyMutation });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.mozDirtyConfinement.push({ mozDirtyMutation, response, counts, html: document.body.innerHTML });
  }
  {
    reset('<p>TARGET <span data-private="yes" data-gecko-hidden="secret" data-r0-opaque="gecko-hidden">opaque</span></p>');
    const paragraph = document.body.firstElementChild;
    selectText(paragraph, 0, 6);
    const captured = await request("capture");
    const counts = editor({ hiddenTargetMutation: true, preserveOpaque: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    if (!response.value?.rollback?.restored) throw new Error("Gecko hidden rollback failed: " + JSON.stringify(response));
    results.geckoHiddenOpaqueDrift = { response, counts };
  }
  {
    reset('<p>TARGET</p>');
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "synthetic");
    document.body.append(svg);
    const exact = await request("inspect", { exact: true });
    const before = await request("inspect", { exact: false });
    svg.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "changed");
    const after = await request("inspect", { exact: false });
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const cryptoValue = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: cryptoValue.getRandomValues.bind(cryptoValue) },
    });
    let fallback;
    try {
      fallback = await request("inspect", { exact: true });
    } finally {
      Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    }
    results.namespaceAndDiagnostic = { exact, before, after, fallback };
  }

  const adjacentRoot = (kind) => {
    if (kind === "comment") return document.createComment("r0-adjacent-private-comment");
    if (kind === "link") {
      const node = document.createElement("a");
      node.href = "#synthetic";
      node.textContent = "link";
      node.dataset.r0Opaque = "link";
      return node;
    }
    if (kind === "styled") {
      const node = document.createElement("span");
      node.style.color = "red";
      node.textContent = "styled";
      node.dataset.r0Opaque = "styled";
      return node;
    }
    if (kind === "image") {
      const node = document.createElement("img");
      node.alt = "synthetic";
      node.dataset.r0Opaque = "image";
      return node;
    }
    if (kind === "noneditable") {
      const node = document.createElement("span");
      node.contentEditable = "false";
      node.textContent = "noneditable";
      node.dataset.r0Opaque = "noneditable";
      return node;
    }
    const node = document.createElement("ul");
    const item = document.createElement("li");
    const nested = document.createElement("ul");
    nested.append(Object.assign(document.createElement("li"), { textContent: "nested" }));
    item.append("outer", nested);
    node.append(item);
    node.dataset.r0Opaque = "nested-list";
    return node;
  };
  const directBodyCapture = async (root, position = "before") => {
    reset("");
    const target = document.createTextNode("prefix TARGET suffix");
    if (!root) document.body.append(target);
    else if (position === "before") document.body.append(target, root);
    else document.body.append(root, target);
    const start = target.data.indexOf("TARGET");
    const range = document.createRange();
    range.setStart(target, start);
    range.setEnd(target, start + 6);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const response = await request("capture");
    if (!response.ok) throw new Error("directBodyCapture failed: " + JSON.stringify(response));
    return response;
  };
  {
    const captured = await directBodyCapture();
    const counts = editor();
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    results.directBodyText = { captured, applied, undone, redone, counts };
  }
  {
    const captured = await directBodyCapture();
    const counts = editor({ mergeInsertedLineSuffix: true });
    const applied = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const undone = await request("undo", { trialId: applied.value.trialId });
    const redone = await request("redo", { trialId: applied.value.trialId });
    results.directBodyMergedSuffix = { captured, applied, undone, redone, counts };
  }
  {
    const captured = await directBodyCapture();
    const counts = editor({ mutate: false });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "blocks",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results.directBodyForgedBlocks = { captured, response, counts };
  }
  results.directBodyAdjacency = [];
  for (const kind of ["link", "styled", "comment", "image", "noneditable", "nested-list"]) {
    for (const position of ["before", "after"]) {
      const captured = await directBodyCapture(adjacentRoot(kind), position);
      const counts = editor({ preserveOpaque: true });
      const applied = await request("apply", {
        captureId: captured.value.captureId,
        preset: "inline",
        editorMode: { isPlainText: false, deliveryFormat: "auto" },
      });
      const undone = await request("undo", { trialId: applied.value.trialId });
      const redone = await request("redo", { trialId: applied.value.trialId });
      results.directBodyAdjacency.push({ kind, position, captured, applied, undone, redone, counts });
    }
  }
  results.sameParagraphAdjacency = [];
  for (const kind of ["link", "styled", "comment", "image", "noneditable", "nested-list"]) {
    for (const position of ["before", "after"]) {
      reset("<p></p>");
      const paragraph = document.body.firstElementChild;
      const target = document.createTextNode("TARGET");
      const root = adjacentRoot(kind);
      if (position === "before") paragraph.append(target, root);
      else paragraph.append(root, target);
      const range = document.createRange();
      range.selectNodeContents(target);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      const captured = await request("capture");
      const counts = editor({ preserveOpaque: true });
      const applied = await request("apply", {
        captureId: captured.value.captureId,
        preset: "inline",
        editorMode: { isPlainText: false, deliveryFormat: "auto" },
      });
      const undone = await request("undo", { trialId: applied.value.trialId });
      const redone = await request("redo", { trialId: applied.value.trialId });
      results.sameParagraphAdjacency.push({ kind, position, classification: captured.value.classification, applied, undone, redone, counts });
    }
  }

  {
    const captured = await captureFirst("<p>TARGET</p>");
    const counts = editor();
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      induceFailure: true,
      editorMode: { isPlainText: false, deliveryFormat: "html" },
    });
    results.rollback = { captured, response, counts };
  }

  for (const mode of ["verificationException", "throwAfterMutation"]) {
    const captured = await captureFirst("<p>TARGET</p>");
    const counts = editor({ [mode]: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    results[mode] = { response, counts };
  }

  {
    reset('<p>prefix TARGET suffix</p><p data-private="yes">opaque</p>');
    const target = document.body.firstElementChild;
    const node = textNode(target);
    const start = node.data.indexOf("TARGET");
    selectText(target, start, start + 6);
    const captured = await request("capture");
    const counts = editor({ replaceOpaque: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const state = await request("state");
    results.opaqueIdentityReplacement = { response, state, counts };
  }

  {
    reset('<p>prefix TARGET suffix <span data-private="yes" data-r0-opaque="relocated">opaque</span></p>');
    const paragraph = document.body.firstElementChild;
    const node = textNode(paragraph);
    const start = node.data.indexOf("TARGET");
    selectText(paragraph, start, start + 6);
    const captured = await request("capture");
    const counts = editor({ relocateOpaque: true, preserveOpaque: true });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "inline",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    if (!response.value?.rollback?.restored) throw new Error("opaque relocation rollback failed: " + JSON.stringify(response));
    results.opaqueRelocation = { response, counts };
  }

  {
    reset('<ul _moz_dirty=""><li _moz_dirty="">one</li><li _moz_dirty="">two</li><li _moz_dirty="">three</li></ul>');
    selectWholeListText();
    const captured = await request("capture");
    const counts = editor({ sameKindListMerge: true, decorateInsertedListItems: "wrong-value",
      restoreOriginalTargetIdentities: false });
    const response = await request("apply", {
      captureId: captured.value.captureId,
      preset: "same-kind-list-rewrite",
      editorMode: { isPlainText: false, deliveryFormat: "auto" },
    });
    const state = await request("state");
    results.rollbackFailure = { response, state, counts };
  }

  document.documentElement.dataset.result = encodeURIComponent(JSON.stringify(results));
})().catch((error) => {
  document.documentElement.dataset.result = encodeURIComponent(JSON.stringify({ harnessError: error?.stack || String(error) }));
});
</script>`;

try {
  await writeFile(page, harness);
  const dumped = execFileSync(process.env.CHROMIUM_BIN || "chromium", [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--virtual-time-budget=5000",
    "--dump-dom",
    page,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const encoded = dumped.match(/<html[^>]*data-result="([^"]*)"/u)?.[1];
  assert.ok(encoded, `headless harness did not produce a result: ${dumped.slice(-3_000)}`);
  const result = JSON.parse(decodeURIComponent(encoded));
  assert.equal(result.harnessError, undefined, result.harnessError);

  for (const item of result.hostile) assert.equal(item.eligible, false, `hostile selection was eligible: ${item.html}`);
  for (const item of result.foreignNamespace) {
    assert.equal(item.oldPredicateAccepted, true, `old predicate canary rejected foreign-namespace ${item.tagName}`);
    assert.equal(item.classification.eligible, false, `foreign-namespace ${item.tagName} was eligible`);
  }
  for (const item of result.namespacedMozDirty) {
    assert.equal(item.oldPredicateAccepted, true, `old predicate canary rejected namespaced _moz_dirty on ${item.tagName}`);
    assert.deepEqual(item.tuple, ["urn:thunderclaw:foreign", null, "_moz_dirty", "_moz_dirty", ""]);
    assert.equal(item.classification.eligible, false, `namespaced _moz_dirty on ${item.tagName} was eligible`);
  }
  assert.equal(result.topLevelBreak.eligible, false, "top-level br was eligible");
  assert.equal(result.selectedNestedList.eligible, false, "selected nested list was eligible");
  assert.equal(result.promotedFullList.captured.value.classification.placement, "blocks");
  assert.equal(result.promotedFullList.captured.value.classification.wholeListTargeted, true);
  assert.equal(result.promotedFullList.captured.value.wholeListTargeted, true);
  assert.deepEqual(result.promotedFullList.captured.value.boundary.startPath, []);
  assert.deepEqual(result.promotedFullList.captured.value.originalBoundary.startPath, [0, 0, 0]);
  assert.deepEqual(result.promotedFullList.captured.value.originalBoundary.endPath, [0, 2, 0]);
  assert.equal(result.promotedFullList.applied.ok, false);
  assert.equal(result.promotedFullList.counts.insertHTML, 0);
  assert.equal(result.automationBridge.rejected.ok, false, "automation bridge accepted the wrong R0 build ID");
  assert.equal(result.automationBridge.ping.value.ready, true);
  for (const response of [result.automationBridge.ping, result.automationBridge.rejected,
    result.automationBridge.captured, result.automationBridge.applied]) {
    assert.equal(response.buildId, "thunderclaw-rich-compose-r0@example.invalid:0.0.1");
  }
  assert.equal(result.automationBridge.captured.value.classification.wholeListTargeted, true);
  assert.equal(result.automationBridge.applied.ok, false);
  assert.equal(result.automationBridge.counts.insertHTML, 0);
  assert.equal(result.automationBridge.counts.undo, 0);
  assert.equal(result.automationBridge.counts.redo, 0);
  assert.deepEqual(result.automationBridge.documentElementAttributes.filter((name) => name.startsWith("data-thunderclaw-r0")), []);
  assert.equal(result.promotedObservedOrderedList.value.classification.placement, "blocks");
  assert.equal(result.promotedObservedOrderedList.value.classification.wholeListTargeted, true);
  for (const item of result.bodyWrapperLists) {
    assert.equal(item.captured.value.classification.wholeListTargeted, true,
      `BODY wrapper ${item.start}/${item.backward} was not promoted`);
    assert.equal(item.captured.value.sameKindListEligible, true);
    assert.deepEqual(item.captured.value.originalBoundary.startPath, []);
    assert.deepEqual(item.captured.value.originalBoundary.endPath, []);
    assert.equal(item.captured.value.originalBoundary.startOffset, item.start);
    assert.equal(item.captured.value.originalBoundary.endOffset, item.start + 1);
    assert.equal(item.stateAfterCapture.value.latestCaptureId, item.captured.value.captureId);
    assert.equal(item.stateAfterCapture.value.latestCaptureWholeListTargeted, true);
    assert.equal(item.stateAfterCapture.value.latestCaptureSameKindListEligible, true);
    assert.equal(item.applied.value.applied, true, JSON.stringify(item.applied));
    assert.equal(item.wrapperSame, true, "BODY wrapper Apply replaced the list object");
    assert.equal(item.canariesSame, true, "BODY wrapper Apply replaced an adjacent canary");
    assert.equal(item.stateAfterApply.value.latestCaptureId, undefined);
    assert.equal(item.stateAfterApply.value.latestCaptureWholeListTargeted, false);
    assert.equal(item.stateAfterApply.value.latestCaptureSameKindListEligible, false);
    assert.equal(item.counts.insertHTML, 1);
  }
  for (const item of result.bodyWrapperNegatives) {
    assert.equal(item.captured.value.classification.wholeListTargeted, false,
      `${item.name} BODY range was promoted to a whole list`);
  }
  for (const item of result.sameKindLists) {
    assert.equal(item.captured.value.sameKindListEligible, true, `${item.kind}/${item.preset} was not same-kind eligible`);
    assert.equal(item.captured.value.sameKindListMinimumThunderbirdMajor, 153);
    assert.equal(item.stateAfterCapture.value.latestCaptureId, item.captured.value.captureId,
      `${item.kind}/${item.preset} state did not retain capture identity for popup reopen`);
    assert.equal(item.stateAfterCapture.value.latestCaptureWholeListTargeted, true);
    assert.equal(item.stateAfterCapture.value.latestCaptureSameKindListEligible, true);
    assert.equal(item.applied.value.applied, true, `${item.kind}/${item.preset} Apply failed: ${JSON.stringify(item.applied)}`);
    assert.equal(item.stateAfterApply.value.latestCaptureId, undefined,
      `${item.kind}/${item.preset} consumed capture remained reattachable`);
    assert.equal(item.stateAfterApply.value.latestCaptureWholeListTargeted, false);
    assert.equal(item.stateAfterApply.value.latestCaptureSameKindListEligible, false);
    assert.equal(item.applyState.wrapperSame, true, `${item.kind}/${item.preset} replaced the wrapper object`);
    assert.equal(item.applyState.canariesSame, true, `${item.kind}/${item.preset} replaced an adjacent canary`);
    assert.equal(item.applyState.count, item.expectedCount);
    for (const attributes of item.applyState.itemAttributes) {
      assert.deepEqual(attributes, [[null, null, "_moz_dirty", "_moz_dirty", ""]]);
    }
    assert.equal(item.undone.value.exact, true, `${item.kind}/${item.preset} Undo was not exact`);
    assert.equal(item.redone.value.exact, true, `${item.kind}/${item.preset} Redo was not exact`);
    assert.equal(item.counts.insertHTML, 1);
    assert.equal(item.counts.undo, 1);
    assert.equal(item.counts.redo, 1);
  }
  for (const item of result.sameKindListBadAttributes) {
    assert.equal(item.captured.value.sameKindListEligible, true);
    assert.equal(item.response.value.applied, false, `${item.variant} LI decoration escaped verification`);
    assert.equal(item.response.value.verificationFailedAt, "exact-confinement");
    assert.equal(item.response.value.verificationFailureSubtype, "fixture-attribute-profile-li");
    assert.equal(item.response.value.rollback.restored, true);
    assert.equal(item.counts.insertHTML, 1);
    assert.equal(item.counts.undo, 1);
  }
  assert.equal(result.sameKindListBackward.applied.value.applied, true);
  assert.equal(result.sameKindListBackward.undone.value.exact, true);
  assert.equal(result.sameKindListBackward.redone.value.exact, true);
  assert.deepEqual({
    anchorPath: result.sameKindListBackward.undone.value.selectionAfterUndo.anchor.path,
    anchorOffset: result.sameKindListBackward.undone.value.selectionAfterUndo.anchor.offset,
    focusPath: result.sameKindListBackward.undone.value.selectionAfterUndo.focus.path,
    focusOffset: result.sameKindListBackward.undone.value.selectionAfterUndo.focus.offset,
  }, result.sameKindListBackward.beforeDirection);
  assert.equal(result.delayedCapabilityCapture.captured.value.classification.wholeListTargeted, false);
  assert.equal(result.delayedCapabilityCapture.captured.value.sameKindListEligible, false);
  assert.equal(result.delayedCapabilityCapture.selectedText, "changed-during-capability");
  assert.equal(result.sameKindListOldRuntime.captured.value.sameKindListEligible, false);
  assert.equal(result.sameKindListOldRuntime.response.ok, false);
  assert.match(result.sameKindListOldRuntime.response.error, /Thunderbird 153 or newer/u);
  assert.equal(result.sameKindListOldRuntime.counts.insertHTML, 0);
  for (const item of result.sameKindListMalformedCapabilities) {
    assert.equal(item.captured.value.sameKindListEligible, false, `${item.name} capability was trusted`);
    assert.equal(item.response.ok, false);
    assert.equal(item.counts.insertHTML, 0, `${item.name} capability reached insertHTML`);
  }
  assert.equal(result.sameKindListStaleCapability.captured.value.sameKindListEligible, true,
    "pre-existing underline made the whole list ineligible");
  assert.equal(result.sameKindListStaleCapability.response.ok, false);
  assert.match(result.sameKindListStaleCapability.response.error, /runtime capability changed/u);
  assert.equal(result.sameKindListStaleCapability.counts.insertHTML, 0);
  assert.equal(result.wholeListLegacyBlocksRejected.captured.value.sameKindListEligible, true);
  assert.equal(result.wholeListLegacyBlocksRejected.response.ok, false);
  assert.match(result.wholeListLegacyBlocksRejected.response.error, /only a same-kind whole-list replacement/u);
  assert.equal(result.wholeListLegacyBlocksRejected.counts.insertHTML, 0);
  assert.equal(result.singleListItem.captured.value.classification.placement, "inline");
  assert.equal(result.singleListItem.captured.value.classification.wholeListTargeted, false);
  assert.deepEqual(result.singleListItem.captured.value.boundary.startPath, [0, 1, 0]);
  assert.equal(result.singleListItem.captured.value.selectedTextLength, 7);
  assert.equal(result.singleListItem.forged.ok, false);
  assert.equal(result.singleListItem.counts.insertHTML, 0);
  assert.equal(result.singleListItem.applied.value.applied, true, JSON.stringify(result.singleListItem.applied));
  assert.equal(result.singleListItem.undone.value.exact, true);
  assert.equal(result.singleListItem.redone.value.exact, true);
  for (const state of result.singleListItem.states) {
    assert.deepEqual(state, [
      ["ul", [["_moz_dirty", ""]]],
      ["li", [["_moz_dirty", ""]]],
      ["li", [["_moz_dirty", ""]]],
      ["li", [["_moz_dirty", ""]]],
    ]);
  }
  assert.deepEqual(result.liveElementBoundaryDecoratedBreak.captured.value.boundary.startPath, [0, 1]);
  assert.deepEqual(result.liveElementBoundaryDecoratedBreak.captured.value.boundary.endPath, [0, 1]);
  assert.equal(result.liveElementBoundaryDecoratedBreak.captured.value.boundary.startOffset, 0);
  assert.equal(result.liveElementBoundaryDecoratedBreak.captured.value.boundary.endOffset, 1);
  assert.equal(result.liveElementBoundaryDecoratedBreak.captured.value.selectedTextLength, 4);
  assert.equal(result.liveElementBoundaryDecoratedBreak.applied.value.applied, true);
  assert.deepEqual(result.liveElementBoundaryDecoratedBreak.insertedBreakTuple,
    [[null, null, "_moz_dirty", "_moz_dirty", ""]]);
  assert.equal(result.liveElementBoundaryDecoratedBreak.undone.value.exact, true);
  assert.equal(result.liveElementBoundaryDecoratedBreak.redone.value.exact, true);
  assert.equal(result.liveElementBoundaryWrongBreakDecoration.response.value.applied, false);
  assert.equal(result.liveElementBoundaryWrongBreakDecoration.response.value.verificationError, true);
  assert.equal(result.liveElementBoundaryWrongBreakDecoration.response.value.verificationFailedAt, "exact-confinement");
  assert.equal(result.liveElementBoundaryWrongBreakDecoration.response.value.rollback.restored, true);
  assert.equal(result.liveElementBoundaryWrongBreakDecoration.counts.undo, 1);
  assert.equal(result.liveAllGeneratedDecorations.applied.value.applied, true);
  assert.deepEqual(Object.fromEntries(["b", "i", "u", "br"].map((name) =>
    [name, result.liveAllGeneratedDecorations.decorated.filter((node) => node.name === name).length])),
  { b: 4, i: 4, u: 4, br: 1 });
  for (const node of result.liveAllGeneratedDecorations.decorated) {
    assert.deepEqual(node.attributes, [[null, null, "_moz_dirty", "_moz_dirty", ""]]);
  }
  assert.equal(result.liveAllGeneratedDecorations.undone.value.exact, true);
  assert.equal(result.liveAllGeneratedDecorations.redone.value.exact, true);
  const expectedDecorationSubtype = {
    "wrong-value-b": "fixture-attribute-profile-b",
    "additional-i": "fixture-attribute-profile-i",
    "namespaced-br": "fixture-attribute-profile-br",
    "foreign-strong": "fixture-attribute-profile-other",
    "wrong-value-u": "fixture-attribute-profile-u",
    "additional-u": "fixture-attribute-profile-u",
    "namespaced-u": "fixture-attribute-profile-u",
  };
  for (const item of result.wrongGeneratedDecorations) {
    assert.equal(item.response.value.applied, false, `${item.variant} escaped generated-decoration qualification`);
    if (["foreign-strong", "foreign-u", "wrong-tag-u"].includes(item.variant)) {
      assert.equal(item.response.value.verificationFailedAt, "fixture-shape");
      assert.equal(item.response.value.verificationFailureDetail.reason, "token-container");
      assert.equal(item.response.value.verificationFailureDetail.token,
        item.variant === "foreign-strong" ? "BOLD" : "UNDERLINE");
      assert.equal(item.response.value.verificationFailureDetail.actual.namespace,
        item.variant === "foreign-u" ? "other" : "xhtml");
      assert.equal(item.response.value.verificationFailureDetail.actual.name,
        item.variant === "foreign-strong" ? "strong" : item.variant === "wrong-tag-u" ? "span" : "u");
    } else {
      assert.equal(item.response.value.verificationFailedAt, "exact-confinement");
      assert.equal(item.response.value.verificationFailureSubtype, expectedDecorationSubtype[item.variant], item.variant);
    }
    assert.equal(item.response.value.rollback.restored, true);
    assert.equal(item.counts.undo, 1);
  }
  assert.deepEqual(result.liveWholeTextPrunedBoundaries.captured.value.boundary.startPath, [0, 1, 0]);
  assert.equal(result.liveWholeTextPrunedBoundaries.captured.value.selectedTextLength, 11);
  assert.equal(result.liveWholeTextPrunedBoundaries.applied.value.applied, true);
  assert.equal(result.liveWholeTextPrunedBoundaries.undone.value.exact, true);
  assert.equal(result.liveWholeTextPrunedBoundaries.redone.value.exact, true);
  assert.equal(result.partialTextPrunedBoundaries.applied.value.applied, true);
  assert.equal(result.partialTextPrunedBoundaries.text.startsWith("prefix "), true);
  assert.equal(result.partialTextPrunedBoundaries.text.endsWith(" suffix"), true);
  assert.equal(result.genuineEmptySiblings.applied.value.applied, true);
  assert.equal(result.genuineEmptySiblings.preservedAfterApply, true);
  assert.equal(result.genuineEmptySiblings.undone.value.exact, true);
  assert.equal(result.genuineEmptySiblings.redone.value.exact, true);
  assert.equal(result.genuineEmptySiblingDrift.response.value.applied, false);
  assert.equal(result.genuineEmptySiblingDrift.response.value.verificationError, true);
  assert.equal(result.genuineEmptySiblingDrift.response.value.verificationFailureSubtype, "exact-confinement-exception");
  assert.equal(result.genuineEmptySiblingDrift.response.value.rollback.restored, true);
  assert.equal(result.genuineEmptySiblingDrift.counts.undo, 1);
  assert.equal(result.manualUndoEmptyIdentityDrift.verified.value.exact, false,
    "Ctrl+Z verification ignored replacement of a genuine empty Text node");
  assert.equal(result.prunedBoundaryNeighbors.captured.value.classification.eligible, true);
  assert.equal(result.prunedBoundaryNeighbors.applied.value.applied, true);
  assert.deepEqual(result.prunedBoundaryNeighbors.identities, [true, true, true]);
  assert.equal(result.geckoLikeInsertedWrapperMismatch.captured.value.selectedTextLength, 11);
  assert.equal(result.geckoLikeInsertedWrapperMismatch.response.value.applied, false);
  assert.equal(result.geckoLikeInsertedWrapperMismatch.response.value.verificationError, false);
  assert.equal(result.geckoLikeInsertedWrapperMismatch.response.value.verificationFailedAt, "exact-confinement");
  assert.equal(result.geckoLikeInsertedWrapperMismatch.response.value.verificationFailureSubtype, "canonical-mask-mismatch");
  assert.deepEqual(result.geckoLikeInsertedWrapperMismatch.response.value.verificationFailureDetail, {
    reason: "node-kind",
    path: [0, 1, 0],
    expected: { kind: "target-slot" },
    actual: { kind: "element", name: "span", namespace: "xhtml", attributes: "none", childCount: 1 },
  });
  assert.equal(result.geckoLikeInsertedWrapperMismatch.response.value.rollback.restored, true);
  assert.equal(result.geckoLikeInsertedWrapperMismatch.counts.undo, 1);
  assert.equal(JSON.stringify(result.geckoLikeInsertedWrapperMismatch.response.value.verificationFailureDetail).includes("elevenchars"), false);
  assert.equal(result.listAttributeDrift.response.value.applied, false);
  assert.equal(result.listAttributeDrift.response.value.rollback.restored, true);
  assert.equal(result.listAttributeDrift.counts.undo, 1);
  assert.equal(result.breakAttributes.captured.value.classification.placement, "inline");
  assert.equal(result.breakAttributes.applied.value.applied, true);
  assert.equal(result.breakAttributes.undone.value.exact, true);
  assert.equal(result.breakAttributes.redone.value.exact, true);
  const preservedBreakState = [["p", [["_moz_dirty", ""]]], ["br", [["_moz_dirty", ""]]]];
  const appliedBreakState = [["p", [["_moz_dirty", ""]]], ["br", []], ["br", [["_moz_dirty", ""]]]];
  assert.deepEqual(result.breakAttributes.states[0], preservedBreakState);
  assert.deepEqual(result.breakAttributes.states[1], appliedBreakState);
  assert.deepEqual(result.breakAttributes.states[2], preservedBreakState);
  assert.deepEqual(result.breakAttributes.states[3], appliedBreakState);
  assert.equal(result.breakAttributeDrift.response.value.applied, false);
  assert.equal(result.breakAttributeDrift.response.value.rollback.restored, true);
  assert.equal(result.breakAttributeDrift.counts.undo, 1);
  assert.equal(result.offByOneList.eligible, false);
  assert.equal(result.leadingBreakList.eligible, false);
  assert.equal(result.commentedList.eligible, false);
  assert.equal(result.multipleLists.eligible, false);
  assert.equal(result.listInParagraph.eligible, false, "list inside paragraph was eligible");
  assert.equal(result.inlineAcrossNestedBlocks.eligible, false, "inline range spanning nested blocks was eligible");
  assert.equal(result.selectedComment.eligible, false, "selected comment was eligible");
  assert.equal(result.commentBoundary.eligible, false, "comment boundary was eligible");
  assert.equal(result.intersectedAttributedHostile.eligible, false, "range intersecting attributed hostile content was eligible");
  assert.equal(result.blockPlacement.placement, "blocks");
  assert.equal(result.followingOffsetZeroPlacement.placement, "blocks");
  assert.equal(result.blockApply.response.value.applied, true, "body-offset block Apply failed");
  assert.equal(result.followingOffsetZeroApply.response.value.applied, true, "following-offset-zero block Apply failed");
  assert.equal(result.partialCrossBlock.placement, "ineligible");
  assert.equal(result.adjacentProtected.eligible, true, "adjacent protected DOM should remain eligible");
  assert.equal(result.followingProtectedOffsetZero.placement, "blocks", "following protected offset-zero was treated as selected");
  for (const item of result.blockedModes) {
    assert.equal(item.response.ok, false, `blocked editor/delivery mode was accepted: ${JSON.stringify(item.editorMode)}`);
    assert.equal(item.counts.insertHTML, 0, "blocked mode reached insertHTML");
  }
  assert.equal(result.bodyDrift.response.ok, false, "body drift did not invalidate Apply");
  assert.equal(result.bodyDrift.counts.insertHTML, 0, "body drift reached insertHTML");
  assert.equal(result.preApplyRevision.response.ok, false, "pre-Apply edit/revert revision was accepted");
  assert.equal(result.preApplyRevision.counts.insertHTML, 0, "pre-Apply revision mismatch reached insertHTML");
  assert.equal(result.noMutationFailure.response.value.applied, false);
  assert.equal(result.noMutationFailure.counts.undo, 0, "non-mutating command invoked unrelated Undo");
  assert.equal(result.transientNoNet.response.value.rollback.restored, true);
  assert.equal(result.transientNoNet.counts.undo, 0, "transient no-net mutation invoked unrelated Undo");
  assert.equal(result.presetMismatch.response.ok, false, "preset/placement mismatch was accepted");
  assert.equal(result.presetMismatch.counts.insertHTML, 0, "preset mismatch reached insertHTML");
  assert.equal(result.undoRedo.undone.value.exact, true);
  assert.equal(result.undoRedo.redone.value.exact, true);
  assert.deepEqual(result.undoRedo.undone.value.selectionAfterUndo.boundary,
    result.undoRedo.applied.value.selectionBeforeApply.boundary);
  assert.equal(result.undoRedo.undoAfterDrift.ok, false, "Undo ignored unrelated body drift");
  assert.equal(result.undoRedo.counts.undo, 1, "refused Undo still invoked native Undo");
  assert.equal(result.undoRedo.counts.redo, 1);
  assert.equal(result.manualUndoSelectionDrift.verified.value.exact, false,
    "Ctrl+Z verification ignored selection drift");
  assert.equal(result.selectionDrift.response.ok, false, "Apply ignored current selection drift");
  assert.equal(result.selectionDrift.counts.insertHTML, 0, "selection-drift rejection reached insertHTML");
  assert.equal(result.foreignInsertedFixture.response.value.applied, false,
    "foreign-namespace generated fixture passed semantic verification");
  assert.equal(result.foreignInsertedFixture.response.value.verificationFailedAt, "fixture-shape");
  assert.equal(result.foreignInsertedFixture.response.value.verificationFailureDetail.reason, "token-container");
  assert.equal(result.foreignInsertedFixture.response.value.verificationFailureDetail.actual.namespace, "other");
  assert.equal(JSON.stringify(result.foreignInsertedFixture.response.value.verificationFailureDetail).includes("TARGET"), false);
  assert.equal(result.editRevertIdentical.refused.ok, false, "edit/revert history did not invalidate ThunderClaw Undo");
  assert.equal(result.editRevertIdentical.counts.undo, 0, "revision-refused Undo consumed a native unit");
  assert.equal(result.inputRevision.refused.ok, false, "input event did not invalidate ThunderClaw Undo");
  assert.equal(result.inputRevision.counts.undo, 0, "input-revision refusal consumed a native unit");
  assert.equal(result.hiddenDriftBeforeUndo.refused.ok, false, "hidden attr edit/revert did not fence Undo");
  assert.equal(result.hiddenDriftBeforeUndo.counts.undo, 0);
  assert.equal(result.hiddenDriftBeforeRedo.undone.value.exact, true);
  assert.equal(result.hiddenDriftBeforeRedo.refused.ok, false, "hidden attr edit/revert did not fence Redo");
  assert.equal(result.hiddenDriftBeforeRedo.counts.redo, 0);
  assert.equal(result.typedSlotCollision.applied.value.applied, true, "typed target slot collided with email text");
  assert.equal(result.typedSlotCollision.text.split("TC_R0_EXACT_TARGET_SLOT").length, 3);
  assert.equal(result.mozDirtyParagraph.captured.value.classification.placement, "inline");
  assert.equal(result.mozDirtyParagraph.blockCapture.value.classification.eligible, false, "whole attributed paragraph was block-eligible");
  assert.equal(result.mozDirtyParagraph.applied.value.applied, true);
  assert.equal(result.mozDirtyParagraph.undone.value.exact, true);
  assert.equal(result.mozDirtyParagraph.redone.value.exact, true);
  assert.equal(result.cloneAttributeLoss.ok, false, "cloneNode hidden-attribute loss did not fail closed");
  for (const state of [result.mozDirtyParagraph.before, result.mozDirtyParagraph.afterApply, result.mozDirtyParagraph.afterUndo, result.mozDirtyParagraph.afterRedo]) {
    assert.equal(state.present, true, "_moz_dirty presence was not preserved");
    assert.equal(state.value, "", "_moz_dirty value was not preserved");
    assert.deepEqual(state.attributes, [["_moz_dirty", ""]], "paragraph attribute set changed");
  }
  for (const item of result.mozDirtyConfinement) {
    assert.equal(item.response.value.applied, false, `_moz_dirty ${item.mozDirtyMutation} escaped confinement`);
    assert.equal(item.response.value.rollback.restored, true, `_moz_dirty ${item.mozDirtyMutation} rollback failed`);
    assert.equal(item.counts.undo, 1, `_moz_dirty ${item.mozDirtyMutation} did not consume exactly one rollback Undo`);
    assert.equal(item.html, '<p>prefix TARGET suffix</p>', `Gecko serializer mock exposed _moz_dirty after ${item.mozDirtyMutation}`);
    assert.deepEqual(item.counts.legacyHiddenBefore, item.counts.legacyHiddenAfter, "Gecko-omitted _moz_dirty drift changed legacy attribute view");
  }
  assert.deepEqual(result.geckoHiddenOpaqueDrift.counts.legacyHiddenBefore, result.geckoHiddenOpaqueDrift.counts.legacyHiddenAfter);
  assert.equal(result.geckoHiddenOpaqueDrift.response.value.applied, false, "Gecko-hidden opaque drift escaped canonical verification");
  assert.equal(result.geckoHiddenOpaqueDrift.response.value.rollback.restored, true);
  assert.equal(result.geckoHiddenOpaqueDrift.counts.undo, 1);
  const svgState = result.namespaceAndDiagnostic.exact.value.body.children[1];
  assert.deepEqual(svgState.attributes[0], ["http://www.w3.org/1999/xlink", "xlink", "href", "xlink:href", "synthetic"]);
  assert.match(result.namespaceAndDiagnostic.before.value.bodyFingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(result.namespaceAndDiagnostic.before.value.bodyFingerprint, result.namespaceAndDiagnostic.after.value.bodyFingerprint);
  assert.match(result.namespaceAndDiagnostic.fallback.value.bodyFingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    result.namespaceAndDiagnostic.fallback.value.bodyFingerprint,
    "sha256:" + createHash("sha256").update(JSON.stringify(result.namespaceAndDiagnostic.fallback.value.body)).digest("hex"),
  );
  assert.equal(result.directBodyText.captured.value.classification.placement, "inline");
  assert.equal(result.directBodyText.captured.value.classification.inlineMode, "direct_body_text");
  assert.equal(result.directBodyText.applied.value.applied, true);
  assert.equal(result.directBodyText.undone.ok, true, result.directBodyText.undone.error);
  assert.equal(result.directBodyText.undone.value.exact, true);
  assert.equal(result.directBodyText.redone.value.exact, true);
  assert.equal(result.directBodyMergedSuffix.applied.value.applied, true,
    "Gecko-style inserted LINE/suffix merge failed exact confinement");
  assert.equal(result.directBodyMergedSuffix.undone.value.exact, true);
  assert.equal(result.directBodyMergedSuffix.redone.value.exact, true);
  assert.equal(result.directBodyForgedBlocks.response.ok, false, "direct-body inline accepted block preset");
  assert.equal(result.directBodyForgedBlocks.counts.insertHTML, 0, "forged direct-body block preset reached insertHTML");
  for (const item of result.directBodyAdjacency) {
    assert.equal(item.captured.value.classification.inlineMode, "direct_body_text", `${item.kind}/${item.position} direct-body target was ineligible`);
    assert.equal(item.applied.value.applied, true);
    assert.equal(item.undone.value.exact, true);
    assert.equal(item.redone.value.exact, true);
  }
  for (const item of result.sameParagraphAdjacency) {
    assert.equal(item.classification.placement, "inline", `${item.kind}/${item.position} adjacent target was ineligible`);
    assert.equal(item.applied.value.applied, true, `${item.kind}/${item.position} Apply failed`);
    assert.equal(item.undone.value.exact, true, `${item.kind}/${item.position} Undo lost opaque identity/serialization`);
    assert.equal(item.redone.ok, true, `${item.kind}/${item.position} Redo errored: ${item.redone.error}`);
    assert.equal(item.redone.value.exact, true, `${item.kind}/${item.position} Redo lost opaque identity/serialization`);
    assert.equal(item.counts.undo, 1);
    assert.equal(item.counts.redo, 1);
  }
  assert.equal(result.rollback.response.value.rollback.restored, true);
  assert.equal(result.rollback.counts.undo, 1, "rollback did not use exactly one native Undo");
  assert.deepEqual(result.rollback.response.value.rollback.selectionAfterRollback.boundary,
    result.rollback.captured.value.originalBoundary);
  for (const mode of ["verificationException", "throwAfterMutation"]) {
    assert.equal(result[mode].response.value.applied, false, `${mode} claimed success`);
    assert.equal(result[mode].response.value.rollback.restored, true, `${mode} did not restore exactly`);
    assert.equal(result[mode].counts.undo, 1, `${mode} did not invoke exactly one rollback Undo`);
  }
  assert.equal(result.rollbackFailure.response.value.rollback.restored, false);
  assert.equal(result.rollbackFailure.state.value.richApplyDisabled, true);
  assert.equal(result.rollbackFailure.counts.undo, 1);
  assert.equal(result.opaqueIdentityReplacement.response.value.applied, false, "byte-identical opaque replacement passed");
  assert.equal(result.opaqueIdentityReplacement.counts.undo, 1, "opaque identity failure did not roll back once");
  assert.equal(result.opaqueRelocation.response.value.applied, false, "same opaque object relocation passed masked paths");
  assert.equal(result.opaqueRelocation.counts.undo, 1, "opaque relocation did not roll back once");

  // A successful postcondition must prove exact target confinement. This mock
  // simulates editor normalization of supported text adjacent to the selected
  // range while inserting every expected fixture token correctly.
  assert.equal(
    result.unexpectedAdjacentNormalization.response.value.applied,
    false,
    `Apply claimed success after adjacent supported DOM changed: ${result.unexpectedAdjacentNormalization.body}`,
  );

  process.stdout.write("rich-compose R0 adversarial runtime checks passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
