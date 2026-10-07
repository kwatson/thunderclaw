import type { ReleaseState } from "./openclaw-release-state.mjs";
export function reconcileAuthorizedTag(input: {state: ReleaseState; repository: string; api: (method: string, path: string, payload?: any, options?: {allowNotFound?: boolean}) => any; assertEnabled: () => any}): Promise<{action: "verified" | "created"; tag: string}>;
