#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact_root=${THUNDERCLAW_E2E_ARTIFACTS:-"${repository_root}/build/e2e/thunderbird"}
if [ "${THUNDERCLAW_E2E_VERSIONS+x}" = x ]; then
  versions=${THUNDERCLAW_E2E_VERSIONS}
else
  versions="128.14.0esr 153.0.1esr"
fi
staging_root=$(mktemp -d /tmp/thunderclaw-e2e.XXXXXX)
trap 'rm -rf -- "${staging_root}"' EXIT HUP INT TERM

if [ -z "$(printf '%s' "${versions}" | tr -d '[:space:]')" ]; then
  echo "THUNDERCLAW_E2E_VERSIONS must contain at least one pinned Thunderbird version" >&2
  exit 2
fi
for version in ${versions}; do
  case "${version}" in
    128.14.0esr|153.0.1esr) ;;
    *)
      echo "Unsupported pinned Thunderbird E2E version: ${version}" >&2
      exit 2
      ;;
  esac
done

cd "${repository_root}"
mise exec -- npm run build:extension
mkdir -p "${artifact_root}"
# Remove only the known files/directories published by the pre-matrix runner.
# Version directories below are cleaned independently immediately before copy.
rm -f "${artifact_root}/junit.xml" "${artifact_root}/stub-requests.json"
for legacy_trial in trial-1 trial-2; do
  if [ -e "${artifact_root}/${legacy_trial}" ] || [ -L "${artifact_root}/${legacy_trial}" ]; then
    find "${artifact_root}/${legacy_trial}" -depth -delete
  fi
done
cp "${repository_root}/build/thunderclaw-extension.xpi" "${staging_root}/thunderclaw-extension.xpi"
chmod 0755 "${staging_root}"
chmod 0644 "${staging_root}/thunderclaw-extension.xpi"

overall_status=0
for version in ${versions}; do
  case "${version}" in
    128.14.0esr)
      checksum=20f54bf73232e80e8716c219e05658c2dd519f15a262e98429fc4c875d2477ed052fb15cd8c31c9b731b447589b1fe99c49e9eb8e7fa71dac9e80c4c64e09f0d
      archive_extension=tar.bz2
      ;;
    153.0.1esr)
      checksum=af36a161d132f78f69de572caf2df795d7518e4e70f83a378e37d2c834db901b227b663494602886ac58ab39afa289b63d091ca3a30a22cd1fcd552a139fc7cc
      archive_extension=tar.xz
      ;;
  esac
  image_name="thunderclaw-thunderbird-e2e:${version}"
  docker build \
    --file e2e/thunderbird/Dockerfile \
    --build-arg "THUNDERBIRD_VERSION=${version}" \
    --build-arg "THUNDERBIRD_SHA512=${checksum}" \
    --build-arg "THUNDERBIRD_ARCHIVE_EXTENSION=${archive_extension}" \
    --tag "${image_name}" \
    .
  version_staging="${staging_root}/artifacts-${version}"
  mkdir "${version_staging}"
  chmod 0777 "${version_staging}"
  set +e
  docker run --rm \
    --init \
    --shm-size=1g \
    --network=none \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp/thunderclaw-e2e-home \
    --env "THUNDERCLAW_THUNDERBIRD_VERSION=${version}" \
    --mount "type=bind,src=${staging_root}/thunderclaw-extension.xpi,dst=/work/thunderclaw-extension.xpi,readonly" \
    --mount "type=bind,src=${version_staging},dst=/work/artifacts" \
    "${image_name}"
  status=$?
  set -e
  version_artifacts="${artifact_root}/${version}"
  mkdir -p "${version_artifacts}"
  find "${version_artifacts}" -mindepth 1 -delete
  cp -R "${version_staging}/." "${version_artifacts}/"
  if [ "${status}" -ne 0 ]; then overall_status=${status}; fi
done
exit "${overall_status}"
