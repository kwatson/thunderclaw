import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("hosted OpenClaw qualification is pinned, secretless, and ephemeral", async () => {
  const script = await readFile(new URL("../scripts/run-openclaw-ci.sh", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../scripts/bootstrap-spike.sh", import.meta.url), "utf8");
  const compose = await readFile(new URL("../compose.spike.yaml", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.match(script, /ghcr\.io\/openclaw\/openclaw:2026\.8\.1@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4/u);
  assert.match(script, /--auth-choice skip/u);
  assert.match(script, /--suppress-gateway-token-output/u);
  assert.match(script, /dst=\/workspace\/thunderclaw,readonly/u);
  assert.match(script, /src=\$\{cache_root\},dst=\/home\/node\/\.cache/u);
  assert.match(script, /--publish 127\.0\.0\.1::18789/u);
  assert.match(script, /--security-opt no-new-privileges:true/u);
  assert.match(script, /--cap-drop ALL/u);
  assert.match(script, /npm run qualify:pairing -- --no-install/u);
  assert.match(script, /npm run qualify:pairing:recovery/u);
  assert.doesNotMatch(script, /\.env\.openclaw/u);
  assert.match(script, /THUNDERCLAW_OPENCLAW_PLUGIN_TGZ/u);
  assert.match(script, /validate-candidate-artifact\.mjs plugin-tgz/u);
  assert.match(script, /npm-pack:\/workspace\/thunderclaw-candidate\.tgz/u);
  assert.match(script, /plugins install --force --accept-capabilities/u);
  assert.match(script, /cmp -s "\$\{candidate\}"/u);
  assert.doesNotMatch(script, /package-openclaw-plugin|npm run pack:plugin/u);

  assert.match(bootstrap, /THUNDERCLAW_COMPOSE_USER="\$\{THUNDERCLAW_COMPOSE_USER:-\$\(id -u\):\$\(id -g\)\}"/u);
  assert.match(bootstrap, /mkdir -p \.spike\/thunderclaw-openclaw-cache/u);
  assert.match(bootstrap, /mkdir -p \.spike\/evidence/u);
  assert.match(compose, /user: "\$\{THUNDERCLAW_COMPOSE_USER:-1000:1000\}"/u);
  assert.match(compose, /\.\/\.spike\/thunderclaw-openclaw-cache:\/home\/node\/\.cache/u);
  assert.match(compose, /NPM_CONFIG_CACHE: \/home\/node\/\.cache\/npm/u);

  assert.match(workflow, /openclaw-integration:/u);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /npm run test:integration:openclaw/u);
});
