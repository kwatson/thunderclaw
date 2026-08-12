export interface DcoFailure {
  commit: string;
  authorName: string;
  authorEmail: string;
}

export function validAuthorSignoff(
  authorEmail: string,
  trailers: string[],
): boolean;

export function checkRange(base: string, head: string): DcoFailure[];
