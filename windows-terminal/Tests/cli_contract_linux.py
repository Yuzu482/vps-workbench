"""Exercise actual CLI binaries against a loopback-only synthetic provider.

The outer bwrap network namespace has no route to any real model service. The
fake server records only fixed fixture prompts and a generated 1px image.
"""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import uuid


def event(name, value):
    return ("event: " + name + "\ndata: " + json.dumps(value, separators=(",", ":")) + "\n\n").encode()


class Handler(BaseHTTPRequestHandler):
    calls = {"codex": [], "claude": []}
    paths = []
    def log_message(self, *_): pass
    def do_GET(self):
        raw = b'{"data":[]}'
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_POST(self):
        self.paths.append(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try: request = json.loads(body)
        except (ValueError, UnicodeError): request = {"invalid": True}
        if self.path.split("?", 1)[0].endswith("/responses"):
            kind = "codex"; self.calls[kind].append(request)
            answer = "codex-fixture-answer-" + str(len(self.calls[kind])); rid = "resp_fixture_" + str(len(self.calls[kind]))
            item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": answer, "annotations": []}]}
            response = {"id": rid, "object": "response", "created_at": 1, "status": "completed", "model": "gpt-5.1-codex-mini", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}
            raw = event("response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}})
            raw += event("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}})
            raw += event("response.output_text.delta", {"type": "response.output_text.delta", "item_id": "msg_fixture", "output_index": 0, "content_index": 0, "delta": answer})
            raw += event("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item})
            raw += event("response.completed", {"type": "response.completed", "response": response})
        elif self.path.split("?", 1)[0].endswith("/messages"):
            kind = "claude"; self.calls[kind].append(request)
            answer = "claude-fixture-answer-" + str(len(self.calls[kind]))
            message = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
            raw = event("message_start", {"type": "message_start", "message": message})
            raw += event("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            raw += event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": answer}})
            raw += event("content_block_stop", {"type": "content_block_stop", "index": 0})
            raw += event("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}})
            raw += event("message_stop", {"type": "message_stop"})
        else:
            raw = b'{"error":{"type":"not_found_error","message":"fixture endpoint"}}'
            self.send_response(404); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)


def run(command, environment):
    result = subprocess.run(command, cwd="/fixture/project", env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=80)
    if result.returncode:
        raise RuntimeError("fixture CLI failed " + str(result.returncode) + ": " + result.stderr.decode("utf-8", "replace")[-2500:] + "\n" + result.stdout.decode("utf-8", "replace")[-1000:])
    return [json.loads(line) for line in result.stdout.decode("utf-8").splitlines() if line.startswith("{")]


def inner():
    Path("/fixture/project").mkdir(); Path("/fixture/home").mkdir(); Path("/fixture/codex-home").mkdir(); Path("/fixture/claude-home").mkdir()
    image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmXsAAAAASUVORK5CYII=")
    Path("/fixture/one.png").write_bytes(image)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler); threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    base = {"HOME": "/fixture/home", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TERM": "dumb", "NO_PROXY": "127.0.0.1,localhost"}
    env = {**base, "CODEX_HOME": "/fixture/codex-home", "OPENAI_API_KEY": "fixture-only"}
    provider = 'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:' + str(port) + '/v1",wire_api="responses",env_key="OPENAI_API_KEY"}'
    config = ["-c", 'model_provider="fixture"', "-c", provider, "-c", 'model="gpt-5.1-codex-mini"']
    codex = "/fixture/codex"
    first = run([codex, "exec", "--sandbox", "read-only", "--json", "--skip-git-repo-check", "--ignore-user-config", *config,
                 "--image=/fixture/one.png", "--", "codex-first-marker"], env)
    ids = [x.get("thread_id") for x in first if x.get("type") == "thread.started"]
    if len(ids) != 1 or not any(x.get("type") == "turn.completed" for x in first): raise RuntimeError("Codex first turn did not complete")
    shutil.rmtree("/fixture/home"); Path("/fixture/home").mkdir()
    second = run([codex, "exec", "--sandbox", "read-only", "resume", "--json", "--skip-git-repo-check", "--ignore-user-config", *config,
                  ids[0], "--", "codex-second-marker"], env)
    if not any(x.get("type") == "thread.started" and x.get("thread_id") == ids[0] for x in second) or not any(x.get("type") == "turn.completed" for x in second):
        raise RuntimeError("Codex native session did not resume")
    if len(Handler.calls["codex"]) != 2 or "codex-first-marker" not in json.dumps(Handler.calls["codex"][1]) or "codex-second-marker" not in json.dumps(Handler.calls["codex"][1]):
        raise RuntimeError("Codex continuation did not send prior conversation")
    if "image" not in json.dumps(Handler.calls["codex"][0]): raise RuntimeError("Codex image was not sent: " + json.dumps(Handler.calls["codex"][0])[-2500:])
    print("PASS: actual Codex CLI native resume, prior context and image against isolated fixture", flush=True)
    # Claude's real CLI reads the same stream-json structure emitted by the runner.
    env = {**base, "CLAUDE_CONFIG_DIR": "/fixture/claude-home", "ANTHROPIC_API_KEY": "fixture-only",
           "ANTHROPIC_BASE_URL": "http://127.0.0.1:" + str(port), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1"}
    session = str(uuid.uuid4()); common = ["/fixture/claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--strict-mcp-config", "--permission-prompts", "none", "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--add-dir", "/fixture"]
    def claude(args, text, include_image):
        content = [{"type": "text", "text": text}]
        if include_image: content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(image).decode()}})
        data = (json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n").encode()
        result = subprocess.run([*common, *args], cwd="/fixture/project", env=env, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=80)
        if result.returncode: raise RuntimeError("Claude fixture failed " + str(result.returncode) + " paths=" + repr(Handler.paths) + ": " + result.stderr.decode("utf-8", "replace")[-2500:] + "\n" + result.stdout.decode("utf-8", "replace")[-1000:])
        return [json.loads(line) for line in result.stdout.decode("utf-8").splitlines() if line.startswith("{")]
    a = claude(["--session-id", session], "claude-first-marker", True)
    shutil.rmtree("/fixture/home"); Path("/fixture/home").mkdir()
    b = claude(["--resume", session], "claude-second-marker", False)
    for value in (a, b):
        if not any(x.get("type") == "system" and x.get("subtype") == "init" and x.get("session_id") == session for x in value) or not any(x.get("type") == "result" and x.get("subtype") == "success" and x.get("is_error") is False and x.get("session_id") == session for x in value):
            raise RuntimeError("Claude session events were incomplete: " + repr(value)[-2000:])
    if len(Handler.calls["claude"]) < 2 or "claude-first-marker" not in json.dumps(Handler.calls["claude"][-1]) or "claude-second-marker" not in json.dumps(Handler.calls["claude"][-1]):
        raise RuntimeError("Claude continuation did not send prior conversation")
    if '"type": "image"' not in json.dumps(Handler.calls["claude"][0]): raise RuntimeError("Claude image was not sent")
    print("PASS: actual Claude CLI native resume, prior context and image against isolated fixture", flush=True)
    server.shutdown()


def outer(codex_archive, claude_archive):
    with tempfile.TemporaryDirectory(prefix="remote-cli-contract-") as directory:
        root = Path(directory)
        for archive, wanted, name in ((codex_archive, "/bin/codex", "codex"), (codex_archive, "/bin/codex-code-mode-host", "codex-code-mode-host"),
                                      (claude_archive, "/claude", "claude")):
            with tarfile.open(archive, "r:gz") as tar:
                matches = [x for x in tar if x.name.endswith(wanted) and x.isfile()]
                if len(matches) != 1: raise RuntimeError("CLI fixture binary not found")
                with tar.extractfile(matches[0]) as source, (root / name).open("wb") as target: shutil.copyfileobj(source, target)
            (root / name).chmod(0o700)
        shutil.copyfile(__file__, root / "inner.py")
        command = ["/usr/bin/bwrap", "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
                   "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
                   "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", str(root), "/fixture", "--chdir", "/fixture", "--clearenv",
                   "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8", "--", "/usr/bin/python3", "-B", "/fixture/inner.py", "--inner"]
        result = subprocess.run(command, timeout=200)
        if result.returncode: raise SystemExit(result.returncode)


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    elif len(sys.argv) == 3: outer(sys.argv[1], sys.argv[2])
    else: raise SystemExit("expected two local CLI archives")
