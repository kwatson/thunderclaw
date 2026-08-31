export function providerRepairObserved(records) {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  if (ordered.some((record) => !Number.isSafeInteger(record.sequence) || record.sequence < 1)) {
    throw new Error("provider evidence has an invalid request sequence");
  }
  const finalStart = ordered.map((record) => record.roles.length).lastIndexOf(2);
  if (finalStart < 0) throw new Error("provider evidence has no initial model request");
  return ordered.slice(finalStart).length > 1;
}
