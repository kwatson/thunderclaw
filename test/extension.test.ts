import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Thunderbird extension declares compose and message-view boundaries", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packages/thunderbird-extension/src/manifest.json", import.meta.url), "utf8"));
  const repositoryPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const repositoryLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const extensionPackage = JSON.parse(await readFile(new URL("../packages/thunderbird-extension/package.json", import.meta.url), "utf8"));
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.equal(repositoryPackage.version, undefined);
  assert.equal(extensionPackage.version, repositoryLock.packages["packages/thunderbird-extension"].version);
  assert.equal(extensionPackage.version, manifest.version);
  assert.equal(manifest.browser_specific_settings.gecko.id, "thunderclaw@addons.thunderbird.net");
  assert.deepEqual(manifest.permissions.sort(), ["compose", "messagesRead", "scripting", "sensitiveDataUpload", "storage"]);
  assert.deepEqual(manifest.optional_permissions, ["https://*/*", "http://127.0.0.1/*", "http://[::1]/*"]);
  assert.equal(manifest.permissions.some((value: string) => /^(?:https?|\*):/u.test(value)), false);
  assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
  assert.equal(manifest.compose_action.default_popup, "popup.html");
  assert.equal(manifest.message_display_action.default_popup, "message-popup.html");
  assert.equal(manifest.compose_scripts, undefined, "Thunderbird 128 requires programmatic compose-script registration");
});

test("standalone UI discloses its provider and persistent credential boundary", async () => {
  const read = (name: string) => readFile(new URL(`../packages/thunderbird-extension/src/${name}`, import.meta.url), "utf8");
  const [compose, message, options, entry] = await Promise.all([read("popup.html"), read("message-popup.html"), read("options.html"), read("background-entry.ts")]);
  assert.doesNotMatch(compose + message + options, /configured OpenClaw agent|Start pairing|Finish pairing/u);
  assert.match(compose + message + options, /provider|endpoint/iu);
  assert.match(options, /API key/iu);
  assert.match(options, /local|device/iu);
  assert.match(entry, /installInferenceConnectionController/u);
  assert.doesNotMatch(entry, /installOptionsConnectionController/u);
});

test("settings explain response caps and the limits of thinking-level support", async () => {
  const options = await readFile(new URL("../packages/thunderbird-extension/src/options.html", import.meta.url), "utf8");
  assert.match(options, /<input id="max-response-tokens" type="number" min="1" max="131072" step="1" value="16384" required aria-describedby="response-token-help">/u);
  assert.match(options, /Response token limit/u);
  assert.match(options, /actual usage, not unused tokens/u);
  assert.match(options, /Reasoning tokens may count/u);
  assert.match(options, /model may have a lower maximum/u);
  assert.match(options, /Thinking level<\/label><select id="thinking"/u);
  assert.match(options, /some models cannot turn thinking off/u);
  assert.match(options, /does not prove the exact thinking level was respected/u);
  assert.match(options, /lists IDs, not supported thinking levels/u);
});

test("message-view translation mutates only captured text nodes and remains reversible", async () => {
  const background = await readFile(new URL("../packages/thunderbird-extension/src/background-coordinator.ts", import.meta.url), "utf8");
  const display = await readFile(new URL("../packages/thunderbird-extension/src/message-display.js", import.meta.url), "utf8");
  const markup = await readFile(new URL("../packages/thunderbird-extension/src/message-popup.html", import.meta.url), "utf8");
  const popup = await readFile(new URL("../packages/thunderbird-extension/src/message-popup.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../packages/thunderbird-extension/src/popup.css", import.meta.url), "utf8");
  assert.match(background, /scripting\.messageDisplay\.registerScripts/u);
  assert.match(background, /messageDisplay\.getDisplayedMessage/u);
  assert.match(background, /i18n\.getAcceptLanguages/u);
  assert.match(background, /i18n\.getUILanguage/u);
  assert.match(background, /i18n\.detectLanguage/u);
  assert.match(display, /NodeFilter\.SHOW_TEXT/u);
  assert.match(display, /record\.node\.nodeValue = record\.translated/u);
  assert.match(display, /record\.node\.nodeValue = record\.original/u);
  assert.match(display, /attachShadow\(\{ mode: "closed" \}\)/u);
  assert.match(display, /\.textContent = bullet/u);
  assert.doesNotMatch(display, /innerHTML/u);
  assert.match(popup, /messagePopup\.original/u);
  assert.match(popup, /messagePopup\.translation/u);
  assert.match(markup, /id="target-caption">Summary language</u);
  assert.match(popup, /targetCaption\.textContent = translating \? "Translate to" : "Summary language"/u);
  assert.match(styles, /\[hidden\] \{ display: none !important; \}/u);
});

