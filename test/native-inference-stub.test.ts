import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const python = process.platform === "win32" ? "python" : "python3";
const pythonAvailable = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0;

test("native inference stub rejects truncated received captures and manual language hints while permitting its exact connection probe", {
  skip: pythonAvailable ? false : "Python is required for this native-fixture regression; ordinary TypeScript tests remain available",
}, () => {
  const result = spawnSync(python, ["-c", String.raw`
import json, sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError
sys.path.insert(0, "e2e/thunderbird")
from stub_inference import start_stub, INFERENCE_KEY
server, state, thread = start_stub()
def request(prompt):
    body = {"thinking": {"type": "disabled"}, "max_tokens": 16384,
            "messages": [{"role": "user", "content": json.dumps(prompt)}]}
    request = Request(f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
        data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {INFERENCE_KEY}", "Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=5) as response:
            return response.status
    except HTTPError as error:
        return error.code
try:
    probe = {"action": "translate", "sourceLanguage": "English", "targetLanguage": "French", "segments": ["Hello.", "Thank you."]}
    assert request(probe) == 200
    for action in ("summarize", "translate"):
        prompt = {"action": action, "sourceLanguage": None, "targetLanguage": "French", "segments": ["Synthetic newsletter."]}
        assert request(prompt) == 400, "a one-segment capture must not bypass the full-source guard"
        prompt["segments"] = ["Synthetic paragraph."] * 99
        assert request(prompt) == 400, "captures below the old 100-segment threshold must fail"
        prompt["segments"] = ["x" * 40000]
        assert request(prompt) == 400, "the source must exceed 40,000 characters"
        prompt["segments"] = ["x" * 40001]
        assert request(prompt) == 200, "full-source verification must not depend on segment count"
        prompt["sourceLanguage"] = "English"
        assert request(prompt) == 400, "manual source-language hints must fail native auto-detection coverage"
    assert request({**probe, "segments": ["Hello.", "Different text."]}) == 400
    assert request({**probe, "action": "summarize"}) == 400
    assert request({**probe, "targetLanguage": "Spanish"}) == 400
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=5)
`], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
