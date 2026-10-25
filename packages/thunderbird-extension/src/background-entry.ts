import { installInferenceConnectionController } from "./inference-connection-controller.js";
import { installFeatureBackground } from "./background-coordinator.js";
import { createComposeScriptRegistrar } from "./compose-script-registration.js";

declare const browser: any;

const ensureComposeScriptRegistered = createComposeScriptRegistrar(browser.composeScripts);
// Settings must receive ports during startup, independently of compose registration.
const controller = installInferenceConnectionController();

void ensureComposeScriptRegistered().then(
  () => {
    installFeatureBackground(controller);
  },
  () => undefined,
);
