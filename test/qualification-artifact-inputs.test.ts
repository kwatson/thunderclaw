import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pairing qualification consumes an explicit validated plugin archive", async () => {
  const source = await readFile(new URL("../scripts/qualify-pairing.ts", import.meta.url), "utf8");
  assert.match(source, /THUNDERCLAW_OPENCLAW_PLUGIN_TGZ must name an existing candidate archive/u);
  assert.match(source, /validate-candidate-artifact\.mjs", "plugin-tgz"/u);
  assert.match(source, /verify-counterpart-baseline\.mjs/u);
  assert.doesNotMatch(source, /package-openclaw-plugin|npm run pack:plugin|npm pack/u);
});

test("real-agent qualification consumes explicit plugin and counterpart XPI bytes", async () => {
  const source = await readFile(new URL("../e2e/qualification/real-agent/run.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.env\.THUNDERCLAW_OPENCLAW_PLUGIN_TGZ/u);
  assert.match(source, /process\.env\.THUNDERCLAW_E2E_XPI/u);
  assert.match(source, /process\.env\.THUNDERCLAW_QUALIFICATION_COMPONENT/u);
  assert.match(source, /validate-candidate-artifact\.mjs", "plugin-tgz"/u);
  assert.match(source, /validate-candidate-artifact\.mjs", "xpi"/u);
  assert.match(source, /verify-counterpart-baseline\.mjs/u);
  assert.doesNotMatch(source, /npm.*build:extension|package-openclaw-plugin|thunderclaw-openclaw-plugin-0\.1/u);
});
