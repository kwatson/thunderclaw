import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOpenClawQualification } from "./openclaw-qualification.mjs";

try {
  if (process.argv.length !== 2) throw new Error("Usage: verify-openclaw-qualification.mjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(`${JSON.stringify(await verifyOpenClawQualification({ root }))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
