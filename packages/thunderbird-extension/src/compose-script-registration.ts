export type RegisteredComposeScript = {
  unregister(): Promise<void>;
};

export type ComposeScriptsApi = {
  register(options: { js: Array<{ file: string }> }): Promise<RegisteredComposeScript>;
};

const COMPOSE_SCRIPT_OPTIONS = { js: [{ file: "compose.js" }] };

export function createComposeScriptRegistrar(api: ComposeScriptsApi): () => Promise<RegisteredComposeScript> {
  let registration: Promise<RegisteredComposeScript> | undefined;
  return () => {
    // A background-page lifetime makes at most one registration attempt. A
    // fresh lifetime registers again, while repeated calls share this result.
    registration ??= Promise.resolve().then(() => api.register(COMPOSE_SCRIPT_OPTIONS));
    return registration;
  };
}
