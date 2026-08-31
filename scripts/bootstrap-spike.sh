#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose -f compose.spike.yaml)

mkdir -p .spike/thunderclaw-openclaw .spike/thunderclaw-openclaw/workspace
mkdir -p .spike/thunderclaw-packages .spike/thunderclaw-packages/archive
if test -n "${THUNDERCLAW_OPENCLAW_PLUGIN_TGZ:-}"; then
  candidate=$(realpath "$THUNDERCLAW_OPENCLAW_PLUGIN_TGZ")
  mise exec -- node scripts/validate-candidate-artifact.mjs plugin-tgz "$candidate" >/dev/null
  package_path=.spike/thunderclaw-packages/qualification-candidate.tgz
  cp "$candidate" "$package_path"
  cmp -s "$candidate" "$package_path" || { echo "Staged plugin differs from the explicit candidate" >&2; exit 1; }
else
  plugin_version=$(mise exec -- node -p 'require("./packages/openclaw-plugin/package.json").version')
  package_path=".spike/thunderclaw-packages/thunderclaw-openclaw-plugin-${plugin_version}.tgz"
  mise exec -- npm pack --workspace @thunderclaw/openclaw-plugin --pack-destination .spike/thunderclaw-packages --silent >/dev/null
fi

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
  @openclaw/deepseek-provider@2026.8.1 --force --pin --accept-capabilities

"${compose[@]}" run --rm --no-deps gateway node openclaw.mjs plugins install \
  "npm-pack:/workspace/thunderclaw/${package_path}" --force --accept-capabilities

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
