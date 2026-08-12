import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, "../../..");
const source = path.join(root, "source");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const background = await readFile(path.join(source, "background.js"), "utf8");
const compose = await readFile(path.join(source, "compose.js"), "utf8");
const popup = await readFile(path.join(source, "popup.js"), "utf8");
const popupHtml = await readFile(path.join(source, "popup.html"), "utf8");
const popupCss = await readFile(path.join(source, "popup.css"), "utf8");
const fixtureSetup = await readFile(path.join(root, "fixture-setup.js"), "utf8");
const builder = await readFile(path.join(root, "build.mjs"), "utf8");
const liveDriver = await readFile(path.join(root, "live-thunderbird.py"), "utf8");

assert.equal(manifest.manifest_version, 2);
assert.equal(manifest.name, "ThunderClaw Rich Compose R0 Spike");
assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
assert.deepEqual(manifest.permissions, ["compose"]);
assert.equal(manifest.optional_permissions, undefined);
assert.deepEqual(manifest.background, { scripts: ["background.js"] });
assert.equal(manifest.compose_scripts, undefined);
assert.equal(manifest.compose_action.default_popup, "popup.html");

for (const sourceText of [background, compose, popup, popupHtml, popupCss, JSON.stringify(manifest)]) {
  assert.doesNotMatch(sourceText, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendNativeMessage|nativeMessaging/iu);
  assert.doesNotMatch(sourceText, /https?:\/\//iu);
  assert.doesNotMatch(sourceText, /\b(?:eval|Function)\s*\(/u);
  assert.doesNotMatch(sourceText, /browser\.(?:runtime\.connectNative|permissions\.(?:request|contains)|proxy\.|webRequest\.)/u);
}
assert.match(background, /browser\.composeScripts\.register\(\{ js: \[\{ file: "compose\.js" \}\] \}\)/u);
assert.match(background, /ThunderClaw R0 compose registration ready:/u);
assert.match(background, /browser\.runtime\.getBrowserInfo\(\)/u);
assert.match(background, /browser\.runtime\.onMessage\.addListener/u);
assert.match(background, /sender\?\.id !== browser\.runtime\.id/u);
assert.match(background, /minimumThunderbirdMajor: SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR/u);
assert.match(background, /sameKindListEligible: Number\.isSafeInteger\(major\)/u);
assert.match(background, /\^\(\[1-9\]\\d\*\)\(\?:\\\.\\d\+\)\{1,3\}\(\?:esr\)\?\$/u);
assert.doesNotMatch(background, /setInterval|setTimeout/u);
assert.doesNotMatch(fixtureSetup, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|innerHTML/iu);
assert.match(fixtureSetup, /const privateComment = document\.createComment\("thunderclaw-r0-private-marker"\)/u);
assert.match(fixtureSetup, /semanticAttribute\.dataset\.private = "synthetic"/u);
assert.match(fixtureSetup, /nonEditable\.contentEditable = "false"/u);
assert.match(fixtureSetup, /document\.body\.replaceChildren/u);
assert.match(fixtureSetup, /nestedOuterItem\.append\(nestedInnerList\)/u);
assert.match(fixtureSetup, /listInParagraph\.append\(paragraphList\)/u);
assert.match(fixtureSetup, /paragraphItem\.append\(element\("p", "paragraph in list item"\)\)/u);
assert.match(fixtureSetup, /ambiguousNeutral\.append\(element\("p", "nested block one"\), element\("p", "nested block two"\)\)/u);
assert.match(fixtureSetup, /topStrong/u);
assert.match(fixtureSetup, /topItem/u);
assert.match(fixtureSetup, /topBreak/u);
assert.match(fixtureSetup, /globalThis\.ThunderClawR0Fixture = Object\.freeze/u);
assert.match(builder, /This is Zip 3\\\.0 \\\(July 5th 2008\\\)/u);

assert.match(compose, /document\.execCommand\("insertHTML", false, generated\.safeHtml\)/u);
assert.equal((compose.match(/document\.execCommand\("insertHTML"/gu) ?? []).length, 1);
assert.equal((compose.match(/document\.execCommand\("undo"\)/gu) ?? []).length, 2);
assert.equal((compose.match(/document\.execCommand\("redo"\)/gu) ?? []).length, 1);
assert.match(compose, /document\.createDocumentFragment\(\)/u);
assert.match(compose, /document\.createElement\("b"\)/u);
assert.match(compose, /document\.createElement\("i"\)/u);
assert.match(compose, /document\.createElement\("u"\)/u);
assert.match(compose, /document\.createElement\("br"\)/u);
assert.match(compose, /document\.createElement\("ol"\)/u);
assert.match(compose, /document\.createElement\("ul"\)/u);
assert.match(compose, /document\.createElement\("li"\)/u);
assert.doesNotMatch(compose, /\.setAttribute\s*\(|\.style\b|insertAdjacentHTML|DOMParser/u);
assert.doesNotMatch(compose, /message\.(?:html|safeHtml)|innerHTML\s*=\s*message/u);
assert.match(compose, /validateInlineFragment\(range\.cloneContents\(\), reasons\)/u);
assert.match(compose, /validateBodyBlock\(node, reasons\)/u);
assert.match(compose, /paragraph-container-is-not-direct-body-child/u);
assert.match(compose, /const scanInline = \(parent\) =>/u);
assert.match(compose, /list-child-is-not-plain-li:/u);
assert.match(compose, /block-or-list-in-inline-context:/u);
assert.match(compose, /unsupported-top-level-element:/u);
assert.match(compose, /classifyPlacement\(range\)/u);
assert.match(compose, /inlineMode: "direct_body_text"/u);
assert.match(compose, /range\.startContainer\.parentNode !== document\.body/u);
assert.match(compose, /OBSERVED_MOZ_DIRTY_ELEMENTS = new Set\(\["P", "UL", "OL", "LI", "BR", "U"\]\)/u);
assert.match(compose, /XHTML_NAMESPACE = "http:" \+ "\/\/www\.w3\.org\/1999\/xhtml"/u);
assert.match(compose, /function hasObservedThunderbirdAttributes\(element\)/u);
assert.match(compose, /function hasExactEmptyMozDirtyAttribute\(element\)/u);
assert.match(compose, /attribute\.namespaceURI === null/u);
assert.match(compose, /attribute\.prefix === null/u);
assert.match(compose, /attribute\.localName === "_moz_dirty"/u);
assert.match(compose, /attribute\.name === "_moz_dirty"/u);
assert.match(compose, /function supportedListWrapper\(element\)/u);
assert.match(compose, /function supportedListItem\(element\)/u);
assert.match(compose, /function supportedInlineParagraphWrapper\(element\)/u);
assert.match(compose, /const container = inlineContainer\(range\.startContainer\)/u);
assert.match(compose, /container !== inlineContainer\(range\.endContainer\)/u);
assert.match(compose, /presetMatchesPlacement\(preset, record\.classification\.placement\)/u);
assert.match(compose, /function canonicalDomState\(node, typedSlot\)/u);
assert.match(compose, /attribute\.namespaceURI \?\? null/u);
assert.match(compose, /kind: "target-slot"/u);
assert.match(compose, /function pureSha256\(bytes\)/u);
assert.match(compose, /e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/u);
assert.match(compose, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/u);
assert.match(compose, /globalThis\.crypto\.subtle\.digest\("SHA-256", bytes\)/u);
assert.match(compose, /WebCrypto and local SHA-256 disagree/u);
assert.match(compose, /observedEditorDecoration/u);
assert.match(compose, /\["B", "I", "U", "BR"\]\.includes\(node\.tagName\)/u);
assert.match(compose, /verificationFailedAt = "fixture-shape"/u);
assert.match(compose, /function firstCanonicalMismatch\(expected, actual, path = \[\]\)/u);
assert.match(compose, /verificationFailureDetail/u);
assert.match(compose, /function fixtureShape\(preset, tokens\)/u);
assert.match(compose, /reason: "token-occurrences"/u);
assert.match(compose, /node\.namespaceURI !== XHTML_NAMESPACE/u);
assert.match(compose, /!\["p", "br", "b", "i", "u", "ol", "ul", "li"\]\.includes\(name\)/u);
assert.match(compose, /requireElement\("UNDERLINE", "u"\)/u);
assert.match(compose, /requireElement\("BOLD_UNDERLINE", "u", \["b"\]\)/u);
assert.match(compose, /requireElement\("ITALIC_UNDERLINE", "u", \["i"\]\)/u);
assert.match(compose, /requireElement\("COMBINED_UNDERLINE", "u", \["i", "b"\]\)/u);
assert.doesNotMatch(compose, /STRONG: "strong"|EM: "em"|P: "block"|DIV: "block"/u);
assert.match(compose, /removeIfSyntheticEmptyText/u);
assert.match(compose, /originalCloneNodes = new Set\(cloneMap\.values\(\)\)/u);
assert.match(compose, /sameMaskedReferencePaths\(record\.references, masked\.trackedPaths\)/u);
assert.match(compose, /expectedRevision: postRevision/u);
assert.match(compose, /assertRevisionAndState\(record, validUndoState\)/u);
assert.match(compose, /noUndoResult\?\.restored \? noUndoResult : rollback\(record\)/u);
assert.match(compose, /syncEditorRevision\(\) !== record\.editorRevision/u);
assert.match(compose, /currentSelectionStateMatches\(record\.originalSelectionState\)/u);
assert.match(compose, /restoreSelectionState\(record\.preSelectionState\)/u);
assert.match(compose, /selection\.setBaseAndExtent\(anchor/u);
assert.match(compose, /exactReferenceRecords\(record\.references\.preTarget \?\? \[\]\)/u);
assert.match(compose, /exactReferenceRecords\(expectedReferences\.emptyText\)/u);
assert.match(compose, /latestCaptureWholeListTargeted, latestCaptureSameKindListEligible/u);
assert.match(compose, /latestCaptureWholeListTargeted = false/u);
assert.match(compose, /latestCaptureSameKindListEligible = false/u);
assert.match(compose, /R0_AUTOMATION_BUILD_ID = "thunderclaw-rich-compose-r0@example\.invalid:0\.0\.1"/u);
assert.match(compose, /\["ping", "capture", "apply", "undo", "redo", "verify"\]\.includes\(request\.operation\)/u);
assert.match(compose, /request\.buildId !== R0_AUTOMATION_BUILD_ID/u);
assert.match(compose, /request\.operation === "ping" \? \{ ok: true, value: \{ ready: true \} \}/u);
assert.match(compose, /await handleMessage\(\{ type: `rich-compose-r0\.\$\{request\.operation\}`/u);
assert.match(compose, /!\["inline", "blocks"\]\.includes\(extra\.preset\)/u);
assert.doesNotMatch(compose, /\["capture", "apply", "undo", "redo", "inspect"\]/u);
assert.doesNotMatch(compose, /GetCurrentEditor|beginTransaction|endTransaction|deleteSelection|removeList/u);
assert.match(compose, /response\.buildId = R0_AUTOMATION_BUILD_ID/u);
assert.doesNotMatch(compose, /thunderclawR0AutomationReady/u);
assert.doesNotMatch(compose, /AutomationReady|automation-ready/u);
assert.match(liveDriver, /automation\(client, "ping", timeout=0\.5\)/u);
assert.match(liveDriver, /json\.dumps\(\{"buildId": AUTOMATION_BUILD_ID, "operation": operation/u);
assert.match(liveDriver, /value\.pop\("buildId", None\) != AUTOMATION_BUILD_ID/u);
assert.match(liveDriver, /ThreadingTCPServer\(\("127\.0\.0\.1", 0\), _SMTPHandler\)/u);
assert.match(liveDriver, /upper\.startswith\(\(b"EHLO ", b"HELO "\)\)/u);
assert.match(liveDriver, /byte_count > 10485760/u);
assert.match(liveDriver, /message\["envelopeFrom"\] != "<author@e2e\.invalid>"/u);
assert.match(liveDriver, /for key in \("to", "cc", "bcc"\)/u);
assert.match(liveDriver, /getControllerForCommand\("cmd_sendNow"\)/u);
assert.match(liveDriver, /sink\.server\.messages\.get_nowait\(\)/u);
assert.match(liveDriver, /b"\\x00ThunderClaw R0 deterministic attachment\\r\\n\\xff"/u);
assert.match(liveDriver, /b"thunderclaw-r0-automation" in smtp_data\.lower\(\)/u);
assert.doesNotMatch(liveDriver, /0\.0\.0\.0|::|starttls|AUTH LOGIN/iu);
assert.match(compose, /if \(!restored\) richApplyDisabled = true/u);
assert.match(compose, /editorMode\?\.isPlainText !== false/u);
assert.match(compose, /\["auto", "both", "html"\]\.includes\(editorMode\.deliveryFormat\)/u);
assert.equal((compose.match(/\.innerHTML/gu) ?? []).length, 1, "only local fixture serialization may use innerHTML");
assert.doesNotMatch(compose, /outerHTML|fnv1a|preBodyHtml|postBodyHtml/u);
assert.match(compose, /function promotedFullList\(range\)/u);
assert.match(compose, /function exactBodyWrapperList\(range\)/u);
assert.match(compose, /range\.startContainer !== document\.body \|\| range\.endContainer !== document\.body/u);
assert.match(compose, /range\.endOffset !== range\.startOffset \+ 1/u);
assert.match(compose, /list\.parentNode !== document\.body \|\| list\.childNodes\.length < 2/u);
assert.match(compose, /validateListBlock\(list, reasons\)/u);
assert.match(compose, /exactBodyWrapperList\(range\) \?\? promotedFullList\(range\)/u,
  "exact BODY-wrapper recognition remains separate from generic block classification");
assert.match(compose, /listTarget: promotion\?\.list/u);
assert.match(compose, /const list = classified\.listTarget/u);
assert.match(compose, /range: selectedRange,/u,
  "the original natural or BODY wrapper Range remains the actual same-kind editor-command Range");
assert.match(compose, /verificationRange\.setStartBefore\(list\.firstElementChild\)/u);
assert.match(compose, /verificationRange\.setEndAfter\(list\.lastElementChild\)/u);
assert.match(compose, /\.moz-forward-container/u);
assert.match(compose, /span\[_moz_quote/u);
assert.match(compose, /\.moz-signature/u);
assert.match(compose, /blockquote\[type=/u);
assert.match(compose, /\[contenteditable=/u);
assert.match(compose, /a,img,table/u);
assert.match(popup, /browser\.compose\.getComposeDetails\(tabId\)/u);
assert.match(popup, /isPlainText: details\.isPlainText/u);
assert.match(popup, /deliveryFormat:/u);
for (const [id, preset] of [["list-rewrite", "same-kind-list-rewrite"], ["list-add", "same-kind-list-add"],
  ["list-remove", "same-kind-list-remove"], ["list-reorder", "same-kind-list-reorder"]]) {
  assert.match(popupHtml, new RegExp(`id="${id}"[^>]* disabled`, "u"));
  assert.match(popup, new RegExp(`apply\\("${preset}", false, composeDetails\\)`, "u"));
}
assert.match(popup, /captureWholeListTargeted = value\.wholeListTargeted === true/u);
assert.match(popup, /captureSameKindListEligible = value\.sameKindListEligible === true/u);
assert.match(popup, /captureWholeListTargeted = state\.latestCaptureWholeListTargeted === true/u);
assert.match(popup, /captureSameKindListEligible = state\.latestCaptureSameKindListEligible === true/u);
assert.match(popup, /capturePlacement !== "blocks" \|\| captureWholeListTargeted/u,
  "legacy mixed-block diagnostic must be disabled for whole-list captures");
assert.match(popup, /!captureWholeListTargeted \|\| !captureSameKindListEligible/u,
  "whole-list buttons require both exact capture flags and cannot infer support from block placement");
assert.match(popupHtml, /Diagnostic: mixed block fixture \(not whole-list support\)/u);
assert.match(popupHtml, /unsupported negative diagnostic/u);
assert.match(popupHtml, /Induce postcondition failure/u);
assert.match(popupHtml, /Verify Ctrl\+Z result/u);
assert.match(popupHtml, /Verify Ctrl\+Y result/u);

const { assertAllowedSourceFiles, buildRichComposeSpike } = await import(pathToFileURL(path.join(root, "build.mjs")));
const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-rich-compose-r0-"));
try {
  for (const file of ["background.js", "compose.js", "manifest.json", "popup.css", "popup.html", "popup.js"]) {
    await symlink(path.join(source, file), path.join(symlinkRoot, file));
  }
  await assert.rejects(assertAllowedSourceFiles(symlinkRoot), /regular non-symlink/u);
} finally {
  await rm(symlinkRoot, { recursive: true, force: true });
}

const xpi = await buildRichComposeSpike();
const names = execFileSync("unzip", ["-Z1", xpi], { encoding: "utf8" }).trim().split("\n").sort();
assert.deepEqual(names, ["background.js", "compose.js", "manifest.json", "popup.css", "popup.html", "popup.js"]);
for (const name of names) {
  assert.doesNotMatch(name, /(?:^|\/)\.\.|^\/|\\/u);
}
const archiveManifest = JSON.parse(execFileSync("unzip", ["-p", xpi, "manifest.json"], { encoding: "utf8" }));
assert.deepEqual(archiveManifest, manifest);
for (const name of names) {
  const archived = execFileSync("unzip", ["-p", xpi, name]);
  assert.deepEqual(archived, await readFile(path.join(source, name)), `archive/source mismatch for ${name}`);
}
const archiveModes = execFileSync("zipinfo", ["-l", xpi], { encoding: "utf8" })
  .split("\n")
  .filter((line) => /^-/u.test(line));
assert.equal(archiveModes.length, names.length);
for (const line of archiveModes) assert.match(line, /^-rw-r--r--\s/u);
const firstHash = createHash("sha256").update(await readFile(xpi)).digest("hex");
await buildRichComposeSpike();
const secondHash = createHash("sha256").update(await readFile(xpi)).digest("hex");
assert.equal(firstHash, secondHash);

process.stdout.write(`rich-compose R0 checks passed\nXPI: ${xpi}\nSHA-256: ${secondHash}\n`);
