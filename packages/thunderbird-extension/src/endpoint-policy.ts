import { DirectClientError } from "./direct-client-contract.js";

const API_PATH = "/thunderclaw/v1";
const MAX_ENDPOINT_CHARACTERS = 2_048;

export type CanonicalEndpoint = Readonly<{
  apiBase: string;
  origin: string;
  permissionPattern: string;
  protocol: "https:" | "http:";
  hostname: string;
}>;

function invalid(message: string): never {
  throw new DirectClientError("configuration", "INVALID_API_BASE", message);
}

function splitAuthority(authority: string): { rawHostname: string; rawPort: string | null } {
  if (authority.length === 0 || authority.includes("@")) invalid("The OpenClaw endpoint must not contain credentials.");
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 0) invalid("The OpenClaw endpoint contains an invalid IPv6 address.");
    const suffix = authority.slice(closing + 1);
    if (suffix !== "" && !/^:[0-9]+$/u.test(suffix)) invalid("The OpenClaw endpoint contains an invalid port.");
    return { rawHostname: authority.slice(0, closing + 1), rawPort: suffix === "" ? null : suffix.slice(1) };
  }
  if ((authority.match(/:/gu) ?? []).length > 1) invalid("IPv6 endpoints must use brackets.");
  const colon = authority.lastIndexOf(":");
  return colon < 0
    ? { rawHostname: authority, rawPort: null }
    : { rawHostname: authority.slice(0, colon), rawPort: authority.slice(colon + 1) };
}

/** Canonicalizes the only endpoint shape from which product requests may be built. */
export function canonicalizeApiBase(input: unknown): CanonicalEndpoint {
  if (typeof input !== "string") invalid("Enter an OpenClaw endpoint.");
  const supplied = input;
  if (supplied.trim() !== supplied || supplied.length === 0 || supplied.length > MAX_ENDPOINT_CHARACTERS || /[\u0000-\u0020\u007F]/u.test(supplied)) {
    invalid("The OpenClaw endpoint contains invalid characters.");
  }
  if (supplied.includes("\\") || supplied.includes("%")) invalid("The OpenClaw endpoint uses an ambiguous form.");
  if (supplied.includes("?") || supplied.includes("#")) invalid("The OpenClaw endpoint must not contain a query or fragment.");

  const matched = /^(https?):\/\/([^/?#]*)(\/[^?#]*)?$/iu.exec(supplied);
  if (!matched) invalid("Use an HTTPS endpoint, or HTTP with an explicit loopback address.");
  const protocol = `${matched[1].toLowerCase()}:` as "https:" | "http:";
  const authority = matched[2];
  const suppliedPath = matched[3] ?? "";
  if (suppliedPath !== API_PATH && suppliedPath !== `${API_PATH}/`) {
    invalid(`The OpenClaw endpoint path must be ${API_PATH}.`);
  }
  const { rawHostname, rawPort } = splitAuthority(authority);
  if (!/^[\x21-\x7E]+$/u.test(rawHostname)) invalid("Use a canonical ASCII hostname or IP address.");
  if (rawHostname.endsWith(".")) invalid("Trailing-dot hostnames are not supported.");
  if (/(?:^|\.)xn--/iu.test(rawHostname)) invalid("Internationalized hostnames require separate review.");
  if (rawPort !== null && (!/^(?:[1-9][0-9]{0,4})$/u.test(rawPort) || Number(rawPort) > 65_535)) {
    invalid("The OpenClaw endpoint contains an invalid port.");
  }

  let parsed: URL;
  try {
    parsed = new URL(`${protocol}//${authority}${API_PATH}`);
  } catch {
    return invalid("The OpenClaw endpoint is invalid.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) invalid("The OpenClaw endpoint is invalid.");
  const hostname = parsed.hostname.toLowerCase();
  if (rawHostname.toLowerCase() !== hostname) invalid("Use the canonical hostname or IP-address form.");
  if (hostname === "localhost") invalid("localhost is not accepted; use 127.0.0.1 or [::1] explicitly.");

  const ipv6 = hostname.startsWith("[");
  if (ipv6) {
    if (hostname.includes(".") || hostname.includes("ffff")) invalid("IPv4-mapped IPv6 endpoints are not supported.");
    if (hostname !== "[::1]") invalid("Only canonical IPv6 loopback is currently supported.");
  } else if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(hostname)) {
    invalid("The OpenClaw endpoint hostname is invalid.");
  }
  if (protocol === "http:" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
    invalid("Cleartext HTTP is allowed only for 127.0.0.1 or [::1].");
  }

  const origin = parsed.origin;
  return Object.freeze({
    apiBase: `${origin}${API_PATH}`,
    origin,
    permissionPattern: `${protocol}//${hostname}/*`,
    protocol,
    hostname,
  });
}
