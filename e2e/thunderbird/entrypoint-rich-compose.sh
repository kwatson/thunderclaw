#!/bin/sh
set -eu

mkdir -p "${HOME}" /work/artifacts
exec xvfb-run -a -s "-screen 0 1440x1000x24 -nolisten tcp" \
  python3 /opt/thunderclaw-e2e/run_rich_compose.py \
    --xpi /work/thunderclaw-rich-compose-r0.xpi \
    --artifacts /work/artifacts \
    --expected-version "${THUNDERCLAW_THUNDERBIRD_VERSION}"
