#!/bin/sh
set -eu

version=${1:?Thunderbird version is required}
expected_sha512=${2:?Thunderbird SHA-512 is required}
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
if ! printf '%s\n' "${version}" | grep -Eq '^[0-9]+\.[0-9]+(\.[0-9]+)?(esr)?$'; then
  echo "Invalid Thunderbird version: ${version}" >&2
  exit 1
fi
if ! printf '%s\n' "${expected_sha512}" | grep -Eq '^[[:xdigit:]]{128}$'; then
  echo "Thunderbird SHA-512 must contain exactly 128 hexadecimal characters" >&2
  exit 1
fi
expected_sha512=$(printf '%s' "${expected_sha512}" | tr '[:upper:]' '[:lower:]')
archive="${RUNNER_TEMP}/thunderbird-${version}.dmg"
mount_point="${RUNNER_TEMP}/thunderbird-${version}-mount"
install_root="${RUNNER_TEMP}/thunderbird-${version}"
url="https://archive.mozilla.org/pub/thunderbird/releases/${version}/mac/en-US/Thunderbird%20${version}.dmg"

if [ -e "${mount_point}" ] || [ -e "${install_root}" ]; then
  echo "Refusing to reuse Thunderbird mount or install directory for ${version}" >&2
  exit 1
fi

curl --fail --location --retry 3 --output "${archive}" "${url}"
actual_sha512=$(shasum -a 512 "${archive}" | awk '{print $1}')
if [ "${actual_sha512}" != "${expected_sha512}" ]; then
  echo "Thunderbird ${version} SHA-512 mismatch" >&2
  exit 1
fi

mkdir "${mount_point}" "${install_root}"
cleanup() {
  hdiutil detach "${mount_point}" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
hdiutil attach "${archive}" -nobrowse -readonly -mountpoint "${mount_point}" -quiet
ditto "${mount_point}/Thunderbird.app" "${install_root}/Thunderbird.app"
hdiutil detach "${mount_point}" -quiet
trap - EXIT HUP INT TERM
xattr -dr com.apple.quarantine "${install_root}/Thunderbird.app" 2>/dev/null || true

executable="${install_root}/Thunderbird.app/Contents/MacOS/thunderbird"
application_ini="${install_root}/Thunderbird.app/Contents/Resources/application.ini"
test -x "${executable}"
test -f "${application_ini}"
{
  printf 'thunderbird=%s\n' "${executable}"
  printf 'application_ini=%s\n' "${application_ini}"
} >> "${GITHUB_OUTPUT}"
