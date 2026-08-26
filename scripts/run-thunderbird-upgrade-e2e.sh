#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
baseline="${repository_root}/build/frozen-release-0.0.11-body-text-list-39bcaca3/thunderclaw-extension-0.0.11-39bcaca3.xpi"
expected_baseline=39bcaca3cea664d139b3431b7a3530b0efc52003296cad4569c790f95191dd71
artifacts="${repository_root}/build/e2e/thunderbird-upgrade/153.0.3"
staging=$(mktemp -d /tmp/thunderclaw-upgrade-e2e.XXXXXX)
trap 'find "${staging}" -depth -delete' EXIT HUP INT TERM

if [ ! -f "${baseline}" ]; then
  echo "The frozen 0.0.11 baseline XPI is missing" >&2
  exit 2
fi
actual_baseline=$(sha256sum "${baseline}" | awk '{print $1}')
if [ "${actual_baseline}" != "${expected_baseline}" ]; then
  echo "The frozen 0.0.11 baseline XPI hash is invalid" >&2
  exit 2
fi

cd "${repository_root}"
mise exec -- npm run build:extension
cp "${baseline}" "${staging}/baseline.xpi"
cp "${repository_root}/build/thunderclaw-extension.xpi" "${staging}/candidate.xpi"
chmod 0755 "${staging}"
chmod 0644 "${staging}/baseline.xpi" "${staging}/candidate.xpi"
mkdir -p "${artifacts}"
find "${artifacts}" -mindepth 1 -delete
chmod 0777 "${artifacts}"

docker build \
  --file e2e/thunderbird/Dockerfile \
  --build-arg THUNDERBIRD_VERSION=153.0.3 \
  --build-arg THUNDERBIRD_SHA512=f55659181b90776669f83959da3cb9ce7e9b150feb9ba4e7228e6ced5ad8fba81284b639f7b5b9ff71d552c87a6d8d1a0eb74fb6bca9af1b12a102a6bdb95d14 \
  --build-arg THUNDERBIRD_ARCHIVE_EXTENSION=tar.xz \
  --tag thunderclaw-thunderbird-e2e:153.0.3 \
  .

docker run --rm --init --shm-size=1g --network=none \
  --user "$(id -u):$(id -g)" \
  --entrypoint xvfb-run \
  --env HOME=/tmp/thunderclaw-upgrade-home \
  --mount "type=bind,src=${staging}/baseline.xpi,dst=/work/baseline.xpi,readonly" \
  --mount "type=bind,src=${staging}/candidate.xpi,dst=/work/candidate.xpi,readonly" \
  --mount "type=bind,src=${artifacts},dst=/work/artifacts" \
  thunderclaw-thunderbird-e2e:153.0.3 \
  -a -s "-screen 0 1440x1000x24 -nolisten tcp" \
  python3 /opt/thunderclaw-e2e/run_upgrade.py \
  --baseline /work/baseline.xpi --candidate /work/candidate.xpi --artifacts /work/artifacts
