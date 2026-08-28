import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultApiBase = "https://addons.thunderbird.net/api/v4";
const addonId = "thunderclaw@addons.thunderbird.net";

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createAtnJwt({ issuer, secret, now = Math.floor(Date.now() / 1000), nonce = randomUUID() }) {
  if (!issuer || !secret) throw new Error("ATN JWT issuer and secret are required");
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify({ iss: issuer, jti: nonce, iat: now, exp: now + 60 }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export function versionEndpoint(apiBase, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`Version must have canonical form X.Y.Z: ${version}`);
  }
  return `${apiBase.replace(/\/$/u, "")}/addons/${encodeURIComponent(addonId)}/versions/${version}/`;
}

async function responseJson(response) {
  const body = await response.text();
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`ATN returned non-JSON HTTP ${response.status}`);
  }
}

export async function submitToThunderbirdAddons({ xpi, version, issuer, secret, apiBase = defaultApiBase, pollIntervalMs = 10_000, timeoutMs = 15 * 60_000 }) {
  const endpoint = versionEndpoint(apiBase, version);
  const authorization = () => `JWT ${createAtnJwt({ issuer, secret })}`;
  const form = new FormData();
  form.append("upload", new Blob([await readFile(xpi)]), path.basename(xpi));
  form.append("channel", "listed");
  const uploadResponse = await fetch(endpoint, {
    method: "PUT",
    headers: { authorization: authorization() },
    body: form,
  });
  const upload = await responseJson(uploadResponse);
  if (!uploadResponse.ok) {
    const detail = upload.error ?? upload.detail ?? `HTTP ${uploadResponse.status}`;
    throw new Error(`ATN XPI submission failed: ${detail}`);
  }

  const statusUrl = typeof upload.url === "string" && upload.url.startsWith("https://addons.thunderbird.net/")
    ? upload.url
    : endpoint;
  const deadline = Date.now() + timeoutMs;
  let status = upload;
  while (!status.processed) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for ATN validation");
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const pollResponse = await fetch(statusUrl, { headers: { authorization: authorization() } });
    status = await responseJson(pollResponse);
    if (!pollResponse.ok) throw new Error(`ATN validation polling failed with HTTP ${pollResponse.status}`);
  }
  if (!status.valid) throw new Error(`ATN rejected the XPI; validation results: ${JSON.stringify(status.validation_results ?? null)}`);

  return {
    addonId,
    version,
    processed: Boolean(status.processed),
    valid: Boolean(status.valid),
    reviewed: Boolean(status.reviewed),
    active: Boolean(status.active),
    manualHandoffRequired: true,
    validationUrl: status.validation_url ?? null,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await submitToThunderbirdAddons({
      xpi: process.env.THUNDERCLAW_XPI,
      version: process.env.THUNDERCLAW_VERSION,
      issuer: process.env.ATN_JWT_ISSUER,
      secret: process.env.ATN_JWT_SECRET,
      apiBase: process.env.ATN_API_BASE || defaultApiBase,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
