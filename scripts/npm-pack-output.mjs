export function npmPackFilename(packed, packageName, version) {
  // npm 11 emits an array; npm 12 emits an object keyed by package name.
  const entries = Array.isArray(packed) ? packed
    : packed !== null && typeof packed === "object"
      && Object.keys(packed).length === 1 && Object.keys(packed)[0] === packageName
      ? [packed[packageName]] : [];
  const entry = entries[0];
  if (entries.length !== 1 || entry?.name !== packageName || entry?.version !== version
      || typeof entry.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(entry.filename)) {
    throw new Error("npm pack did not return exactly one safe archive for the expected package and version");
  }
  return entry.filename;
}
