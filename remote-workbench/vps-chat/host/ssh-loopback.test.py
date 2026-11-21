"""Check the packaged bridge over pinned local SSH with synthetic CLI events."""
import base64
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
import zlib

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "windows-terminal" / "Tests"))
import loopback
import paramiko

START = re.compile(r"""python3 -B -c 'import base64;exec\(base64.b64decode\("([A-Za-z0-9+/=]+)"\)\)' start --id ([a-f0-9-]{36}) --payload-stdin( --chat-stream)?""")
READ = re.compile(r"python3 -B - (status|output) --id ([a-f0-9-]{36})")
CONTROL = re.compile(r"python3 -I -B - (snapshot|stop) ([a-f0-9-]{36})")
EXTENSIONS = {"memory": [{"title": "回环记忆", "text": "仅复用当前项目的参考信息。"}], "mcpServers": ["fixture-status"]}


class ExecSession(loopback.Server):
    def __init__(self, fixture):
        super().__init__(fixture)
        self.ready = threading.Event()
        self.command = None

    def check_channel_exec_request(self, channel, command):
        self.command = command.decode("ascii")
        self.ready.set()
        return True


class ChatFixture(loopback.Fixture):
    def __init__(self, helper, conversation, prompts, provider, early_stop=False):
        super().__init__()
        self.helper = helper
        self.conversation = conversation
        self.prompts = prompts
        self.provider = provider
        self.native_thread = str(uuid.uuid4()) if provider == "codex" else self.conversation
        self.early_stop = early_stop
        self.observed_thread = False
        self.report_wrong_thread = False
        self.operations = []
        self.states = {}
        self.stop_requests = set()

    def start_turn(self, match, payload):
        identifier = match[2]
        assert identifier in self.prompts and identifier not in self.states
        assert base64.b64decode(match[1]) == (self.helper / "RemoteTask.py").read_bytes()
        request = json.loads(payload)
        command = request["command"]
        assert request["cwd"] == "/tmp/fixture" and request["capture"] is True
        if self.provider == "codex":
            with_extensions = not self.early_stop and identifier == next(iter(self.prompts))
            assert match[3] == " --chat-stream"
            assert command[:4] == ["python3", "-I", "-B", "-c"]
            split_launcher = "sys.argv[1]+sys.argv.pop(2)" in command[4]
            if split_launcher:
                assert len(command) == 9 and "chatInput" in request
                packed_helpers = [command[5] + command[6], command[7], command[8]]
            else:
                assert len(command) == (8 if with_extensions else 9)
                packed_helpers = command[5:8]
            for actual, name in zip(packed_helpers, ("RemoteDshCodexStream.py", "RemoteCodexPrivacy.py", "RemoteCodexIsolate.py")):
                expected = (self.helper / name).read_bytes()
                if split_launcher:
                    expected = expected.replace(b"\r\n", b"\n")
                assert zlib.decompress(base64.b64decode(actual)) == expected
            config = request["chatInput"] if "chatInput" in request else json.loads(zlib.decompress(base64.b64decode(command[8])))
            if with_extensions:
                assert config.pop("extensions") == EXTENSIONS
                helper_source = (self.helper / "RemoteDshExtensions.py").read_bytes()
                if split_launcher:
                    helper_source = helper_source.replace(b"\r\n", b"\n")
                assert zlib.decompress(base64.b64decode(config.pop("extensionsHelper"))) == helper_source
            assert config == {
                "sessionId": self.conversation, "taskId": identifier, "workspace": request["cwd"],
                "threadId": self.native_thread if self.observed_thread else None,
                "expectedIpv4": "192.0.2.18", "expectedIpv6": None, "prompt": self.prompts[identifier],
                "design": False, "designContext": None,
            }
        else:
            assert match[3] is None and command[:3] == ["python3", "-B", "-c"]
            privacy = re.fullmatch(r"import base64,zlib;exec\(zlib.decompress\(base64.b64decode\('([^']+)'\)\)\)", command[3])
            assert privacy and zlib.decompress(base64.b64decode(privacy[1])) == (self.helper / "RemoteCodexPrivacy.py").read_bytes()
            assert command[4:6] == ["--expected-ipv4", "192.0.2.18"]
            isolation = command[command.index("--isolation-code") + 1]
            assert zlib.decompress(base64.b64decode(isolation)) == (self.helper / "RemoteCodexIsolate.py").read_bytes()
            assert command[command.index("--isolation-workspace") + 1] == request["cwd"]
            cli = command[command.index("--") + 1:]
            assert "--dangerously-skip-permissions" not in cli and "--chat-auth" not in cli
            assert cli[cli.index("--chat-session") + 1] == self.conversation
            assert command[6:8] == ["--provider", "claude"]
            assert cli[:2] == ["claude", "-p"]
            assert cli[2] == "--dsh-encrypted-credentials"
            if not self.states:
                assert cli[cli.index("--model") + 1] == "sonnet"
            else:
                assert "--model" not in cli
            assert cli[cli.index("--chat-prompt") + 1] == self.prompts[identifier]
            assert cli[cli.index("--tools") + 1] == "Read,Glob,Grep"
            identity_flag = "--session-id" if not self.states else "--resume"
            assert cli[cli.index(identity_flag) + 1] == self.native_thread
        self.operations.append(("start", identifier))
        self.states[identifier] = 0
        return identifier

    def read_turn(self, match, payload):
        action, identifier = match.groups()
        assert identifier in self.states and payload == (self.helper / "RemoteTask.py").read_bytes()
        self.operations.append((action, identifier))
        if action == "status":
            self.states[identifier] += 1
            if self.states[identifier] == 1:
                return {"task_id": identifier, "state": "running"}
            return {"task_id": identifier, "state": "finished", "exit_code": 0,
                    "output_captured": True, "output_truncated": False}
        assert self.provider == "claude"
        events = [
            {"type": "system", "subtype": "init", "session_id": self.native_thread, "model": "claude-sonnet-fixture"},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "正在整理回环数据"}]}},
        ]
        if self.states[identifier] > 1:
            events.append({"type": "result", "subtype": "success", "is_error": False,
                           "session_id": self.native_thread, "result": "已完成本轮回环对话。"})
        return "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events)

    def stream_turn(self, match, payload):
        action, identifier = match.groups()
        assert self.provider == "codex" and identifier in self.states
        for name in ("RemoteTask.py", "RemoteDshCodexStream.py"):
            assert repr((self.helper / name).read_bytes()).encode("ascii") in payload
        self.operations.append((action, identifier))
        if action == "stop":
            assert identifier not in self.stop_requests
            self.stop_requests.add(identifier)
            self.states[identifier] = 0
            return None  # VPS records stop, but its SSH response never arrives.
        self.states[identifier] += 1
        finished = self.states[identifier] > 1
        stopped = identifier in self.stop_requests
        before_thread = self.early_stop and identifier == next(iter(self.prompts))
        thread = None if before_thread else self.native_thread
        if self.report_wrong_thread:
            thread = str(uuid.uuid4())
        if finished and thread == self.native_thread:
            self.observed_thread = True
        stream = {"task_id": identifier, "thread_id": thread, "checks": [],
                  "state": ("stopped" if stopped else "complete") if finished else "running",
                  "reply": "已完成本轮回环对话。" if finished and not stopped else "正在整理回环数据"}
        if before_thread:
            stream["reply"] = ""
        return {"task_id": identifier, "state": "finished" if finished else "running",
                "exit_code": 0 if finished else None, "stop_requested": stopped, "stream": stream}

    def serve(self):
        try:
            while not self.stopped.is_set():
                try:
                    connection, peer = self.listener.accept()
                except socket.timeout:
                    continue
                assert peer[0] == "127.0.0.1"
                self.transport = paramiko.Transport(connection)
                self.transport.add_server_key(self.host)
                server = ExecSession(self)
                self.transport.start_server(server=server)
                channel = self.transport.accept(12)
                assert channel is not None and server.ready.wait(8) and server.authenticated
                channel.settimeout(8)
                payload = bytearray()
                while part := channel.recv(8192):
                    payload.extend(part)
                    assert len(payload) <= 65536
                start = START.fullmatch(server.command)
                if start:
                    identifier = self.start_turn(start, payload)
                    if len(self.states) == 1:
                        # The first task exists, but its launch acknowledgment
                        # never reaches the workbench.
                        channel.close()
                        self.transport.close()
                        continue
                    response = {"task_id": identifier, "outcome": "accepted"}
                else:
                    control = CONTROL.fullmatch(server.command)
                    if control:
                        response = self.stream_turn(control, payload)
                        if response is None:
                            channel.close()
                            self.transport.close()
                            continue
                    else:
                        read = READ.fullmatch(server.command)
                        assert read is not None, "unrecognized SSH operation"
                        response = self.read_turn(read, payload)
                encoded = json.dumps(response) if isinstance(response, dict) else response
                channel.sendall(encoded.encode("utf-8"))
                channel.send_exit_status(0)
                channel.shutdown_write()
                channel.close()
                deadline = time.monotonic() + 4
                while self.transport.is_active() and not self.stopped.is_set() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.transport.close()
        except BaseException as error:
            if not self.stopped.is_set():
                self.errors.put(error)
        finally:
            if self.transport:
                self.transport.close()
            self.listener.close()


