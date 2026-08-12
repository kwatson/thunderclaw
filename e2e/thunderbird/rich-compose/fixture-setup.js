// Development-console setup for a disposable synthetic compose window only.
// This file is deliberately not packaged in the R0 XPI.
(() => {
  const element = (name, text) => {
    const node = document.createElement(name);
    if (text !== undefined) node.append(document.createTextNode(text));
    return node;
  };

  const supported = element("p");
  supported.append(
    document.createTextNode("prefix "),
    element("strong", "bold"),
    document.createTextNode(" and "),
    element("em", "italic"),
    document.createElement("br"),
    document.createTextNode("line break TARGET suffix"),
  );

  const second = element("p", "SECOND COMPLETE BLOCK");
  const third = element("p", "FOLLOWING BLOCK");
  const semanticAttribute = element("p", "semantic attribute node");
  semanticAttribute.dataset.private = "synthetic";
  const styled = element("span", "styled span");
  styled.style.fontWeight = "bold";
  const link = element("a", "synthetic link");
  link.href = "#synthetic";
  const nonEditable = element("span", "non-editable node");
  nonEditable.contentEditable = "false";
  const image = element("img");
  image.alt = "synthetic image";
  const unsupported = element("p");
  const privateComment = document.createComment("thunderclaw-r0-private-marker");
  unsupported.append(
    document.createTextNode("before "),
    privateComment,
    styled,
    document.createTextNode(" "),
    link,
    document.createTextNode(" "),
    nonEditable,
    image,
    document.createTextNode(" after"),
  );
  const table = element("table");
  const row = element("tr");
  row.append(element("td", "synthetic table cell"));
  table.append(row);
  const signature = element("div", "Synthetic signature");
  signature.className = "moz-signature";
  const citePrefix = element("div", "Synthetic wrote:");
  citePrefix.className = "moz-cite-prefix";
  const quote = element("blockquote", "Synthetic quoted history");
  quote.setAttribute("type", "cite");
  const forward = element("div", "Synthetic forwarded history");
  forward.className = "moz-forward-container";
  const nestedList = element("ul");
  const nestedOuterItem = element("li", "outer item ");
  const nestedInnerList = element("ul");
  nestedInnerList.append(element("li", "nested item"));
  nestedOuterItem.append(nestedInnerList);
  nestedList.append(nestedOuterItem);
  const listInParagraph = element("p", "paragraph before list ");
  const paragraphList = element("ul");
  paragraphList.append(element("li", "list in paragraph"));
  listInParagraph.append(paragraphList);
  const paragraphInList = element("ul");
  const paragraphItem = element("li");
  paragraphItem.append(element("p", "paragraph in list item"));
  paragraphInList.append(paragraphItem);
  const ambiguousNeutral = element("div");
  ambiguousNeutral.append(element("p", "nested block one"), element("p", "nested block two"));
  const topStrong = element("strong", "top-level strong");
  const topItem = element("li", "top-level list item");
  const topBreak = document.createElement("br");
  const adjacencyRoot = (kind) => {
    if (kind === "comment") return document.createComment("thunderclaw-r0-adjacent-comment");
    if (kind === "link") {
      const node = element("a", "adjacent link");
      node.href = "#synthetic-adjacent";
      return node;
    }
    if (kind === "styled") {
      const node = element("span", "adjacent styled span");
      node.style.color = "red";
      return node;
    }
    if (kind === "image") {
      const node = element("img");
      node.alt = "adjacent synthetic image";
      return node;
    }
    if (kind === "noneditable") {
      const node = element("span", "adjacent non-editable node");
      node.contentEditable = "false";
      return node;
    }
    const node = element("ul");
    const item = element("li", "outer adjacent item ");
    const inner = element("ul");
    inner.append(element("li", "nested adjacent item"));
    item.append(inner);
    node.append(item);
    return node;
  };
  const adjacency = [];
  for (const kind of ["link", "styled", "comment", "image", "noneditable", "nested-structure"]) {
    for (const position of ["before", "after"]) {
      const paragraph = element("p");
      const target = document.createTextNode("TARGET");
      const root = adjacencyRoot(kind);
      if (position === "before") paragraph.append(target, root);
      else paragraph.append(root, target);
      adjacency.push(Object.freeze({ kind, position, paragraph, target, root }));
    }
  }

  document.body.replaceChildren(
    supported,
    second,
    third,
    semanticAttribute,
    unsupported,
    table,
    signature,
    citePrefix,
    quote,
    forward,
    nestedList,
    listInParagraph,
    paragraphInList,
    ambiguousNeutral,
    topStrong,
    topItem,
    topBreak,
    ...adjacency.map((item) => item.paragraph),
  );
  globalThis.ThunderClawR0Fixture = Object.freeze({
    privateComment,
    semanticAttribute,
    styled,
    link,
    nonEditable,
    image,
    table,
    signature,
    citePrefix,
    quote,
    forward,
    nestedList,
    listInParagraph,
    paragraphInList,
    ambiguousNeutral,
    topStrong,
    topItem,
    topBreak,
    adjacency: Object.freeze(adjacency),
  });
  document.body.focus();
})();
