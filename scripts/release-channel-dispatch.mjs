import path from "node:path";
import { pathToFileURL } from "node:url";

const componentTag = /^thunderbird-extension-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function dispatchRelease(tag, requestedChannel) {
  const match = componentTag.exec(tag);
  if (!match) throw new Error(`Unsupported release tag: ${tag}`);
  const channel = "thunderbird-extension";
  if (requestedChannel && requestedChannel !== channel) {
    throw new Error(`Tag ${tag} may dispatch only the ${channel} channel`);
  }
  return {
    tag,
    version: `${match[1]}.${match[2]}.${match[3]}`,
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
      throw new Error("Usage: release-channel-dispatch.mjs --tag <tag> [--channel <thunderbird-extension>]");
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
