import { rename, writeFile } from "node:fs/promises";
interface PublicationInspection { exists: boolean; evidence?: string }
export function inspectPublication(options: { root: string; tag: string; version: string; fetchImpl?: typeof fetch }): Promise<PublicationInspection>;
export function prepareNextRelease(options: { root: string; version: string; inspect?: (options: { root: string; tag: string; version: string }) => Promise<PublicationInspection>; date?: string; io?: { writeFile: typeof writeFile; rename: typeof rename } }): Promise<{ version: string; tag: string; files: string[]; releaseNotes: string }>;
