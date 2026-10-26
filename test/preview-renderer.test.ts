import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class Node {
  children: Node[] = [];
  constructor(readonly tag: string, readonly value = "") {}
  append(child: Node) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  set innerHTML(_value: string) { throw new Error("HTML parsing is forbidden"); }
}
const source = await readFile(new URL("../packages/thunderbird-extension/src/preview-renderer.js", import.meta.url), "utf8");
function renderer() {
  const context: any = { document: { createElement(tag: string) { return new Node(tag); }, createTextNode(value: string) { return new Node("#text", value); } } };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { render: context.ThunderClawPreview.render as (root: Node, result: any, view: string) => void };
}
function inspect(node: Node): string { return node.tag === "#text" ? node.value : `<${node.tag}>${node.children.map(inspect).join("")}</${node.tag}>`; }

test("plain comparison preserves Unicode, newlines, and HTML-looking text as text nodes", () => {
  const root = new Node("root");
  const result = { selectionShape: "text-range", original: "Hello 🦀\n<script>old</script>", replacement: "Hello 🦀\n<script>new</script>" };
  const { render } = renderer();
  render(root, result, "changes");
  assert.equal(root.children[1].tag, "del");
  assert.equal(root.children[1].children[0].value, "<script>old</script>");
  assert.equal(root.children[2].tag, "ins");
  assert.equal(root.children[2].children[0].value, "<script>new</script>");
  render(root, result, "original"); assert.equal(root.children[0].value, result.original);
  render(root, result, "proposed"); assert.equal(root.children[0].value, result.replacement);
});

test("list and rich comparisons preserve typed structure and show formatting-only changes", () => {
  const root = new Node("root"); const { render } = renderer();
  render(root, { selectionShape: "flat-list-items", original: "One\nTwo", replacement: "One\nDeux", listKind: "ol", originalItems: ["One", "Two"], replacementItems: ["One", "Deux"] }, "changes");
  assert.equal(inspect(root), "<root><ol><li>One</li><li><del>Two</del><ins>Deux</ins></li></ol></root>");
  const rich = { selectionShape: "rich-blocks", original: "Word", replacement: "", originalBlocks: [{ type: "paragraph", spans: [{ text: "Word" }] }], replacementBlocks: [{ type: "paragraph", spans: [{ text: "Word", marks: ["bold"] }] }] };
  render(root, rich, "changes");
  assert.equal(inspect(root), "<root><del><p>Word</p></del><ins><p><b>Word</b></p></ins></root>");
  assert.throws(() => render(root, { ...rich, replacementBlocks: [{ type: "paragraph", spans: [{ text: "x", marks: ["script"] }] }] }, "changes"));
});

test("large comparisons fall back to complete removed and inserted text", () => {
  const root = new Node("root"); const { render } = renderer();
  const original = Array.from({ length: 500 }, (_, i) => `old${i}`).join(" ");
  const replacement = Array.from({ length: 500 }, (_, i) => `new${i}`).join(" ");
  render(root, { selectionShape: "text-range", original, replacement }, "changes");
  assert.equal(root.children[0].children[0].value, original);
  assert.equal(root.children[1].children[0].value, replacement);
});
