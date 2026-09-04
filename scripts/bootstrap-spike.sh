#!/usr/bin/env bash
set -euo pipefail

export THUNDERCLAW_COMPOSE_USER="${THUNDERCLAW_COMPOSE_USER:-$(id -u):$(id -g)}"
compose=(docker compose -f compose.spike.yaml)

mkdir -p .spike/thunderclaw-openclaw .spike/thunderclaw-openclaw/workspace
mkdir -p .spike/thunderclaw-openclaw-cache
mkdir -p .spike/thunderclaw-packages .spike/thunderclaw-packages/archive
mkdir -p .spike/evidence
if test -n "${THUNDERCLAW_OPENCLAW_PLUGIN_TGZ:-}"; then
  candidate=$(realpath "$THUNDERCLAW_OPENCLAW_PLUGIN_TGZ")
  mise exec -- node scripts/validate-candidate-artifact.mjs plugin-tgz "$candidate" >/dev/null
else
  plugin_version=$(mise exec -- node -p 'require("./packages/openclaw-plugin/package.json").version')
  package_path=".spike/thunderclaw-packages/thunderclaw-openclaw-plugin-${plugin_version}.tgz"
  mise exec -- npm pack --workspace @thunderclaw/openclaw-plugin --pack-destination .spike/thunderclaw-packages --silent >/dev/null
  candidate=$(realpath "$package_path")
fi
candidate_mount_path=/tmp/thunderclaw-qualification-candidate.tgz

"${compose[@]}" run --rm --no-deps gateway node openclaw.mjs plugins install \
  @openclaw/deepseek-provider@2026.9.1 --force --pin --accept-capabilities

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

if "${compose[@]}" run --rm --no-deps gateway node openclaw.mjs agents list --json \
  | mise exec -- node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const agents = JSON.parse(input);
      process.exit(agents.some((agent) => agent.id === "deepseek-flash"
        && agent.model === "deepseek/deepseek-v4-flash") ? 0 : 1);
    });
  '
then
  printf '%s\n' "Qualification agent already exists with the expected model."
else
  "${compose[@]}" run --rm --no-deps gateway node openclaw.mjs agents add deepseek-flash \
    --non-interactive \
    --workspace /home/node/.openclaw/workspace \
    --model deepseek/deepseek-v4-flash \
    --json
fi

"${compose[@]}" run --rm --no-deps \
  --volume "${candidate}:${candidate_mount_path}:ro" \
  gateway node openclaw.mjs plugins install \
  "npm-pack:${candidate_mount_path}" --force --accept-capabilities

"${compose[@]}" run --rm --no-deps --entrypoint node gateway -e '
  const { readFileSync } = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const config = JSON.parse(readFileSync("/workspace/thunderclaw/scripts/spike-plugin-config.json", "utf8"));
  const batch = JSON.stringify([
    { path: "plugins.entries.thunderclaw.enabled", value: true },
    {
      path: "plugins.entries.thunderclaw.config",
      value: config,
    },
  ]);
  const result = spawnSync(process.execPath, ["openclaw.mjs", "config", "set", "--batch-json", batch], { stdio: "inherit" });
  process.exit(result.status ?? 1);
'

"${compose[@]}" up -d gateway
