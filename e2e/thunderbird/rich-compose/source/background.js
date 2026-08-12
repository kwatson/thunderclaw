"use strict";

// TB 128 predates the compose_scripts manifest key (added in TB 151), but
// supports this compose-only registration API. Keep this background limited to
// one fixed local script registration and a content-free readiness signal.
const R0_REGISTRATION_BUILD_ID = "thunderclaw-rich-compose-r0@example.invalid:0.0.1";
const R0_RUNTIME_CAPABILITY_TYPE = "rich-compose-r0.runtime-capability";
const SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR = 153;
const capabilityInstance = Array.from(crypto.getRandomValues(new Uint8Array(16)),
  (byte) => byte.toString(16).padStart(2, "0")).join("");
const runtimeCapability = browser.runtime.getBrowserInfo().then((browserInfo) => {
  const version = typeof browserInfo?.version === "string" ? browserInfo.version : "";
  const match = /^([1-9]\d*)(?:\.\d+){1,3}(?:esr)?$/iu.exec(version);
  const major = match ? Number.parseInt(match[1], 10) : undefined;
  return {
    buildId: R0_REGISTRATION_BUILD_ID,
    instance: capabilityInstance,
    minimumThunderbirdMajor: SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR,
    sameKindListEligible: Number.isSafeInteger(major) && major >= SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR,
  };
}).catch(() => ({
  buildId: R0_REGISTRATION_BUILD_ID,
  instance: capabilityInstance,
  minimumThunderbirdMajor: SAME_KIND_LIST_MINIMUM_THUNDERBIRD_MAJOR,
  sameKindListEligible: false,
}));

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender?.id !== browser.runtime.id
    || JSON.stringify(Object.keys(message ?? {}).sort()) !== JSON.stringify(["buildId", "type"])
    || message.type !== R0_RUNTIME_CAPABILITY_TYPE
    || message.buildId !== R0_REGISTRATION_BUILD_ID) return undefined;
  return runtimeCapability;
});

void browser.composeScripts.register({ js: [{ file: "compose.js" }] }).then((registration) => {
  globalThis.thunderclawR0ComposeRegistration = registration;
  console.info(`ThunderClaw R0 compose registration ready: ${R0_REGISTRATION_BUILD_ID}`);
}).catch(() => {
  console.error(`ThunderClaw R0 compose registration failed: ${R0_REGISTRATION_BUILD_ID}`);
});
