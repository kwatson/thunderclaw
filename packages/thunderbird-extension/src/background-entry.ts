import { installOptionsConnectionController } from "./connection-controller.js";
import { installFeatureBackground } from "./background-coordinator.js";
import { createComposeScriptRegistrar } from "./compose-script-registration.js";

declare const browser: any;

const ensureComposeScriptRegistered = createComposeScriptRegistrar(browser.composeScripts);

void ensureComposeScriptRegistered().then(
  () => {
    const controller = installOptionsConnectionController();
    installFeatureBackground(controller);
  },
  () => undefined,
);
