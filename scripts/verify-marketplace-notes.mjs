export function normalizeMarketplaceNotes(value) {
  if (typeof value !== "string") throw new Error("Marketplace release notes must be a string");
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
}

export function verifyMarketplaceNotes(expected, actual, marketplace) {
  const normalizedExpected = normalizeMarketplaceNotes(expected);
  const normalizedActual = normalizeMarketplaceNotes(actual);
  if (!normalizedExpected) throw new Error("Canonical component release notes must not be empty");
  if (normalizedActual !== normalizedExpected) {
    throw new Error(`${marketplace} release notes do not exactly match the canonical component release notes after normalization`);
  }
  return normalizedExpected;
}
