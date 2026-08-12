#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact_root=${THUNDERCLAW_R0_E2E_ARTIFACTS:-"${repository_root}/build/e2e/thunderbird-rich-compose-r0"}
versions=${THUNDERCLAW_R0_E2E_VERSIONS:-"153.0.1esr 128.14.0esr"}
staging_root=$(mktemp -d /tmp/thunderclaw-r0-e2e.XXXXXX)
trap 'rm -rf -- "${staging_root}"' EXIT HUP INT TERM

cd "${repository_root}"
mise exec -- node e2e/thunderbird/rich-compose/test.mjs
mise exec -- node e2e/thunderbird/rich-compose/adversarial-test.mjs
cp "${repository_root}/build/rich-compose-spike/thunderclaw-rich-compose-r0-0.0.1.xpi" "${staging_root}/thunderclaw-rich-compose-r0.xpi"
chmod 0755 "${staging_root}"
chmod 0644 "${staging_root}/thunderclaw-rich-compose-r0.xpi"
mkdir -p "${artifact_root}"

overall_status=0
for version in ${versions}; do
  case "${version}" in
    153.0.1esr)
      checksum=af36a161d132f78f69de572caf2df795d7518e4e70f83a378e37d2c834db901b227b663494602886ac58ab39afa289b63d091ca3a30a22cd1fcd552a139fc7cc
      archive_extension=tar.xz
      ;;
    128.14.0esr)
      checksum=20f54bf73232e80e8716c219e05658c2dd519f15a262e98429fc4c875d2477ed052fb15cd8c31c9b731b447589b1fe99c49e9eb8e7fa71dac9e80c4c64e09f0d
      archive_extension=tar.bz2
      ;;
    *)
      echo "Unsupported pinned Thunderbird R0 E2E version: ${version}" >&2
      exit 2
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
    --env HOME=/tmp/thunderclaw-r0-e2e-home \
    --env "THUNDERCLAW_THUNDERBIRD_VERSION=${version}" \
    --env THUNDERCLAW_R0_E2E_CASES \
    --entrypoint /opt/thunderclaw-e2e/entrypoint-rich-compose.sh \
    --mount "type=bind,src=${staging_root}/thunderclaw-rich-compose-r0.xpi,dst=/work/thunderclaw-rich-compose-r0.xpi,readonly" \
    --mount "type=bind,src=${version_staging},dst=/work/artifacts" \
    "${image_name}"
  status=$?
  set -e
  mkdir -p "${artifact_root}/${version}"
  find "${artifact_root:?}/${version}" -mindepth 1 -delete
  cp -R "${version_staging}/." "${artifact_root}/${version}/"
  if [ "${status}" -ne 0 ]; then overall_status=${status}; fi
done
exit "${overall_status}"
