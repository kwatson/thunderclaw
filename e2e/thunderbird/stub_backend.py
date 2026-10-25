from __future__ import annotations

import json
import hashlib
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit


CAPABILITIES = [
    "status:read", "agents:read", "agents:probe", "compose:transform", "message:transform",
    "credential:rotate", "credential:revoke",
]
LEGACY_TOKEN = "thunderclaw-e2e-upgrade-token"
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


def verifier(domain: str, credential: str) -> str:
    prefix = "thunderclaw-device-credential-v1" if domain == "device" else "thunderclaw-pairing-claim-v1"
    return hashlib.sha256(f"{prefix}\0{credential}".encode()).hexdigest()


def future(minutes: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def verified_agent() -> dict[str, Any]:
    return {
        "agentId": "e2e-agent",
        "displayName": "Deterministic E2E agent",
        "isDefault": True,
        "provider": "fixture",
        "model": "fixed-output-v1",
        "reasoning": {"defaultLevel": None, "levels": []},
        "compatibility": {
            "state": "verified",
            "executionMode": "restricted-agent",
            "usesPersonality": True,
            "usesMemory": True,
            "toolsDisabled": True,
            "checks": {
                "configuration": "passed",
                "credentials": "passed",
                "structuredOutput": "passed",
                "toolIsolation": "passed",
                "cancellation": "passed",
                "fallbacks": "not_applicable",
            },
            "lastProbe": {
                "testedAt": "2026-08-09T00:00:00.000Z",
                "observedProvider": "fixture",
                "observedModel": "fixed-output-v1",
            },
            "reason": "Deterministic local test evidence.",
        },
    }


class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.pending: dict[str, dict[str, Any]] = {}
        self.credentials: dict[str, dict[str, Any]] = {}

    def record(self, method: str, path: str, body: dict[str, Any] | None) -> None:
        with self.lock:
            self.requests.append({
                "method": method,
                "path": path,
                "requestId": body.get("requestId") if body else None,
                "runId": body.get("runId") if body else None,
                "selectionShape": body.get("target", {}).get("selectionShape") if body else None,
            })

    def issue(self, body: dict[str, Any]) -> None:
        with self.lock:
            self.pending[body["requestId"]] = dict(body)

    def claim(self, credential: str) -> dict[str, Any] | None:
        request_id = credential.split(".", 1)[0]
        with self.lock:
            pending = self.pending.get(request_id)
            if pending is None or verifier("claim", credential) != pending["claimVerifier"]:
                return None
            self.pending.pop(request_id)
            device = {
                "credentialId": pending["credentialId"],
                "deviceId": pending["deviceId"],
                "deviceName": pending["deviceName"],
                "capabilities": CAPABILITIES,
                "expiresAt": future(60 * 24),
                "verifier": pending["credentialVerifier"],
            }
            self.credentials[device["credentialId"]] = device
            return device

    def authenticate(self, credential: str) -> dict[str, Any] | None:
        credential_id = credential.split(".", 1)[0]
        with self.lock:
            device = self.credentials.get(credential_id)
            return device if device is not None and verifier("device", credential) == device["verifier"] else None

    def rotate(self, current: str, body: dict[str, Any]) -> dict[str, Any] | None:
        device = self.authenticate(current)
        if device is None:
            return None
        replacement = {
            **device,
            "credentialId": body["credentialId"],
            "verifier": body["credentialVerifier"],
            "expiresAt": future(60 * 24),
        }
        with self.lock:
            self.credentials.pop(device["credentialId"], None)
            self.credentials[replacement["credentialId"]] = replacement
        return replacement

    def revoke(self, credential: str) -> bool:
        device = self.authenticate(credential)
        if device is None:
            return False
        with self.lock:
            self.credentials.pop(device["credentialId"], None)
        return True


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
        credential = self._bearer()
        if credential == LEGACY_TOKEN:
            return True
        if credential is not None and self.server.state.authenticate(credential) is not None:
            return True
        self._json(401, {"error": {"code": "UNAUTHORIZED", "message": "Unauthorized"}})
        return False

    def _bearer(self) -> str | None:
        value = self.headers.get("Authorization", "")
        return value.removeprefix("Bearer ") if value.startswith("Bearer ") else None

    def _device_response(self, device: dict[str, Any]) -> dict[str, Any]:
        return {"protocolVersion": 1, "device": {
            key: device[key] for key in ("credentialId", "deviceId", "deviceName", "capabilities", "expiresAt")
        }}

    def _body(self) -> dict[str, Any]:
        size = int(self.headers.get("Content-Length", "0"))
        value = json.loads(self.rfile.read(size))
        if not isinstance(value, dict):
            raise ValueError("request must be an object")
        return value

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/v1/models":
            if self._bearer() != INFERENCE_KEY:
                self._json(401, {"error": {"message": "Synthetic inference key required"}})
                return
            self.server.state.record("GET", "/v1/models", None)
            self._json(200, {"object": "list", "data": [{"id": "fixture-model", "object": "model"}]})
            return
        if not self._authorized():
            return
        path = urlsplit(self.path).path
        query = urlsplit(self.path).query
        if path == "/thunderclaw/v1/status":
            self.server.state.record("GET", path, None)
            self._json(200, {
                "protocolVersion": 1,
                "plugin": "thunderclaw",
                "gatewayVersion": "e2e-stub-v1",
                "capabilities": {"transform": True, "cancellation": "compose", "richBlockReplacement": True},
            })
            return
        if path == "/thunderclaw/v1/agents":
            request_id = ""
            for item in query.split("&"):
                if item.startswith("requestId="):
                    request_id = item.removeprefix("requestId=")
            self.server.state.record("GET", path, {"requestId": request_id})
            self._json(200, {"protocolVersion": 1, "requestId": request_id, "agents": [verified_agent()]})
            return
        self._json(404, {"error": {"code": "NOT_FOUND", "message": "Not found"}})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        try:
            body = self._body() if int(self.headers.get("Content-Length", "0")) else {}
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": {"code": "INVALID_REQUEST", "message": "Invalid request"}})
            return
        if path == "/v1/chat/completions":
            if self._bearer() != INFERENCE_KEY:
                self._json(401, {"error": {"message": "Synthetic inference key required"}})
                return
            # This native setup selects the DeepSeek preset with its default settings.
            if body.get("thinking") != {"type": "disabled"}:
                self._json(400, {"error": {"message": "DeepSeek thinking must default off"}})
                return
            if body.get("max_tokens") != 16384:
                self._json(400, {"error": {"message": "Response tokens must use the saved default"}})
                return
            self.server.state.record("POST", path, None)
            try:
                prompt = json.loads(body["messages"][-1]["content"])
                if "segments" in prompt:
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
        if path == "/thunderclaw/pairing/v1/requests":
            self.server.state.issue(body)
            self.server.state.record("POST", path, body)
            self._json(201, {"protocolVersion": 1, "requestId": body["requestId"],
                "approvalCode": "ABCDE-FGHIJ", "expiresAt": future(5)})
            return
        if path == "/thunderclaw/pairing/v1/claim":
            credential = self._bearer()
            device = self.server.state.claim(credential or "")
            if device is None:
                self._json(401, {"error": {"code": "AUTHENTICATION_FAILED", "message": "Unauthorized"}})
            else:
                self.server.state.record("POST", path, None)
                self._json(200, self._device_response(device))
            return
        if path == "/thunderclaw/pairing/v1/rotate":
            device = self.server.state.rotate(self._bearer() or "", body)
            if device is None:
                self._json(401, {"error": {"code": "AUTHENTICATION_FAILED", "message": "Unauthorized"}})
            else:
                self.server.state.record("POST", path, body)
                self._json(200, self._device_response(device))
            return
        if path == "/thunderclaw/pairing/v1/revoke":
            if not self.server.state.revoke(self._bearer() or ""):
                self._json(401, {"error": {"code": "AUTHENTICATION_FAILED", "message": "Unauthorized"}})
            else:
                self.server.state.record("POST", path, None)
                self._json(200, {"protocolVersion": 1, "revoked": True})
            return
        if not self._authorized():
            return
        self.server.state.record("POST", path, body)
        if path == "/thunderclaw/v1/compose/open":
            self._json(201, {
                "protocolVersion": 1,
                "requestId": body["requestId"],
                "composeId": body["composeId"],
                "composeGeneration": body["composeGeneration"],
                "sessionId": f"fixture-{body['composeId']}",
            })
            return
        if path == "/thunderclaw/v1/compose/transform":
            target = body["target"]
            replacement = (
                "Polished opening that should wrap naturally\n"
                "without a forced line break.\n\n"
                "A separate paragraph should also wrap\n"
                "naturally in Thunderbird."
            )
            if target.get("selectionShape") == "rich-blocks":
                blocks = [{
                    "type": "unordered_list",
                    "items": [
                        {"spans": [{"text": "Automated testing"}]},
                        {"spans": [{"text": "Water level monitoring"}]},
                        {"spans": [{"text": "Wireless reporting"}]},
                    ],
                }]
                if body.get("instruction") == "split this into two paragraphs":
                    blocks = [
                        {"type": "paragraph", "spans": [{"text": "Quick update: the cPanel API is finished."}]},
                        {"type": "paragraph", "spans": [{"text": "I'll update our API documentation later this week."}]},
                    ]
                operation = {
                    "type": "replace_rich_blocks",
                    "targetId": target["targetId"],
                    "blocks": blocks,
                }
            else:
                operation = {
                    "type": "replace_text_range",
                    "targetId": target["targetId"],
                    "start": target["start"],
                    "end": target["end"],
                    "text": replacement,
                }
            self._json(200, {
                "protocolVersion": 1,
                "runId": body["runId"],
                "result": {
                    "version": 1,
                    "requestId": body["requestId"],
                    "composeGeneration": body["composeGeneration"],
                    "contextHash": body["contextHash"],
                    "targetHash": body["targetHash"],
                    "operations": [operation],
                    "summary": "Deterministic compose replacement.",
                },
                "evidence": {"runtimeSessionMarker": None, "repairAttempted": False},
            })
            return
        if path == "/thunderclaw/v1/compose/close":
            self._json(200, {
                "protocolVersion": 1,
                "requestId": body["requestId"],
                "composeId": body["composeId"],
                "composeGeneration": body["composeGeneration"],
                "closed": True,
            })
            return
        if path == "/thunderclaw/v1/compose/cancel":
            self._json(202, {
                "protocolVersion": 1,
                "requestId": body["requestId"],
                "runId": body["runId"],
                "cancelled": True,
            })
            return
        self._json(404, {"error": {"code": "NOT_FOUND", "message": "Not found"}})


class StubServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], state: State):
        super().__init__(address, Handler)
        self.state = state


def start_stub() -> tuple[StubServer, State, threading.Thread]:
    state = State()
    server = StubServer(("127.0.0.1", 0), state)
    thread = threading.Thread(target=server.serve_forever, name="thunderclaw-stub", daemon=True)
    thread.start()
    return server, state, thread
