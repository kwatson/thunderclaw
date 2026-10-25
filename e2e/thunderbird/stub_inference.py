from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit


INFERENCE_KEY = "thunderclaw-synthetic-e2e-key"
RICH_FORMATTING_INSTRUCTION = "preserve the original emphasis and change draft to final"
RICH_SOURCE_TEXT = "This draft keeps important and timely details."
RICH_SOURCE_BLOCKS = [{"type": "paragraph", "spans": [
    {"text": "This "}, {"text": "draft", "marks": ["bold"]},
    {"text": " keeps "}, {"text": "important", "marks": ["italic"]},
    {"text": " and "}, {"text": "timely", "marks": ["underline"]}, {"text": " details."},
]}]


def rich_formatting_output(prompt: dict[str, Any]) -> dict[str, Any]:
    # Gate this response on the actual original source. A fixed formatted response
    # alone would pass even if capture silently flattened the selection.
    if (prompt.get("instruction") != RICH_FORMATTING_INSTRUCTION
            or prompt.get("selectionShape") != "rich-blocks"
            or prompt.get("text") != RICH_SOURCE_TEXT
            or prompt.get("blocks") != RICH_SOURCE_BLOCKS):
        raise ValueError("Original rich source blocks and marks were not forwarded")
    blocks = json.loads(json.dumps(RICH_SOURCE_BLOCKS))
    blocks[0]["spans"][1]["text"] = "final"
    for span in blocks[0]["spans"]:
        span.setdefault("marks", [])
    return {"blocks": blocks, "summary": "Original source formatting verified; changed draft to final."}


class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []

    def record(self, method: str, path: str, metadata: dict[str, Any] | None) -> None:
        with self.lock:
            self.requests.append({"method": method, "path": path, **(metadata or {})})


class Handler(BaseHTTPRequestHandler):
    server: "StubServer"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _json(self, status: int, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _authorized(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {INFERENCE_KEY}":
            return True
        self._json(401, {"error": {"message": "Synthetic inference key required"}})
        return False

    def do_GET(self) -> None:
        if not self._authorized():
            return
        if urlsplit(self.path).path == "/v1/models":
            self.server.state.record("GET", "/v1/models", None)
            self._json(200, {"object": "list", "data": [{"id": "fixture-model", "object": "model"}]})
        else:
            self._json(404, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:
        if not self._authorized():
            return
        path = urlsplit(self.path).path
        if path == "/v1/chat/completions":
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 1_000_000:
                    raise ValueError("Invalid request size")
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError("Invalid request")
            except (ValueError, json.JSONDecodeError):
                self._json(400, {"error": {"message": "Invalid synthetic request"}})
                return
            # This native setup selects the DeepSeek preset with its default settings.
            if body.get("thinking") != {"type": "disabled"}:
                self._json(400, {"error": {"message": "DeepSeek thinking must default off"}})
                return
            if body.get("max_tokens") != 16384:
                self._json(400, {"error": {"message": "Response tokens must use the saved default"}})
                return
            try:
                prompt = json.loads(body["messages"][-1]["content"])
                self.server.state.record("POST", path, {
                    "action": prompt.get("action"), "sourceLanguage": prompt.get("sourceLanguage"),
                    "segments": len(prompt.get("segments", [])),
                    "sourceCharacters": sum(len(text) for text in prompt.get("segments", [])),
                })
                if "segments" in prompt:
                    # Only the adapter's exact bounded connection probe may be short.
                    # Every received UI operation must forward the long fixture,
                    # even if a broken capture silently drops most segments.
                    connection_probe = (prompt.get("action") == "translate"
                        and prompt.get("sourceLanguage") == "English"
                        and prompt.get("targetLanguage") == "French"
                        and prompt["segments"] == ["Hello.", "Thank you."])
                    if not connection_probe and (prompt.get("sourceLanguage") is not None
                            or sum(len(text) for text in prompt["segments"]) <= 40_000):
                        raise ValueError("The full long received fixture must use actual automatic detection")
                    if prompt["action"] == "translate":
                        output = {"detectedLanguage": "en", "translations": ["Bonjour." for _ in prompt["segments"]]}
                    else:
                        output = {"detectedLanguage": "en", "summary": {"title": "Summary", "bullets": ["A synthetic message summary."]}}
                elif prompt.get("instruction") == RICH_FORMATTING_INSTRUCTION or prompt.get("text") == RICH_SOURCE_TEXT:
                    output = rich_formatting_output(prompt)
                    with self.server.state.lock:
                        self.server.state.requests.append({
                            "method": "ASSERT", "path": path, "richSourceBlocksVerified": True,
                        })
                elif prompt.get("selectionShape") == "rich-blocks":
                    blocks = [{"type": "unordered_list", "items": [
                        {"spans": [{"text": text, "marks": []}]} for text in ["Automated testing", "Water level monitoring", "Wireless reporting"]
                    ]}]
                    if prompt.get("instruction") == "split this into two paragraphs":
                        blocks = [{"type": "paragraph", "spans": [{"text": text, "marks": []}]} for text in ["Quick update: the cPanel API is finished.", "I'll update our API documentation later this week."]]
                    output = {"blocks": blocks, "summary": "Deterministic compose replacement."}
                elif prompt.get("selectionShape") == "flat-list-items":
                    output = {"items": prompt.get("items", []), "summary": "Deterministic list replacement."}
                elif prompt.get("text") == "Hello.":
                    output = {"text": "Hello.", "summary": "No correction needed."}
                else:
                    output = {"text": "Polished opening that should wrap naturally\nwithout a forced line break.\n\nA separate paragraph should also wrap\nnaturally in Thunderbird.", "summary": "Deterministic compose replacement."}
                self._json(200, {"id": "synthetic-completion", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(output)}, "finish_reason": "stop"}]})
            except (KeyError, ValueError, TypeError):
                self._json(400, {"error": {"message": "Invalid synthetic request"}})
            return
        self._json(404, {"error": {"message": "Not found"}})


class StubServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], state: State):
        super().__init__(address, Handler)
        self.state = state


def start_stub() -> tuple[StubServer, State, threading.Thread]:
    state = State()
    server = StubServer(("127.0.0.1", 0), state)
    thread = threading.Thread(target=server.serve_forever, name="thunderclaw-inference-stub", daemon=True)
    thread.start()
    return server, state, thread
