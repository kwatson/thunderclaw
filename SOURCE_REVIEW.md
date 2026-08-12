# Thunderbird extension source review

This archive contains the complete allowlisted source and build configuration
for the ThunderClaw Thunderbird extension. It intentionally excludes the
OpenClaw plugin, tests that require a protected environment, dependencies,
generated output, local state, and credentials.

## Build environment

The release build is tested on Debian GNU/Linux 13 (`x86_64`) with:

- Node.js 24.19.0 and its bundled npm 11.7.0;
- [mise](https://mise.jdx.dev/) to install the pinned Node.js version; and
- Info-ZIP `zip` 3.0 and `unzip` 6.0.

On Debian or Ubuntu, install the system tools with:

```text
sudo apt-get update
sudo apt-get install -y zip unzip
```

Network access to the public npm registry is required for the clean dependency
install. The Mozilla reviewer environment may use a different CPU architecture;
this build has no native extension dependency or architecture-specific output.

No global npm packages are required. JavaScript dependencies are pinned by
`package-lock.json` and installed from the public npm registry.

## Reproduce the XPI

From the extracted archive root:

```text
mise install
mise exec -- npm ci
mise exec -- npm run build:extension
```

The build writes `build/thunderclaw-extension.xpi`. The build script bundles
the TypeScript entry points with esbuild, copies the reviewed static extension
files, omits source maps, and creates an XPI whose root contains
`manifest.json`.

To inspect the generated package:

```text
unzip -l build/thunderclaw-extension.xpi
unzip -p build/thunderclaw-extension.xpi manifest.json
```

The extension source is under `packages/thunderbird-extension/src/`; the build
entry point is `scripts/build-extension.mjs`. The root `package.json`, workspace
package metadata, `.mise.toml`, and lockfile define the complete build toolchain.
