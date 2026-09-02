import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type CliInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  ref?: () => unknown;
  unref?: () => unknown;
};

export type CliOutput = Writable & {
  isTTY?: boolean;
  columns?: number;
};

export class PairingCliInterruptedError extends Error {
  readonly code = "INTERRUPTED";

  constructor() {
    super("Interrupted");
  }
}

export class PairingCliTerminatedError extends Error {
  readonly code = "TERMINATED";

  constructor(readonly signal: "SIGHUP" | "SIGTERM", readonly exitCode: 129 | 143) {
    super(`Terminated by ${signal}`);
  }
}

export class PairingCliInputError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(message: string) {
    super(message);
  }
}

const SPOOFING_CODE_POINTS = new Set([
  0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c,
  0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff,
]);

function visibleEscape(codePoint: number): string {
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, "0")}}`;
}

export function sanitizeTerminalText(value: string): string {
  let result = "";
  for (const character of value.normalize("NFC")) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      || /[\p{Default_Ignorable_Code_Point}\p{M}\p{Zl}\p{Zp}]/u.test(character)
      || SPOOFING_CODE_POINTS.has(codePoint)) {
      result += visibleEscape(codePoint);
    } else {
      result += character;
    }
  }
  return result;
}

function terminalCellWidth(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3) || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19) || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60) || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f000 && codePoint <= 0x1faff) || (codePoint >= 0x20000 && codePoint <= 0x3fffd))) return 2;
  return 1;
}

export function fitTerminalText(value: string, columns = 100, indent = 0): string {
  const width = Math.max(1, Math.min(100, Math.max(1, columns)) - Math.max(0, indent));
  const characters = [...sanitizeTerminalText(value)];
  if (characters.reduce((sum, character) => sum + terminalCellWidth(character), 0) <= width) return characters.join("");
  if (width <= 3) return ".".repeat(width);
  let used = 0;
  let result = "";
  for (const character of characters) {
    const characterWidth = terminalCellWidth(character);
    if (used + characterWidth > width - 3) break;
    result += character;
    used += characterWidth;
  }
  return `${result}...`;
}

export function asciiTerminalText(value: string): string {
  const punctuation = value.replaceAll("—", "-").replaceAll("–", "-")
    .replace(/[“”]/gu, "\"").replace(/[‘’]/gu, "'").replaceAll("…", "...").replaceAll("·", "-");
  let result = "";
  for (const character of punctuation) {
    const codePoint = character.codePointAt(0)!;
    result += codePoint >= 0x20 && codePoint <= 0x7e || character === "\n" ? character : visibleEscape(codePoint);
  }
  return result;
}

export function safeIdentifierSuffix(identifier: string): string {
  return `...${identifier.slice(-4)}`;
}

export function formatRelativeTime(now: number, timestamp: string): string {
  const delta = Date.parse(timestamp) - now;
  const absolute = Math.abs(delta);
  if (absolute < 60_000) return delta >= 0 ? "less than a minute" : "just now";
  const minutes = Math.floor(absolute / 60_000);
  if (minutes < 60) return delta >= 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return delta >= 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return delta >= 0 ? `${days} day${days === 1 ? "" : "s"}` : `${days} day${days === 1 ? "" : "s"} ago`;
}

export async function promptLine(input: CliInput, output: CliOutput, prompt: string): Promise<string> {
  const promptOwnsFlow = input.readableFlowing !== true;
  if (promptOwnsFlow) input.ref?.();
  const readline = createInterface({ input, output, terminal: input.isTTY === true });
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      readline.once("SIGINT", () => finish(() => reject(new PairingCliInterruptedError())));
      readline.question(prompt, (answer) => finish(() => resolve(answer)));
      readline.once("close", () => finish(() => reject(new PairingCliInputError("Input closed before a response was received"))));
    });
  } finally {
    readline.close();
    if (promptOwnsFlow) input.unref?.();
  }
}

export async function promptHiddenLine(input: CliInput, output: CliOutput, prompt: string): Promise<string> {
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function") {
    throw new PairingCliInputError("Hidden input is unavailable; use --code-stdin from a protected input source");
  }
  const setRawMode = input.setRawMode.bind(input);
  const previousRawMode = input.isRaw === true;
  const previousFlowing = input.readableFlowing;
  const promptOwnsFlow = previousFlowing !== true;
  output.write(prompt);
  let value = "";
  let rawModeEnabled = false;
  let settled = false;
  let finish: ((callback: () => void) => void) | undefined;
  const restoreRawMode = (): boolean => {
    if (!rawModeEnabled || input.isRaw === previousRawMode) return true;
    try { setRawMode(previousRawMode); rawModeEnabled = false; return true; }
    catch { return false; }
  };
  const restoreFlowState = () => {
    if (!promptOwnsFlow) return;
    input.pause();
    input.unref?.();
  };
  const onHangup = () => {
    restoreRawMode();
    finish?.(() => { throw new PairingCliTerminatedError("SIGHUP", 129); });
  };
  const onTerminate = () => {
    restoreRawMode();
    finish?.(() => { throw new PairingCliTerminatedError("SIGTERM", 143); });
  };
  try {
    try {
      setRawMode(true);
      if (input.isRaw !== true) throw new Error("raw mode was not enabled");
      rawModeEnabled = true;
    } catch {
      throw new PairingCliInputError("Hidden input could not be enabled; use --code-stdin from a protected input source");
    }
    if (promptOwnsFlow) input.resume();
    return await new Promise<string>((resolve, reject) => {
      const finishOnce = (callback: () => void) => finish?.(callback);
      const onData = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const byte of bytes) {
          if (byte === 0x03) return finishOnce(() => reject(new PairingCliInterruptedError()));
          if (byte === 0x0a || byte === 0x0d) return finishOnce(() => resolve(value));
          if (byte === 0x7f || byte === 0x08) {
            value = value.slice(0, -1);
            continue;
          }
          if (byte < 0x20 || byte > 0x7e || value.length >= 32) {
            return finishOnce(() => reject(new PairingCliInputError("Approval code input is invalid")));
          }
          value += String.fromCharCode(byte);
        }
      };
      const onEnd = () => finishOnce(() => reject(new PairingCliInputError("Input closed before the approval code was complete")));
      finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("close", onEnd);
        process.off("SIGHUP", onHangup);
        process.off("SIGTERM", onTerminate);
        try { callback(); } catch (error) { reject(error); }
      };
      process.once("SIGHUP", onHangup);
      process.once("SIGTERM", onTerminate);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("close", onEnd);
    });
  } finally {
    process.off("SIGHUP", onHangup);
    process.off("SIGTERM", onTerminate);
    const restorationFailed = !restoreRawMode();
    restoreFlowState();
    output.write("\n");
    if (restorationFailed) {
      throw new PairingCliInputError("Terminal input state could not be restored; restore terminal echo before continuing");
    }
  }
}

export async function readSingleStdinLine(input: CliInput): Promise<string> {
  if (input.isTTY === true) {
    throw new PairingCliInputError("--code-stdin requires a protected pipe or redirected file; it cannot read from an interactive terminal");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 64) throw new PairingCliInputError("Approval code input is too long");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  if (!value.endsWith("\n")) throw new PairingCliInputError("--code-stdin requires one newline-terminated value");
  const withoutNewline = value.endsWith("\r\n") ? value.slice(0, -2) : value.slice(0, -1);
  if (withoutNewline.includes("\n") || withoutNewline.includes("\r")) {
    throw new PairingCliInputError("--code-stdin accepts exactly one value");
  }
  return withoutNewline;
}
