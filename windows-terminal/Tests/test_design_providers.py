"""Exercise the compiled Windows bridge with local stand-ins for the SSH start/status boundary."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid


RUNTIME = Path(os.environ.get("VPS_WORKBENCH_TEST_BRIDGE") or
               Path(__file__).resolve().parents[1] / "DshChatBridge/bin/Debug/net10.0-windows")
HTML = "\x60\x60\x60html\n<html><title>Frozen</title>" + "x" * 11000 + "</html>\n\x60\x60\x60"
BOUNDARY = r'''
import json
from pathlib import Path
import sys
args = sys.argv
receipt = Path(args[args.index("--receipt") + 1])
task = json.loads(receipt.read_text())["task_id"]
capture = receipt.with_suffix(".payload")
if "--id" in args:
    with capture.open("xb") as output:
        output.write(sys.stdin.buffer.read())
    packet = {"outcome": "accepted"}
else:
    data = json.loads(capture.read_bytes())
    config, command = data["chatInput"], data["command"]
    html = (Path(__file__).parent / "fixture.html").read_text()
    if config.get("prompt") == "credential failure":
        if "--stderr" in args:
            sys.stdout.buffer.write(("private fixture secret\n未启动 Claude API 请求。请挂载该 VPS 用户的 LUKS2 加密家目录，并配置权限为 0600 的 API 凭据。\n").encode())
            sys.exit(0)
        if "--output" in args:
            sys.exit(0)
        packet = {"state": "finished", "exit_code": 2, "output_captured": True, "output_truncated": False}
    elif "--chat-snapshot" in args:
        thread = config["threadId"] or (task if "sdk" in config else config["sessionId"])
        packet = {"state": "finished", "exit_code": 0, "stream": {
            "task_id": task, "thread_id": thread, "reply": html, "state": "complete", "checks": [],
            "context_usage": {"usedTokens": 270, "contextWindow": 200000, "kind": "request_input"}
              if "sdk" in config else {"usedTokens": 312, "contextWindow": 65536}}}
    elif "--output" in args:
        thread = command[command.index("--chat-session") + 1]
        print(json.dumps({"type": "system", "subtype": "init", "session_id": thread}))
        print(json.dumps({"type": "assistant", "session_id": thread, "message": {"content": [],
            "model": "claude-fixture", "usage": {"input_tokens": 12, "cache_read_input_tokens": 30,
            "cache_creation_input_tokens": 8}}}))
        print(json.dumps({"type": "result", "subtype": "success", "result": html, "is_error": False, "session_id": thread,
            "usage": {"input_tokens": 900}, "modelUsage": {"claude-fixture": {"contextWindow": 200000}}}))
        sys.exit(0)
    else:
        packet = {"state": "finished", "exit_code": 0, "output_captured": True, "output_truncated": False}
print(json.dumps({**packet, "task_id": task}))
'''


@unittest.skipUnless(os.name == "nt" and (RUNTIME / "DshVpsChatBridge.exe").is_file(),
                     "build windows-terminal/DshChatBridge in Debug on Windows")
class DesignProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.runtime = root / "runtime"
        shutil.copytree(RUNTIME, self.runtime)
        for name in ("RemoteTaskStart.py", "RemoteTaskStatus.py"):
            (self.runtime / name).write_text(BOUNDARY, encoding="utf-8")
        (self.runtime / "fixture.html").write_text(HTML)
        self.state = root / "state"
        for name in ("identity", "pins"):
            (root / name).write_text("offline fixture")
        self.settings = dict(host="host.invalid", port=22, user="fixture", workspace="/fixture",
                             identityPath=str(root / "identity"), knownHostsPath=str(root / "pins"),
                             expectedIpv4="192.0.2.1", expectedIpv6="", hostKeyConfirmed=True)

    def rpc(self, body):
        completed = subprocess.run([self.runtime / "DshVpsChatBridge.exe", self.state],
                                   input=json.dumps(body).encode(), capture_output=True, check=True, timeout=20,
                                   env={**os.environ, "DSH_VPS_CHAT_PYTHON": sys.executable})
        return json.loads(completed.stdout)

    def test_versions_use_independent_threads_and_complete_outputs(self):
        for provider in ("claude-sdk", "claude", "antigravity"):
            with self.subTest(provider=provider):
                self.exercise(provider)

    def exercise(self, provider):
        settings = {**self.settings, "provider": provider}
        target = self.rpc(dict(op="list", settings=settings))["targetId"]
        scope = dict(settings=settings, targetId=target, sessionId=str(uuid.uuid4()))
        ids = []
        native = []
        for parent, fork in ((None, False), (0, False), (0, True), (2, False), (1, False)):
            task = str(uuid.uuid4())
            ids.append(task)
            reference = "frozen base " + (ids[parent] if parent is not None else "canvas")
            send = dict(**scope, op="send", mode="design", prompt="revise", turnId=task,
                        designContext=dict(text=reference, images=[]))
            if parent is not None:
                send["designBase"] = dict(parentTurnId=ids[parent], fork=fork)
            result = self.rpc(send)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["session"]["turns"][-1]["state"], "pending")
            payload = json.loads((self.state / target / ("task-" + task + ".payload")).read_bytes())
            config, command = payload["chatInput"], payload["command"]
            if provider == "claude":
                self.assertIn("--dsh-encrypted-credentials", command)
                self.assertIn("--dsh-api-design-stdin", command)
                self.assertEqual(command[command.index("--tools") + 1], "")
                self.assertIn(reference, config["design"])
                key = command[command.index("--chat-session") + 1]
                self.assertIn("--session-id" if fork or parent is None else "--resume", command)
                self.assertEqual(self.rpc({**scope, "turnId": task, "op": "stop"})["code"], "stop_unavailable")
            else:
                self.assertEqual(config["designContext"]["text"], reference)
                self.assertTrue(config["design"])
                self.assertEqual("sdk" in config, provider == "claude-sdk")
                self.assertEqual("support" in config, provider == "antigravity")
                self.assertEqual(config["threadId"], None if fork or parent is None else native[parent])
                key = (config["threadId"] or task) if provider == "claude-sdk" else config["sessionId"]
            if fork:
                self.assertNotIn(key, native)
            elif parent is not None:
                self.assertEqual(key, native[parent])
            native.append(key)
            session = self.rpc({**scope, "op": "refresh"})["session"]
            turn = session["turns"][-1]
            self.assertEqual((turn["state"], turn["reply"]), ("complete", HTML))
            expected_usage = {"usedTokens": 312, "contextWindow": 65536} if provider == "antigravity" else {
                "usedTokens": 50 if provider == "claude" else 270, "contextWindow": 200000, "kind": "request_input"}
            self.assertEqual(turn["contextUsage"], expected_usage)
            self.assertEqual(turn["parentTurnId"], ids[parent] if parent is not None else None)
            self.assertEqual(turn["fork"], fork)
            self.assertEqual(self.rpc(send)["session"]["turns"][-1]["id"], task)
            self.assertEqual(self.rpc({**send, "prompt": "changed"})["code"], "turn_conflict")
        self.assertEqual(self.rpc(dict(op="list", settings=settings))["sessions"][0]["mode"], "design")
        chat = {**scope, "sessionId": str(uuid.uuid4())}
        self.assertEqual(self.rpc({**chat, "op": "send", "turnId": str(uuid.uuid4()), "prompt": "ordinary"})["session"]["mode"], "chat")
        modes = {item["id"]: item["mode"] for item in self.rpc(dict(op="list", settings=settings))["sessions"]}
        self.assertEqual((modes[scope["sessionId"]], modes[chat["sessionId"]]), ("design", "chat"))
        if provider == "claude":
            failed = {**scope, "sessionId": str(uuid.uuid4())}
            self.assertTrue(self.rpc({**failed, "op": "send", "turnId": str(uuid.uuid4()), "prompt": "credential failure",
                                      "mode": "design"})["ok"])
            observed = self.rpc({**failed, "op": "refresh"})["session"]["turns"][-1]
            self.assertEqual((observed["state"], observed.get("failureCode")), ("failed", "api_credential_storage"), observed)
            self.assertIn("LUKS2", observed["activity"][-1]["text"])
            self.assertNotIn("private fixture secret", json.dumps(observed))
        history = self.rpc({**scope, "op": "design-history"})["history"]
        self.assertEqual([item["id"] for item in history], ids)
        self.assertTrue(all(item["hasBoards"] for item in history))
        self.assertEqual([item["canContinue"] for item in history], [False, False, False, True, True])
        self.assertEqual(self.rpc({**scope, "op": "design-history", "turnId": ids[0]})["turn"]["reply"], HTML)
        self.assertEqual(self.rpc({**scope, "op": "send", "turnId": str(uuid.uuid4()), "prompt": "chat"})["code"],
                         "mode_conflict")
        images = [dict(name="ref.png", dataUrl="data:image/png;base64,iVBORw0KGgo=")]
        self.assertEqual(self.rpc({**send, "turnId": str(uuid.uuid4()), "designContext": dict(text="img", images=images)})["code"],
                         "invalid_request")
        changed = self.rpc({**scope, "settings": {**settings, "provider": "codex"}, "op": "design-history"})
        self.assertEqual(changed["code"], "target_changed")


if __name__ == "__main__":
    unittest.main()
