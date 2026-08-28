import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("real Thunderbird E2E pins and isolates the supported version matrix", async () => {
  const script = await readFile(new URL("../scripts/run-thunderbird-e2e.sh", import.meta.url), "utf8");
  assert.match(script, /THUNDERCLAW_E2E_VERSIONS\+x/u);
  assert.match(script, /versions="128\.14\.0esr 153\.0\.3"/u);
  assert.match(script, /20f54bf73232e80e8716c219e05658c2dd519f15a262e98429fc4c875d2477ed052fb15cd8c31c9b731b447589b1fe99c49e9eb8e7fa71dac9e80c4c64e09f0d/u);
  assert.match(script, /f55659181b90776669f83959da3cb9ce7e9b150feb9ba4e7228e6ced5ad8fba81284b639f7b5b9ff71d552c87a6d8d1a0eb74fb6bca9af1b12a102a6bdb95d14/u);
  assert.match(script, /archive_extension=tar\.bz2/u);
  assert.match(script, /archive_extension=tar\.xz/u);
  assert.match(script, /--network=none/u);
  assert.match(script, /find "\$\{version_artifacts\}" -mindepth 1 -delete/u);
  assert.match(script, /pre-matrix runner/u);
  assert.match(script, /Unsupported pinned Thunderbird E2E version/u);
  assert.match(script, /THUNDERCLAW_E2E_XPI\+x/u);
  assert.match(script, /validate-candidate-artifact\.mjs xpi/u);
  assert.match(script, /cmp -s "\$\{candidate_xpi\}"/u);
  assert.doesNotMatch(script, /npm run(?: --silent)? build:extension/u);

  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: thunderclaw-ci-candidate/u);
  assert.match(workflow, /sha256sum --check thunderclaw-extension\.xpi\.sha256/u);
  assert.match(workflow, /THUNDERCLAW_E2E_XPI: \$\{\{ github\.workspace \}\}\/candidate\/thunderclaw-extension\.xpi/u);

  const driver = await readFile(new URL("../e2e/thunderbird/run_compose.py", import.meta.url), "utf8");
  assert.match(driver, /const consent = document\.querySelector\("#consent-accepted"\)/u);
  assert.match(driver, /consent\.checked = true/u);
  assert.match(driver, /consent\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/u);
  assert.match(driver, /if \(pair\.disabled\) return false/u);
});

test("Thunderbird upgrade qualification requires exact baseline and candidate XPIs", async () => {
  const script = await readFile(new URL("../scripts/run-thunderbird-upgrade-e2e.sh", import.meta.url), "utf8");
  assert.match(script, /THUNDERCLAW_UPGRADE_BASELINE_XPI/u);
  assert.match(script, /THUNDERCLAW_E2E_XPI/u);
  assert.match(script, /verify-counterpart-baseline\.mjs/u);
  assert.match(script, /validate-candidate-artifact\.mjs xpi/u);
  assert.doesNotMatch(script, /npm run(?: --silent)? build:extension/u);
});
