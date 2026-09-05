import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("hosted OpenClaw qualification is pinned, secretless, and ephemeral", async () => {
  const script = await readFile(new URL("../scripts/run-openclaw-ci.sh", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../scripts/bootstrap-spike.sh", import.meta.url), "utf8");
  const spikeConfig = JSON.parse(
    await readFile(new URL("../scripts/spike-plugin-config.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const pluginManifest = JSON.parse(
    await readFile(new URL("../packages/openclaw-plugin/openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: { additionalProperties: boolean; properties: Record<string, unknown> } };
  const compose = await readFile(new URL("../compose.spike.yaml", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.match(script, /ghcr\.io\/openclaw\/openclaw:2026\.9\.2@sha256:a8604855b76cd613cbaa45d6db093dc017b09a2faea5dc9cee023fb7ac262250/u);
  assert.match(script, /--auth-choice deepseek-api-key/u);
  assert.match(script, /--secret-input-mode ref/u);
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
  assert.match(
    script,
    /plugins install \\\n+    @openclaw\/deepseek-provider@2026\.9\.2 --force --pin --accept-capabilities[\s\S]*node openclaw\.mjs onboard/u,
  );
  assert.match(script, /plugins\.entries\.thunderclaw\.config/u);
  assert.match(script, /spike-plugin-config\.json/u);
  assert.match(script, /agents add deepseek-flash/u);
  assert.match(script, /--workspace \/home\/node\/\.openclaw\/workspace/u);
  assert.match(script, /--model deepseek\/deepseek-v4-flash/u);
  assert.match(script, /cmp -s "\$\{candidate\}"/u);
  assert.doesNotMatch(script, /package-openclaw-plugin|npm run pack:plugin/u);

  assert.match(bootstrap, /THUNDERCLAW_COMPOSE_USER="\$\{THUNDERCLAW_COMPOSE_USER:-\$\(id -u\):\$\(id -g\)\}"/u);
  assert.match(bootstrap, /candidate_mount_path=\/tmp\/thunderclaw-qualification-candidate\.tgz/u);
  assert.match(bootstrap, /--volume "\$\{candidate\}:\$\{candidate_mount_path\}:ro"/u);
  assert.match(bootstrap, /mkdir -p \.spike\/thunderclaw-openclaw-cache/u);
  assert.match(bootstrap, /mkdir -p \.spike\/evidence/u);
  assert.match(
    bootstrap,
    /plugins install \\\n  @openclaw\/deepseek-provider@2026\.9\.2 --force --pin --accept-capabilities[\s\S]*node openclaw\.mjs onboard/u,
  );
  assert.match(bootstrap, /spike-plugin-config\.json/u);
  assert.match(bootstrap, /agents list --json/u);
  assert.match(bootstrap, /agent\.id === "deepseek-flash"[\s\S]*agent\.model === "deepseek\/deepseek-v4-flash"/u);
  assert.match(bootstrap, /agents add deepseek-flash/u);
  assert.match(bootstrap, /--workspace \/home\/node\/\.openclaw\/workspace/u);
  assert.match(bootstrap, /--model deepseek\/deepseek-v4-flash/u);
  assert.doesNotMatch(bootstrap, /THUNDERCLAW_PLUGIN_TOKEN|value:\s*\{\s*token/u);
  assert.equal(pluginManifest.configSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(spikeConfig).sort(),
    Object.keys(pluginManifest.configSchema.properties).sort(),
    "fresh-state bootstrap configuration must match the shipped plugin schema",
  );
  for (const [key, value] of Object.entries(spikeConfig)) {
    const property = pluginManifest.configSchema.properties[key] as {
      type?: string;
      minimum?: number;
      maximum?: number;
    };
    assert.equal(property.type, "integer", `${key} must remain an integer setting`);
    assert.equal(Number.isInteger(value), true, `${key} bootstrap value must be an integer`);
    assert.ok(Number(value) >= Number(property.minimum), `${key} bootstrap value is below its schema minimum`);
    assert.ok(Number(value) <= Number(property.maximum), `${key} bootstrap value is above its schema maximum`);
  }
  assert.match(compose, /user: "\$\{THUNDERCLAW_COMPOSE_USER:-1000:1000\}"/u);
  assert.match(compose, /\.\/\.spike\/thunderclaw-openclaw-cache:\/home\/node\/\.cache/u);
  assert.match(compose, /NPM_CONFIG_CACHE: \/home\/node\/\.cache\/npm/u);

  assert.match(workflow, /openclaw-integration:/u);
  assert.match(
    workflow,
    /if: needs\.checks\.outputs\.run_full == 'true' && \(github\.event_name != 'workflow_dispatch' \|\| inputs\.release_qualification == true\)/u,
  );
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /npm run test:integration:openclaw/u);
});
