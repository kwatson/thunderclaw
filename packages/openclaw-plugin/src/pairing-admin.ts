import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  PairingRegistry,
  PairingRegistryAuthenticationError,
  PairingRegistryConflictError,
  PairingRegistryInputError,
  PairingRegistryUnavailableError,
} from "./pairing-registry.js";

type Respond = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0]["respond"];

function failure(respond: Respond, error: unknown): void {
  const known = error instanceof PairingRegistryInputError
    || error instanceof PairingRegistryConflictError
    || error instanceof PairingRegistryAuthenticationError
    || error instanceof PairingRegistryUnavailableError;
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known ? error.message : "pairing administration failed";
  respond(false, undefined, { code: code as never, message });
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new PairingRegistryInputError(`invalid ${key}`);
  return value;
}

function exactParams(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PairingRegistryInputError("invalid parameters");
  const params = value as Record<string, unknown>;
  if (Object.keys(params).length !== keys.length || keys.some((key) => !Object.hasOwn(params, key))) {
    throw new PairingRegistryInputError("invalid parameters");
  }
  return params;
}

export function registerPairingAdministration(api: OpenClawPluginApi, registry: PairingRegistry): void {
  api.registerGatewayMethod("thunderclaw.pairing.status", ({ params, respond }) => {
    try {
      exactParams(params, []);
      respond(true, { protocolVersion: 1, available: registry.isAvailable });
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.read" });

  api.registerGatewayMethod("thunderclaw.pairing.requests", ({ params, respond }) => {
    try {
      exactParams(params, []);
      respond(true, { protocolVersion: 1, requests: registry.listPending() });
    }
    catch (error) { failure(respond, error); }
  }, { scope: "operator.read" });

  api.registerGatewayMethod("thunderclaw.pairing.approve", ({ params, respond }) => {
    try {
      const exact = exactParams(params, ["requestId", "approvalCode"]);
      registry.approve(requiredString(exact, "requestId"), requiredString(exact, "approvalCode"));
      respond(true, { protocolVersion: 1, approved: true });
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.admin" });

  api.registerGatewayMethod("thunderclaw.pairing.deny", ({ params, respond }) => {
    try {
      const exact = exactParams(params, ["requestId"]);
      registry.deny(requiredString(exact, "requestId"));
      respond(true, { protocolVersion: 1, denied: true });
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.admin" });

  api.registerGatewayMethod("thunderclaw.devices.list", ({ params, respond }) => {
    try {
      exactParams(params, []);
      respond(true, { protocolVersion: 1, devices: registry.listDevices() });
    }
    catch (error) { failure(respond, error); }
  }, { scope: "operator.read" });

  api.registerGatewayMethod("thunderclaw.devices.revoke", ({ params, respond }) => {
    try {
      const exact = exactParams(params, ["credentialId"]);
      registry.revoke(requiredString(exact, "credentialId"), "operator");
      respond(true, { protocolVersion: 1, revoked: true });
    } catch (error) { failure(respond, error); }
  }, { scope: "operator.admin" });
}
