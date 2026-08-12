FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG THUNDERBIRD_VERSION=153.0.1esr
ARG THUNDERBIRD_SHA512=af36a161d132f78f69de572caf2df795d7518e4e70f83a378e37d2c834db901b227b663494602886ac58ab39afa289b63d091ca3a30a22cd1fcd552a139fc7cc
ARG THUNDERBIRD_ARCHIVE_EXTENSION=tar.xz

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      bzip2 \
      curl \
      dbus-x11 \
      fonts-dejavu-core \
      libasound2 \
      libdbus-glib-1-2 \
      libgtk-3-0 \
      libnss3 \
      libx11-xcb1 \
      libxt6 \
      python3 \
      python3-pip \
      xauth \
      xz-utils \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --retry 3 --output /tmp/thunderbird.archive \
      "https://archive.mozilla.org/pub/thunderbird/releases/${THUNDERBIRD_VERSION}/linux-x86_64/en-US/thunderbird-${THUNDERBIRD_VERSION}.${THUNDERBIRD_ARCHIVE_EXTENSION}" \
    && printf '%s  %s\n' "${THUNDERBIRD_SHA512}" /tmp/thunderbird.archive | sha512sum --check --strict \
    && tar -xf /tmp/thunderbird.archive -C /opt \
    && rm /tmp/thunderbird.archive \
    && ln -s /opt/thunderbird/thunderbird /usr/local/bin/thunderbird

COPY e2e/thunderbird/requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

RUN useradd --create-home --uid 10001 --shell /bin/bash thunderclaw
USER thunderclaw
WORKDIR /work

COPY --chown=thunderclaw:thunderclaw e2e/thunderbird /opt/thunderclaw-e2e
RUN chmod 0644 /opt/thunderclaw-e2e/*.py /opt/thunderclaw-e2e/*.txt /opt/thunderclaw-e2e/user.js \
    && chmod 0755 /opt/thunderclaw-e2e/entrypoint.sh /opt/thunderclaw-e2e/entrypoint-rich-compose.sh

ENTRYPOINT ["/opt/thunderclaw-e2e/entrypoint.sh"]
