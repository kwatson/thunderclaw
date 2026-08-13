import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("real Thunderbird E2E pins and isolates the supported version matrix", async () => {
  const script = await readFile(new URL("../scripts/run-thunderbird-e2e.sh", import.meta.url), "utf8");
  assert.match(script, /THUNDERCLAW_E2E_VERSIONS\+x/u);
  assert.match(script, /versions="128\.14\.0esr 153\.0\.1esr"/u);
  assert.match(script, /20f54bf73232e80e8716c219e05658c2dd519f15a262e98429fc4c875d2477ed052fb15cd8c31c9b731b447589b1fe99c49e9eb8e7fa71dac9e80c4c64e09f0d/u);
  assert.match(script, /af36a161d132f78f69de572caf2df795d7518e4e70f83a378e37d2c834db901b227b663494602886ac58ab39afa289b63d091ca3a30a22cd1fcd552a139fc7cc/u);
  assert.match(script, /archive_extension=tar\.bz2/u);
  assert.match(script, /archive_extension=tar\.xz/u);
  assert.match(script, /--network=none/u);
  assert.match(script, /find "\$\{version_artifacts\}" -mindepth 1 -delete/u);
  assert.match(script, /pre-matrix runner/u);
  assert.match(script, /Unsupported pinned Thunderbird E2E version/u);
  assert.match(script, /THUNDERCLAW_E2E_XPI\+x/u);
  assert.match(script, /validate-candidate-artifact\.mjs xpi/u);
  assert.match(script, /cmp -s "\$\{candidate_xpi\}"/u);
  assert.doesNotMatch(script, /^mise exec -- npm run build:extension$/mu);
});