def run(executable, provider, early_stop=False):
    session, first, second, third, fourth = [str(uuid.uuid4()) for _ in range(5)]
    prompts = {first: "回环测试，保留字面内容 $() ; &", second: "接着上一轮", third: "等待停止", fourth: "续聊线程不符"}
    with ChatFixture(executable.parent, session, prompts, provider, early_stop) as fixture:
        root = fixture.work / "workbench"
        settings = {
            "host": "127.0.0.1", "port": fixture.port, "user": "loopback",
            "identityPath": fixture.profile["IdentityPath"], "knownHostsPath": fixture.profile["KnownHostsPath"],
            "workspace": "/tmp/fixture", "expectedIpv4": "192.0.2.18", "expectedIpv6": "",
            "hostKeyConfirmed": True,
        }
        if provider == "codex":
            settings["provider"] = provider

        def request(op, *, result_key="session", config=settings, code=None, **kwargs):
            env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "ProgramData", "TEMP", "TMP",
                   "USERPROFILE", "LOCALAPPDATA", "APPDATA") if key in os.environ}
            env["DSH_VPS_CHAT_PYTHON"] = sys.executable
            body = {"op": op, "settings": config, **kwargs}
            if op != "list":
                body["targetId"] = target_id
            completed = subprocess.run([str(executable), str(root)],
                input=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                env=env, capture_output=True, timeout=65, check=True)
            if not fixture.errors.empty():
                raise fixture.errors.get_nowait()
            packet = json.loads(completed.stdout.decode("utf-8"))
            if code is not None:
                assert not packet["ok"] and packet["code"] == code
                return
            assert packet["ok"], (op, packet.get("code"), packet.get("message"))
            return packet[result_key] if result_key is not None else packet

        listed = request("list", result_key=None)
        assert listed["sessions"] == []
        target_id = listed["targetId"]
        explicit_claude = dict(settings, provider="claude")
        assert (request("list", config=explicit_claude, result_key=None)["targetId"] == target_id) == (provider == "claude")
        request("list", config=dict(settings, provider="local"), code="invalid_settings")
        assert request("get", sessionId=session)["turns"] == [] and fixture.operations == []
        other = dict(settings, expectedIpv4="192.0.2.19")
        request("send", config=other, code="target_changed", sessionId=session, turnId=first, prompt=prompts[first])
        first_selection = {}
        if provider == "claude":
            models = request("models", config=explicit_claude, result_key="models")
            assert [entry["id"] for entry in models] == ["sonnet", "opus", "haiku"]
            assert all(entry["defaultEffort"] is None and entry["efforts"] == [] for entry in models)
            request("send", config=explicit_claude, code="invalid_request", sessionId=session,
                    turnId=first, prompt=prompts[first], model="fixture-unsupported")
            first_selection = {"config": explicit_claude, "model": "sonnet"}
        elif not early_stop:
            first_selection = {"extensions": EXTENSIONS}
        assert fixture.operations == []
        submitted = request("send", sessionId=session, turnId=first, prompt=prompts[first], **first_selection)
        assert submitted["turns"][-1]["state"] == "unknown" and not submitted["canSend"]
        assert request("send", sessionId=session, turnId=first, prompt=prompts[first], **first_selection) == submitted
        if provider == "claude":
            request("send", config=explicit_claude, code="turn_conflict", sessionId=session,
                    turnId=first, prompt=prompts[first], model="opus")
        elif not early_stop:
            request("send", code="turn_conflict", sessionId=session, turnId=first, prompt=prompts[first],
                    extensions={**EXTENSIONS, "mcpServers": ["different"]})
        if not fixture.errors.empty():
            raise fixture.errors.get_nowait()
        assert fixture.operations == [("start", first)]

        if early_stop:
            request("stop", code="stop_unknown", sessionId=session, turnId=first)
            assert request("refresh", sessionId=session)["turns"][-1]["state"] == "stopping"
            complete = request("refresh", sessionId=session)
            assert complete["canSend"] and complete["turns"][-1]["state"] == "stopped"
            assert complete["turns"][-1]["reply"] == ""
        else:
            running = request("refresh", sessionId=session)
            assert running["turns"][-1]["state"] == "running", (running, fixture.operations)
            assert running["turns"][-1]["reply"] == "正在整理回环数据"
            if provider == "claude":
                assert running["turns"][-1]["model"] == "claude-sonnet-fixture"
            complete = request("refresh", sessionId=session)
            assert complete["canSend"] and complete["turns"][-1]["reply"] == "已完成本轮回环对话。"
        assert request("get", sessionId=session) == complete
        assert request("list", result_key="sessions")[0]["id"] == session
        assert request("list", config=other, result_key="sessions") == []
        assert request("send", sessionId=session, turnId=second, prompt=prompts[second])["turns"][-1]["id"] == second
        starts = [operation for operation in fixture.operations if operation[0] == "start"]
        assert starts == [("start", first), ("start", second)]
        assert request("refresh", sessionId=session)["turns"][-1]["state"] == "running"
        continued = request("refresh", sessionId=session)
        assert continued["canSend"] and [turn["state"] for turn in continued["turns"]] == [
            "stopped" if early_stop else "complete", "complete",
        ]
        stored = json.loads((root / target_id / f"conversation-{session}.json").read_text(encoding="utf-8"))
        assert stored["Provider"] == provider and [turn["ThreadId"] for turn in stored["Turns"]] == [
            None if early_stop else fixture.native_thread, fixture.native_thread,
        ]
        if provider == "codex" and not early_stop:
            assert fixture.native_thread != session
            request("send", sessionId=session, turnId=third, prompt=prompts[third])
            running = request("refresh", sessionId=session)["turns"][-1]
            assert running["streaming"] and running["canStop"] and running["reply"] == "正在整理回环数据"
            request("stop", code="stop_unavailable", sessionId=session, turnId=second)
            request("stop", code="stop_unknown", sessionId=session, turnId=third)
            stopping = request("refresh", sessionId=session)["turns"][-1]
            assert stopping["state"] == "stopping" and not stopping["canStop"]
            stopped = request("refresh", sessionId=session)
            assert stopped["canSend"] and stopped["turns"][-1]["state"] == "stopped"
            assert stopped["turns"][-1]["reply"] == running["reply"]
            assert request("stop", result_key="outcome", sessionId=session, turnId=third) == "settled"
            assert fixture.stop_requests == {third}
            fixture.report_wrong_thread = True
            request("send", sessionId=session, turnId=fourth, prompt=prompts[fourth])
            assert request("refresh", sessionId=session)["turns"][-1]["reply"] == ""
            mismatched = request("refresh", sessionId=session)
            assert mismatched["turns"][-1]["state"] == "unknown" and not mismatched["canSend"]
            request("send", code="session_blocked", sessionId=session, turnId=str(uuid.uuid4()), prompt="block replay")
            assert [operation for operation in fixture.operations if operation[0] == "start"] == starts + [("start", third), ("start", fourth)]
    assert fixture.cleanup_verified
    print(f"PASS: pinned SSH, guarded {provider} payload, lost acknowledgment recovery, cached replies and native-thread continuation")


if __name__ == "__main__":
    executable = Path(sys.argv[1]).resolve(strict=True)
    for provider in ("claude", "codex"):
        run(executable, provider)
    run(executable, "codex", early_stop=True)
