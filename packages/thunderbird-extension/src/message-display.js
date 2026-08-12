(() => {
  if (globalThis.__thunderclawMessageDisplayLoaded) return;
  globalThis.__thunderclawMessageDisplayLoaded = true;

  const records = new Map();
  const displayInstanceId = (() => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  })();
  let translationVisible = false;
  let cardHost = null;

  function meaningfulTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (parent.closest("script, style, noscript, textarea, [data-thunderclaw-ui]")) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode() && nodes.length < 400) nodes.push(walker.currentNode);
    return nodes;
  }

  function capture() {
    if (records.size) {
      const segments = Array.from(records, ([id, record]) => ({ id, text: record.original }));
      return { displayInstanceId, segments, text: segments.map(({ text }) => text.trim()).filter(Boolean).join("\n\n") };
    }
    records.clear();
    const segments = meaningfulTextNodes().map((node, index) => {
      const id = `segment-${index}`;
      records.set(id, { node, original: node.nodeValue, translated: null });
      return { id, text: node.nodeValue };
    });
    return { displayInstanceId, segments, text: segments.map(({ text }) => text.trim()).filter(Boolean).join("\n\n") };
  }

  function requireDisplayInstance(candidate) {
    if (candidate !== displayInstanceId) throw new Error("The displayed message changed. Run ThunderClaw again.");
  }

  function applyTranslation(segments) {
    if (!Array.isArray(segments) || segments.length !== records.size) throw new Error("The displayed message changed. Generate the translation again.");
    for (const segment of segments) {
      const record = records.get(segment.id);
      if (!record || record.node.nodeValue !== record.original || typeof segment.text !== "string") {
        throw new Error("The displayed message changed. Generate the translation again.");
      }
    }
    for (const segment of segments) {
      const record = records.get(segment.id);
      const leading = record.original.match(/^\s*/u)?.[0] ?? "";
      const trailing = record.original.match(/\s*$/u)?.[0] ?? "";
      record.translated = `${leading}${segment.text.trim()}${trailing}`;
      record.node.nodeValue = record.translated;
    }
    translationVisible = true;
    return { translated: true };
  }

  function restore() {
    for (const record of records.values()) {
      if (record.node.isConnected && record.translated !== null && record.node.nodeValue === record.translated) {
        record.node.nodeValue = record.original;
      }
    }
    translationVisible = false;
    return { translated: false };
  }

  function showTranslation() {
    for (const record of records.values()) {
      if (record.node.isConnected && record.translated !== null && record.node.nodeValue === record.original) {
        record.node.nodeValue = record.translated;
      }
    }
    translationVisible = true;
    return { translated: true };
  }

  function dismissCard() {
    cardHost?.remove();
    cardHost = null;
  }

  function showSummary(summary, detectedLanguage) {
    dismissCard();
    cardHost = document.createElement("div");
    cardHost.dataset.thunderclawUi = "summary";
    const shadow = cardHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; display: block; }
      article { box-sizing: border-box; margin: 12px; padding: 14px 16px; border: 1px solid #93c5fd; border-radius: 8px; background: #eff6ff; color: #172554; font: 14px/1.45 system-ui, sans-serif; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      strong { font-size: 15px; } small { color: #475569; } ul { margin: 10px 0 0; padding-left: 22px; } li + li { margin-top: 5px; }
      button { border: 0; background: transparent; color: #1d4ed8; cursor: pointer; font: inherit; padding: 3px 5px; }
    `;
    const article = document.createElement("article");
    const header = document.createElement("header");
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = summary.title || "ThunderClaw summary";
    const meta = document.createElement("small");
    meta.textContent = detectedLanguage ? `ThunderClaw · ${detectedLanguage}` : "ThunderClaw";
    heading.append(title, document.createElement("br"), meta);
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", dismissCard);
    header.append(heading, dismiss);
    const list = document.createElement("ul");
    for (const bullet of summary.bullets) {
      const item = document.createElement("li");
      item.textContent = bullet;
      list.append(item);
    }
    article.append(header, list);
    shadow.append(style, article);
    document.body.prepend(cardHost);
    return { shown: true };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    try {
      if (message.type === "thunderclaw.message.capture") return Promise.resolve({ ok: true, value: capture() });
      if (message.type === "thunderclaw.message.translate") { requireDisplayInstance(message.displayInstanceId); return Promise.resolve({ ok: true, value: applyTranslation(message.segments) }); }
      if (message.type === "thunderclaw.message.original") { requireDisplayInstance(message.displayInstanceId); return Promise.resolve({ ok: true, value: restore() }); }
      if (message.type === "thunderclaw.message.showTranslation") { requireDisplayInstance(message.displayInstanceId); return Promise.resolve({ ok: true, value: showTranslation() }); }
      if (message.type === "thunderclaw.message.summary") { requireDisplayInstance(message.displayInstanceId); return Promise.resolve({ ok: true, value: showSummary(message.summary, message.detectedLanguage) }); }
      if (message.type === "thunderclaw.message.dismiss") {
        if (message.displayInstanceId !== undefined) requireDisplayInstance(message.displayInstanceId);
        restore();
        dismissCard();
        records.clear();
        return Promise.resolve({ ok: true, value: { dismissed: true } });
      }
    } catch (error) {
      return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : "ThunderClaw message operation failed." });
    }
    return undefined;
  });
})();