test("extension applies only a stored suggestion after draft and target revalidation", async () => {
  const background = await readFile(new URL("../packages/thunderbird-extension/src/background-coordinator.ts", import.meta.url), "utf8");
  const compose = await readFile(new URL("../packages/thunderbird-extension/src/compose.js", import.meta.url), "utf8");
  const popup = await readFile(new URL("../packages/thunderbird-extension/src/popup.js", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../packages/thunderbird-extension/src/preview-renderer.js", import.meta.url), "utf8");
  assert.match(background, /contextHash !== suggestion\.contextHash \|\| targetHash !== suggestion\.targetHash/u);
  assert.match(background, /suggestions\.get\(suggestionId\)/u);
  assert.match(compose, /target\.range\.toString\(\) !== expectedText/u);
  assert.match(compose, /document\.execCommand\("insertText", false, replacement\)/u);
  assert.match(compose, /document\.execCommand\("insertHTML", false, container\.innerHTML\)/u);
  assert.match(compose, /completePlainListSelection\(range\)/u);
  assert.match(compose, /exactBodyWrapperPlainListSelection\(range\) \?\? completePlainListSelection\(range\)/u,
    "normal whole-list selection is recognized only as one exact direct BODY child before the natural text-edge fallback");
  assert.match(compose, /range\.startContainer !== document\.body \|\| range\.endContainer !== document\.body/u);
  assert.match(compose, /range\.endOffset !== range\.startOffset \+ 1/u);
  assert.match(compose, /target && target\.elements\.length >= 2/u);
  assert.match(compose, /exactReopenedDraftWhitespaceProfile/u,
    "reopened Draft support uses a separately named, exact whitespace profile");
  assert.match(compose, /nodes\.length !== items\.length \* 2 \+ 1/u);
  assert.match(compose, /node\.nodeType !== Node\.TEXT_NODE \|\| node\.data\.length === 0 \|\| !\/\^\[\\t\\n\\r \]\+\$\/u\.test\(node\.data\)/u,
    "the profile admits only non-empty ASCII HTML whitespace text nodes in exact alternating positions");
  assert.match(compose, /else if \(node !== items\[\(index - 1\) \/ 2\]\) return undefined/u,
    "the whitespace profile positionally binds every direct LI and rejects comments or other nodes");
  assert.match(compose, /Whole-list editing requires Thunderbird 153 or newer/u);
  assert.match(compose, /operationType !== "replace_flat_list_items"/u);
  assert.match(compose, /operationType !== "replace_rich_blocks"/u);
  assert.match(compose, /completeRichBlockSelection\(range\)/u);
  assert.match(compose, /supportedRichBodyTextRun\(roots\)/u,
    "complete Body Text selections are promoted to typed rich blocks instead of newline-only text replacements");
  assert.match(compose, /root\.parentNode !== document\.body/u,
    "Body Text promotion is confined to direct compose-body inline roots");
  assert.match(compose, /supportedRichBoundaryBreak\(before\)[\s\S]*supportedRichBoundaryBreak\(after\)/u,
    "Body Text promotion requires exact visual-paragraph BR boundaries");
  assert.match(compose, /node\.attributes\.length === 0 \|\| exactEmptyMozDirty\(node\)/u,
    "Body Text boundaries admit only attribute-free or exact empty browser-owned marker profiles");
  assert.match(compose, /buildRichContainer\(blocks\)/u);
  assert.match(compose, /selectExactRichRoots\(target\)/u,
    "rich Apply structurally selects the captured wrappers so one paragraph can expand to multiple blocks without leaving an empty shell");
  assert.match(compose, /range\.setStart\(document\.body, start\); range\.setEnd\(document\.body, end \+ 1\)/u,
    "wrapper selection is confined to the exact contiguous direct-body roots captured before generation");
  assert.match(compose, /exactAppliedRich\(target, blocks\)/u);
  assert.match(compose, /document\.createElement\(mark === "bold" \? "b" : mark === "italic" \? "i" : "u"\)/u);
  assert.match(compose, /document\.createElement\(target\.listKind\)/u);
  assert.match(compose, /item\.append\(document\.createTextNode\(value\)\)/u);
  assert.match(compose, /exactEmptyMozDirty\(item\)/u);
  assert.match(compose, /childNodes\[0\] === record\.whitespaceProfile\.leading/u);
  assert.match(compose, /childNodes\.at\(-1\) === record\.whitespaceProfile\.trailing/u,
    "post-command verification preserves only the exact leading/trailing browser whitespace identities");
  assert.match(compose, /item\.namespaceURI === XHTML_NAMESPACE && item\.tagName === "LI"/u,
    "every post-command child is an XHTML LI in the authorized fragment");
  assert.match(compose, /LIST_ITEM_UNSAFE_CHARACTERS = \/\[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\]\//u);
  assert.match(compose, /restoreSelectionState\(record\.target\.preSelection\)/u);
  assert.doesNotMatch(compose, /replacementItems\.join\([^)]*\).*innerHTML|innerHTML\s*=\s*replacement/isu);
  assert.match(compose, /document\.execCommand\("undo"\)/u);
  assert.match(compose, /document\.body\.innerHTML !== record\.expectedBodyHtml/u);
  assert.match(compose, /Quoted history and signatures are context only/u);
  assert.match(compose, /quotedText/u);
  assert.doesNotMatch(background, /browser\.compose\.sendMessage/u);
  assert.doesNotMatch(background, /browser\.messages\.delete/u);
  assert.doesNotMatch(background, /crypto\.randomUUID/u);
  assert.doesNotMatch(compose, /crypto\.randomUUID/u);
  assert.match(background, /randomId/u);
  assert.match(compose, /crypto\.getRandomValues/u);
  assert.match(background, /const jobs = new Map</u);
  assert.match(background, /const undos = new Map</u);
  assert.match(background, /browser\.runtime\.getBrowserInfo\(\)/u);
  assert.match(background, /minimumSameKindListThunderbirdMajor = 153/u);
  assert.match(background, /flatListItemReplacement !== true/u);
  assert.match(background, /richBlockReplacement !== true/u);
  assert.match(background, /composeStateFingerprint/u);
  assert.match(background, /browser\.compose\.listAttachments/u);
  assert.match(background, /postGenerationState\.identity !== composeState\.identity/u);
  assert.ok(background.indexOf("await composeMessage(tabId, { type: \"thunderclaw.capture\" })")
    < background.indexOf("const lease = await controller.acquireFeatureLease();"),
  "compose eligibility must be captured before acquiring a network-capable feature lease");
  assert.match(background, /popup\.job/u);
  assert.match(background, /popup\.undo/u);
  assert.match(background, /undoId: result\.undoId/u);
  assert.match(background, /\["running", "ready", "applied"\]\.includes/u);
  assert.match(popup, /state\.job/u);
  assert.match(popup, /Undo change/u);
  assert.match(popup, /Start over/u);
  assert.match(popup, /ThunderClawPreview\.render\(elements\.replacement, result, view\)/u);
  assert.match(renderer, /document\.createElement\("li"\)/u);
  assert.match(renderer, /result\.selectionShape === "rich-blocks"/u);
  assert.match(renderer, /document\.createTextNode\(span\.text\)/u);
  assert.doesNotMatch(renderer, /innerHTML/u);
  assert.match(popup, /sendMessage\(\{ type: "popup\.apply", tabId, suggestionId, jobId: activeJobId \}\)/u,
    "Apply sends only background-owned suggestion identity, never preview items");
  assert.match(popup, /window\.close\(\)/u);
  assert.match(background, /cancelComposeJob\(message\.tabId\).*captures\.delete\(message\.tabId\)/u);
  assert.match(compose, /const undos = new Map\(\)/u);
  assert.doesNotMatch(compose, /thunderclaw-start/u);
  assert.match(popup, /popup\.cancel/u);
});
