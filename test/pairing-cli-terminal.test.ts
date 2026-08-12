import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  fitTerminalText,
  PairingCliInputError,
  PairingCliInterruptedError,
  promptHiddenLine,
  readSingleStdinLine,
  sanitizeTerminalText,
} from "../packages/openclaw-plugin/src/pairing-cli-terminal.js";

test("terminal text preserves ordinary Unicode and visibly escapes control and spoofing characters", () => {
  assert.equal(sanitizeTerminalText("Málaga 日本語 🦞"), "Málaga 日本語 🦞");
  assert.equal(
    sanitizeTerminalText("safe\u001b[31m\u202Espoof\u200B\u034F\uFE0F\u2028\ud800"),
    "safe\\u{001B}[31m\\u{202E}spoof\\u{200B}\\u{034F}\\u{FE0F}\\u{2028}\\u{D800}",
  );
  const fitted = fitTerminalText("x".repeat(200), 80, 5);
  assert.equal([...fitted].length, 75);
  assert.ok(fitted.endsWith("..."));
  assert.equal(fitTerminalText("abcdef", 5, 2), "...");
  assert.equal(fitTerminalText("日本abc", 8, 0), "日本abc");
  assert.equal(fitTerminalText("日本abcde", 8, 0), "日本a...");
});

test("stdin code input requires exactly one bounded newline-terminated value", async () => {
  const valid = new PassThrough();
  valid.end("abcde-fghij\n");
  assert.equal(await readSingleStdinLine(valid), "abcde-fghij");

  for (const value of ["abcde-fghij", "abcde-fghij\nsecond\n", `${"x".repeat(65)}\n`]) {
    const input = new PassThrough();
    input.end(value);
    await assert.rejects(() => readSingleStdinLine(input), PairingCliInputError);
  }
});

test("hidden input never echoes the code and restores raw mode on success and Ctrl+C", async () => {
  for (const bytes of [Buffer.from("abcde-fghij\r"), Buffer.from([0x03])]) {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
    input.isTTY = true;
    input.isRaw = false;
    const modes: boolean[] = [];
    input.setRawMode = (mode) => { modes.push(mode); input.isRaw = mode; };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    let rendered = "";
    output.on("data", (chunk) => { rendered += chunk.toString(); });
    const pending = promptHiddenLine(input, output, "Approval code: ");
    input.write(bytes);
    if (bytes[0] === 0x03) await assert.rejects(() => pending, PairingCliInterruptedError);
    else assert.equal(await pending, "abcde-fghij");
    assert.deepEqual(modes, [true, false]);
    assert.equal(input.readableFlowing, false);
    assert.equal(rendered, "Approval code: \n");
    assert.equal(rendered.includes("abcde"), false);
  }
});

test("hidden input restores stream flow ownership without pausing an existing consumer", async () => {
  for (const initiallyFlowing of [false, true]) {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
      unref(): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => { input.isRaw = mode; };
    let unrefs = 0;
    input.unref = () => { unrefs += 1; };
    if (initiallyFlowing) input.resume();
    assert.equal(input.readableFlowing, initiallyFlowing ? true : null);
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;

    const pending = promptHiddenLine(input, output, "Approval code: ");
    input.write("abcde-fghij\r");
    assert.equal(await pending, "abcde-fghij");
    assert.equal(input.readableFlowing, initiallyFlowing);
    assert.equal(unrefs, initiallyFlowing ? 0 : 1);
  }
});

test("hidden input fails closed when raw mode is unavailable", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  output.isTTY = true;
  await assert.rejects(() => promptHiddenLine(input, output, "Approval code: "), PairingCliInputError);

  const failing = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  failing.isTTY = true;
  failing.isRaw = false;
  failing.setRawMode = () => { throw new Error("unsupported terminal"); };
  await assert.rejects(
    () => promptHiddenLine(failing, output, "Approval code: "),
    (error: unknown) => error instanceof PairingCliInputError && error.message.includes("--code-stdin"),
  );
});

test("hidden input restores raw mode and rejects with termination semantics on SIGHUP and SIGTERM", async () => {
  for (const [signal, exitCode] of [["SIGHUP", 129], ["SIGTERM", 143]] as const) {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
    input.isTTY = true;
    input.isRaw = false;
    const modes: boolean[] = [];
    input.setRawMode = (mode) => { modes.push(mode); input.isRaw = mode; };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = true;
    const pending = promptHiddenLine(input, output, "Approval code: ");
    process.emit(signal);
    await assert.rejects(pending, (error: unknown) => {
      return error instanceof Error && (error as Error & { signal?: string; exitCode?: number }).signal === signal
        && (error as Error & { exitCode?: number }).exitCode === exitCode;
    });
    assert.deepEqual(modes, [true, false]);
    assert.equal(input.isRaw, false);
    assert.equal(input.readableFlowing, false);
  }
});
