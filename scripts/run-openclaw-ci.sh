#!/usr/bin/env bash
set -euo pipefail

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "${repository_root}"
gateway_image=$(mise exec -- node -e '
  const qualification = require("./openclaw-qualification.json");
  process.stdout.write(`${qualification.image.repository}:${qualification.stableVersion}@${qualification.image.linuxAmd64Digest}`);
')
temporary_root=$(mktemp -d /tmp/thunderclaw-openclaw-ci.XXXXXX)
state_root="${temporary_root}/state"
cache_root="${temporary_root}/cache"
evidence_root="${repository_root}/build/openclaw-ci-${$}"
container_name="thunderclaw-openclaw-ci-${$}"
export THUNDERCLAW_QUALIFICATION_DIAGNOSTICS="${repository_root}/build/qualification-diagnostics/openclaw-ci-${$}/diagnostics.jsonl"
qualification_phase=setup
record_phase() {
  qualification_phase=$1
  mise exec -- node scripts/qualification-diagnostics.mjs "${qualification_phase}" started
}
gateway_token=$(mise exec -- node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')

cleanup() {
  qualification_status=$?
  if test "${qualification_status}" -eq 0; then
    qualification_outcome=passed
  else
    qualification_outcome=failed
  fi
  # This content-free record survives cleanup; never retain Gateway logs/state.
  mise exec -- node scripts/qualification-diagnostics.mjs "${qualification_phase}" "${qualification_outcome}" "${qualification_status}" "${container_name}" || true
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  case "${evidence_root}" in
    "${repository_root}"/build/openclaw-ci-*)
      if test -e "${evidence_root}"; then find "${evidence_root}" -depth -delete; fi
      ;;
    *) printf '%s\n' "Refusing to clean unexpected evidence path" >&2 ;;
  esac
  case "${temporary_root}" in
    /tmp/thunderclaw-openclaw-ci.*) find "${temporary_root}" -depth -delete ;;
    *) printf '%s\n' "Refusing to clean unexpected temporary path" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

record_phase setup
mkdir -p "${state_root}/workspace" "${cache_root}"

container_args=(
  --user "$(id -u):$(id -g)"
  --env HOME=/home/node
  --env NPM_CONFIG_CACHE=/home/node/.openclaw/npm-cache
  --env NPM_CONFIG_OFFLINE=true
  --env OPENCLAW_DISABLE_BONJOUR=1
  --env DEEPSEEK_API_KEY=sk-synthetic-qualification-only
  --env "OPENCLAW_GATEWAY_TOKEN=${gateway_token}"
  --mount "type=bind,src=${state_root},dst=/home/node/.openclaw"
  --mount "type=bind,src=${cache_root},dst=/home/node/.cache"
  --mount "type=bind,src=${repository_root},dst=/workspace/thunderclaw,readonly"
)

if [[ -z "${THUNDERCLAW_OPENCLAW_PLUGIN_TGZ:-}" ]]; then
  printf '%s\n' "THUNDERCLAW_OPENCLAW_PLUGIN_TGZ must name an existing candidate archive" >&2
  exit 2
fi
candidate=${THUNDERCLAW_OPENCLAW_PLUGIN_TGZ}
mise exec -- node scripts/validate-candidate-artifact.mjs plugin-tgz "${candidate}"
staged_candidate="${temporary_root}/thunderclaw-openclaw-plugin.tgz"
cp "${candidate}" "${staged_candidate}"
chmod 0644 "${staged_candidate}"
mise exec -- node scripts/validate-candidate-artifact.mjs plugin-tgz "${staged_candidate}"
cmp -s "${candidate}" "${staged_candidate}" || {
  printf '%s\n' "Staged plugin bytes differ from the validated candidate" >&2
  exit 1
}
container_args+=(--mount "type=bind,src=${staged_candidate},dst=/workspace/thunderclaw-candidate.tgz,readonly")
provider_archive="${temporary_root}/openclaw-qualified-provider.tgz"
mise exec -- node scripts/stage-openclaw-provider.mjs --output "${provider_archive}"
container_args+=(--mount "type=bind,src=${provider_archive},dst=/workspace/openclaw-qualified-provider.tgz,readonly")

record_phase provider-install
docker run --rm "${container_args[@]}" "${gateway_image}" \
  node openclaw.mjs plugins install \
    npm-pack:/workspace/openclaw-qualified-provider.tgz --force --accept-capabilities

record_phase onboard
docker run --rm "${container_args[@]}" "${gateway_image}" \
  node openclaw.mjs onboard \
    --non-interactive \
    --mode local \
    --auth-choice deepseek-api-key \
    --deepseek-api-key sk-synthetic-qualification-only \
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
    --suppress-gateway-token-output \
    --accept-risk

record_phase agent-install
docker run --rm "${container_args[@]}" "${gateway_image}" \
  node openclaw.mjs agents add deepseek-flash \
    --non-interactive \
    --workspace /home/node/.openclaw/workspace \
    --model deepseek/deepseek-v4-flash \
    --json

record_phase plugin-install
docker run --rm "${container_args[@]}" "${gateway_image}" \
  node openclaw.mjs plugins install --force --accept-capabilities \
    "npm-pack:/workspace/thunderclaw-candidate.tgz"

record_phase configure
docker run --rm "${container_args[@]}" --entrypoint node "${gateway_image}" -e '
  const { readFileSync } = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const config = JSON.parse(readFileSync("/workspace/thunderclaw/scripts/spike-plugin-config.json", "utf8"));
  const batch = JSON.stringify([
    { path: "plugins.entries.thunderclaw.enabled", value: true },
    { path: "plugins.entries.thunderclaw.config", value: config },
  ]);
  const result = spawnSync(process.execPath, ["openclaw.mjs", "config", "set", "--batch-json", batch], { stdio: "inherit" });
  process.exit(result.status ?? 1);
'

record_phase gateway-start
docker run --detach \
  --name "${container_name}" \
  --init \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --publish 127.0.0.1::18789 \
  "${container_args[@]}" \
  "${gateway_image}" \
  node openclaw.mjs gateway run --port 18789 >/dev/null

THUNDERCLAW_QUALIFICATION_CONTAINER="${container_name}" \
  mise exec -- node --import tsx scripts/qualify-gateway-startup.ts

record_phase pairing-initial

THUNDERCLAW_QUALIFICATION_CONTAINER="${container_name}" \
THUNDERCLAW_QUALIFICATION_STATE_ROOT="${state_root}" \
THUNDERCLAW_QUALIFICATION_GATEWAY_IMAGE="${gateway_image}" \
  mise exec -- npm run qualify:pairing -- --no-install

record_phase pairing-recovery
THUNDERCLAW_QUALIFICATION_CONTAINER="${container_name}" \
THUNDERCLAW_RECOVERY_OUTPUT_DIRECTORY="${evidence_root}/pairing-recovery" \
  mise exec -- npm run qualify:pairing:recovery

record_phase complete
printf '%s\n' "Ephemeral pinned-OpenClaw qualification passed."
