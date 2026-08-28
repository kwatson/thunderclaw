import path from "node:path";
import { pathToFileURL } from "node:url";

const channels = new Set(["openclaw-plugin", "thunderbird-extension"]);
const legacyTags = new Set(["v0.1.0", "v0.1.1"]);
const componentTag = /^(openclaw-plugin|thunderbird-extension)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function dispatchRelease(tag, requestedChannel) {
  if (legacyTags.has(tag)) {
    if (![...channels, "both"].includes(requestedChannel)) {
      throw new Error("Legacy v0.1.0/v0.1.1 dispatch requires --channel openclaw-plugin, thunderbird-extension, or both");
    }
    return {
      tag,
      version: tag.slice(1),
      layout: "legacy-combined-v1",
      verifier: "verify-legacy-marketplace-release.mjs",
      channels: requestedChannel === "both" ? [...channels] : [requestedChannel],
    };
  }

  const match = componentTag.exec(tag);
  if (!match) throw new Error(`Unsupported release tag: ${tag}`);
  const channel = match[1];
  if (requestedChannel && requestedChannel !== channel) {
    throw new Error(`Tag ${tag} may dispatch only the ${channel} channel`);
  }
  return {
    tag,
    version: `${match[2]}.${match[3]}.${match[4]}`,
    layout: "independent-v2",
    verifier: "verify-marketplace-release.mjs",
    channels: [channel],
  };
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--tag", "--channel"].includes(key) || !value || values.has(key)) {
      throw new Error("Usage: release-channel-dispatch.mjs --tag <tag> [--channel <openclaw-plugin|thunderbird-extension|both>]");
    }
    values.set(key, value);
  }
  if (!values.has("--tag")) throw new Error("--tag is required");
  return { tag: values.get("--tag"), channel: values.get("--channel") };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(dispatchRelease(options.tag, options.channel))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
