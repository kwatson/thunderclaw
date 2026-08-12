#!/bin/sh
set -eu

: "${THUNDERCLAW_THUNDERBIRD_VERSION:?THUNDERCLAW_THUNDERBIRD_VERSION is required}"
mkdir -p "${HOME}" /work/artifacts
exec xvfb-run -a -s "-screen 0 1440x1000x24 -nolisten tcp" \
  python3 /opt/thunderclaw-e2e/run_compose.py \
    --xpi /work/thunderclaw-extension.xpi \
    --artifacts /work/artifacts \
    --expected-version "${THUNDERCLAW_THUNDERBIRD_VERSION}"
