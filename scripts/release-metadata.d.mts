export interface ReleaseManifests {
  [name: string]: unknown;
}

export interface ReleaseMetadata {
  component: ReleaseComponent;
  tag: string;
  version: string;
  notes: string;
  manifests: ReleaseManifests;
}

export type ReleaseComponent = "openclaw-plugin" | "thunderbird-extension";
export const releaseComponents: ReleaseComponent[];
export function parseReleaseTag(tag: unknown): {
  component: ReleaseComponent;
  version: string;
  tag: string;
};
export function versionFromTag(tag: unknown): string;
export function extractChangelogSection(changelog: unknown, component: unknown, version: unknown): string;
export function validateManifestVersions(version: string, manifests: ReleaseManifests): void;
export function prepareRelease(options: {
  root: string;
  tag: string;
  notesOutput?: string;
}): Promise<ReleaseMetadata>;
