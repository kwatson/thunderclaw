export interface ReleaseManifests {
  [name: string]: unknown;
}

export interface ReleaseMetadata {
  tag: string;
  version: string;
  notes: string;
  manifests: ReleaseManifests;
}

export function versionFromTag(tag: unknown): string;
export function extractChangelogSection(changelog: unknown, version: unknown): string;
export function validateManifestVersions(version: string, manifests: ReleaseManifests): void;
export function prepareRelease(options: {
  root: string;
  tag: string;
  notesOutput?: string;
}): Promise<ReleaseMetadata>;
