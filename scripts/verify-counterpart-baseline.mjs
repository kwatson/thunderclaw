import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const manifestPath = new URL("../e2e/qualification/counterpart-baselines.json", import.meta.url);
const counterparts = {
  "openclaw-plugin": "thunderbird-extension",
  "thunderbird-extension": "openclaw-plugin",
};

export async function verifyCounterpartBaseline({ forComponent, artifact }) {
  const counterpart = counterparts[forComponent];
  if (!counterpart) throw new Error(`Unknown release component: ${forComponent}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const rootKeys = Object.keys(manifest ?? {}).sort();
  if (JSON.stringify(rootKeys) !== JSON.stringify(["format", "openclaw-plugin", "thunderbird-extension"].sort())
      || manifest.format !== "thunderclaw-counterpart-baselines-v1") {
    throw new Error("Unknown counterpart baseline format or schema");
  }
  for (const component of Object.values(counterparts)) {
    const record = manifest[component];
    if (JSON.stringify(Object.keys(record ?? {}).sort()) !== JSON.stringify(["tag", "name", "sha256", "size"].sort())
        || typeof record.name !== "string" || record.name.length === 0 || record.name.includes("/")
        || !/^[a-f0-9]{64}$/u.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 1) {
      throw new Error(`Counterpart baseline has an invalid ${component} artifact schema`);
    }
    const tagPattern = component === "openclaw-plugin"
      ? /^(?:v|openclaw-plugin-v)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u
      : /^(?:v|thunderbird-extension-v)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
    const version = tagPattern.exec(record.tag)?.[1];
    const expectedName = component === "openclaw-plugin"
      ? `thunderclaw-openclaw-plugin-${version}.tgz`
      : `thunderclaw-thunderbird-${version}.xpi`;
    if (!version || record.name !== expectedName) {
      throw new Error(`Counterpart baseline ${component} tag and artifact name do not agree`);
    }
  }
  const expected = manifest[counterpart];
  if (!expected || !/^(?:v|openclaw-plugin-v|thunderbird-extension-v)\d+\.\d+\.\d+$/u.test(expected.tag)) {
    throw new Error(`Counterpart baseline has an invalid ${counterpart} release tag`);
  }
  const bytes = await readFile(artifact);
  const actual = {
    name: path.basename(artifact),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: (await stat(artifact)).size,
  };
  if (actual.name !== expected.name) throw new Error(`Counterpart baseline name must be ${expected.name}`);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error(`Counterpart baseline does not match the pinned ${expected.tag} ${counterpart} bytes`);
  }
  return { forComponent, counterpart, tag: expected.tag, ...actual };
}

function parseArguments(args) {
  if (args.length !== 4 || args[0] !== "--for-component" || args[2] !== "--artifact") {
    throw new Error("Usage: verify-counterpart-baseline.mjs --for-component <component> --artifact <path>");
  }
  return { forComponent: args[1], artifact: args[3] };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await verifyCounterpartBaseline(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
