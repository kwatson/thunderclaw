#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose -f compose.spike.yaml)

mkdir -p .spike/thunderclaw-openclaw .spike/thunderclaw-openclaw/workspace
mkdir -p .spike/thunderclaw-packages .spike/thunderclaw-packages/archive
package_path=.spike/thunderclaw-packages/thunderclaw-openclaw-plugin-0.1.0.tgz
if test -f "$package_path"; then
  mv "$package_path" ".spike/thunderclaw-packages/archive/thunderclaw-openclaw-plugin-0.1.0-$(date +%s).tgz"
fi
mise exec -- npm pack --workspace @thunderclaw/openclaw-plugin --pack-destination .spike/thunderclaw-packages --silent >/dev/null

"${compose[@]}" run --rm --no-deps --entrypoint sh gateway -lc '
  node openclaw.mjs onboard \
    --non-interactive \
    --mode local \
    --auth-choice deepseek-api-key \
    --deepseek-api-key "$DEEPSEEK_API_KEY" \
    --secret-input-mode ref \
    --gateway-auth token \
    --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
    --gateway-bind lan \
    --gateway-port 18789 \
    --workspace /home/node/.openclaw/workspace \
    --skip-channels \
    --skip-search \
    --skip-skills \
    --skip-ui \
    --skip-health \
    --no-install-daemon \
    --accept-risk
'

"${compose[@]}" run --rm --no-deps gateway node openclaw.mjs plugins install \
  @openclaw/deepseek-provider@2026.8.1-beta.3 --force --pin

"${compose[@]}" run --rm --no-deps gateway node openclaw.mjs plugins install \
  npm-pack:/workspace/thunderclaw/.spike/thunderclaw-packages/thunderclaw-openclaw-plugin-0.1.0.tgz --force

"${compose[@]}" run --rm --no-deps --entrypoint node gateway -e '
  const { spawnSync } = require("node:child_process");
  const token = process.env.THUNDERCLAW_PLUGIN_TOKEN;
  if (!token || token.length < 32) {
    process.stderr.write("THUNDERCLAW_PLUGIN_TOKEN must be set to at least 32 characters.\n");
    process.exit(1);
  }
  const batch = JSON.stringify([
    { path: "plugins.entries.thunderclaw.enabled", value: true },
    {
      path: "plugins.entries.thunderclaw.config",
      value: { token, sessionTtlMs: 1800000, maxRequestBytes: 256000 },
    },
  ]);
  const result = spawnSync(process.execPath, ["openclaw.mjs", "config", "set", "--batch-json", batch], { stdio: "inherit" });
  process.exit(result.status ?? 1);
'

"${compose[@]}" up -d gateway
