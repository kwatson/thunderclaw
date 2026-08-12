// OpenClaw 2026.7.2-beta.7 publishes this public JavaScript subpath but omits
// its declaration file. Keep this narrow compatibility declaration until the
// upstream package ships the matching types.
declare module "openclaw/plugin-sdk/agent-sessions" {
  type RunParams = Parameters<
    import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]
  >[0];
  type Manager = NonNullable<RunParams["sessionManager"]>;

  export const SessionManager: {
    inMemory(cwd?: string): Manager;
  };
}
