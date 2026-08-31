#!/usr/bin/env bash
set -euo pipefail

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
gateway_image="ghcr.io/openclaw/openclaw:2026.8.1@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4"
temporary_root=$(mktemp -d /tmp/thunderclaw-openclaw-ci.XXXXXX)
state_root="${temporary_root}/state"
cache_root="${temporary_root}/cache"
evidence_root="${repository_root}/build/openclaw-ci-${$}"
container_name="thunderclaw-openclaw-ci-${$}"
gateway_token=$(mise exec -- node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')

cleanup() {
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

mkdir -p "${state_root}/workspace" "${cache_root}"

container_args=(
  --user "$(id -u):$(id -g)"
  --env HOME=/home/node
  --env NPM_CONFIG_CACHE=/home/node/.openclaw/npm-cache
  --env OPENCLAW_DISABLE_BONJOUR=1
  --env "OPENCLAW_GATEWAY_TOKEN=${gateway_token}"
  --mount "type=bind,src=${state_root},dst=/home/node/.openclaw"
  --mount "type=bind,src=${cache_root},dst=/home/node/.cache"
  --mount "type=bind,src=${repository_root},dst=/workspace/thunderclaw,readonly"
)

cd "${repository_root}"
if [[ ! -v THUNDERCLAW_OPENCLAW_PLUGIN_TGZ || -z "${THUNDERCLAW_OPENCLAW_PLUGIN_TGZ}" ]]; then
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

docker run --rm "${container_args[@]}" "${gateway_image}" \
  node openclaw.mjs onboard \
    --non-interactive \
    --mode local \
    --auth-choice skip \
    --gateway-auth token \
    --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
    --gateway-bind lan \
    --gateway-port 18789 \
    --workspace /home/node/.openclaw/workspace \
    --skip-bootstrap \
    --skip-channels \
    --skip-search \
    --skip-skills \
    --skip-ui \
    --skip-health \
    --no-install-daemon \
    --suppress-gateway-token-output \
    --accept-risk

docker run --rm "${container_args[@]}" "${gateway_image}" \
  node openclaw.mjs plugins install --force --accept-capabilities \
    "npm-pack:/workspace/thunderclaw-candidate.tgz"

docker run --rm "${container_args[@]}" "${gateway_image}" \
  node openclaw.mjs config set plugins.entries.thunderclaw.enabled true --strict-json

docker run --detach \
  --name "${container_name}" \
  --init \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --publish 127.0.0.1::18789 \
  "${container_args[@]}" \
  "${gateway_image}" \
  node openclaw.mjs gateway run --port 18789 >/dev/null

for attempt in $(seq 1 30); do
  if docker exec "${container_name}" node openclaw.mjs gateway call health --json >/dev/null 2>&1; then
    break
  fi
  if test "${attempt}" -eq 30; then
    printf '%s\n' "The ephemeral OpenClaw Gateway did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

THUNDERCLAW_QUALIFICATION_CONTAINER="${container_name}" \
THUNDERCLAW_QUALIFICATION_STATE_ROOT="${state_root}" \
THUNDERCLAW_QUALIFICATION_GATEWAY_IMAGE="${gateway_image}" \
  mise exec -- npm run qualify:pairing -- --no-install

THUNDERCLAW_QUALIFICATION_CONTAINER="${container_name}" \
THUNDERCLAW_RECOVERY_OUTPUT_DIRECTORY="${evidence_root}/pairing-recovery" \
  mise exec -- npm run qualify:pairing:recovery

printf '%s\n' "Ephemeral pinned-OpenClaw qualification passed."
