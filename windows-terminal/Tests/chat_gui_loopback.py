"""End-to-end chat UI against a disposable local SSH/WSL fake Codex worker.

The fixture deliberately substitutes a harmless JSONL producer after checking
the request. No external host, actual Codex model, or existing credentials are used.
"""
import base64
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import uuid
import zlib

import paramiko
import loopback
import managed_loopback_wsl as managed

UUID = managed.UUID
START = re.compile(r"^python3 -B -c 'import base64;exec\(base64.b64decode\(\"([A-Za-z0-9+/=]+)\"\)\)' start --id (" + UUID + r") --payload-stdin$")
READ = re.compile(r"^python3 -B - (status|output) --id (" + UUID + r")(?: --stream stderr)?$")
UPLOAD = re.compile(r"^python3 -B -c 'import base64,zlib;exec\(zlib.decompress\(base64.b64decode\(\"([A-Za-z0-9+/=]+)\"\)\)\)' --session (" + UUID + r") --turn (" + UUID + r")$")
AUTH = re.compile(r"^python3 -B -c 'import base64,zlib;exec\(zlib.decompress\(base64.b64decode\(\"([A-Za-z0-9+/=]+)\"\)\)\)' --session (" + UUID + r")(?: --source (" + UUID + r"))?( --native)?$")


class ChatFixture(loopback.Fixture):
    def __init__(self, remote_root):
        super().__init__()
        self.remote_root = remote_root
        self.actions = []
        self.dropped = 0
        self.identifiers = []
        self.conversation = None
        self.native = str(uuid.uuid4())
        self.auth_sessions = set()
        self.shared_auth = False
        self.auth_root = "/tmp/remote-chat-auth-" + uuid.uuid4().hex

    def serve(self):
        helper = (managed.APP / "RemoteTask.py").read_bytes()
        token = base64.urlsafe_b64encode((self.remote_root + "/tasks").encode()).decode().rstrip("=")
        try:
            while not self.stopped.is_set():
                try:
                    conn, peer = self.listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    if self.stopped.is_set(): break
                    raise
                if peer[0] != "127.0.0.1": raise RuntimeError("Unexpected peer")
                self.transport = paramiko.Transport(conn); self.transport.add_server_key(self.host)
                server = managed.ExecServer(self); self.transport.start_server(server=server)
                channel = self.transport.accept(15)
                if channel is None or not server.ready.wait(10) or not server.authenticated:
                    raise RuntimeError("Missing authenticated exec request")
                match, reading, upload, auth = START.fullmatch(server.command), READ.fullmatch(server.command), UPLOAD.fullmatch(server.command), AUTH.fullmatch(server.command)
                if match:
                    if base64.b64decode(match.group(1)) != helper: raise RuntimeError("Unexpected helper")
                    action, identifier = "start", match.group(2)
                elif reading:
                    action, identifier = reading.group(1), reading.group(2)
                elif upload:
                    if zlib.decompress(base64.b64decode(upload.group(1))) != (managed.APP / "RemoteChatFiles.py").read_bytes():
                        raise RuntimeError("Unexpected attachment helper")
                    action, identifier = "upload", upload.group(3)
                    if upload.group(2) != self.conversation: raise RuntimeError("Attachment conversation mismatch")
                elif auth:
                    expected = (managed.APP / "RemoteClaudeShared.py").read_bytes() + b"\n"
                    if auth.group(4): expected += (managed.APP / "RemoteNativeSafety.py").read_bytes() + b"\n"
                    expected += (managed.APP / "RemoteClaudeAuth.py").read_bytes()
                    if zlib.decompress(base64.b64decode(auth.group(1))) != expected or auth.group(2) in self.auth_sessions or len(self.auth_sessions) >= 3:
                        raise RuntimeError("Unexpected subscription status helper")
                    action, identifier = "auth", auth.group(2)
                    self.auth_sessions.add(identifier)
                else:
                    raise RuntimeError("Unexpected remote command")
                data = bytearray()
                while part := channel.recv(65536):
                    data.extend(part)
                    if len(data) > 65536: raise RuntimeError("Oversized fixture payload")
                if action == "start":
                    if identifier in self.identifiers or len(self.identifiers) >= 2: raise RuntimeError("Duplicate start request")
                    self.identifiers.append(identifier)
                    request = json.loads(data)
                    command = request.get("command", [])
                    isolated = zlib.decompress(base64.b64decode(command[command.index("--isolation-code") + 1]))
                    expected = (managed.APP / "RemoteCodexIsolate.py").read_bytes() + b"\n" + (managed.APP / "RemoteNativeSafety.py").read_bytes() + b"\n" + (managed.APP / "RemoteNativeSession.py").read_bytes()
                    if isolated != expected: raise RuntimeError("New conversation did not carry the native isolation helper")
                    session_index = command.index("--chat-session")
                    if self.conversation is None: self.conversation = command[session_index + 1]
                    if command[session_index + 1] != self.conversation: raise RuntimeError("Conversation identity changed")
                    first = len(self.identifiers) == 1
                    if (not request.get("capture") or request.get("cwd") != "/tmp/fake-project" or
                        "--isolation-code" not in command or "danger-full-access" not in command or
                        (first and command[-1] != "本地回环任务") or
                        (not first and ("resume" not in command or self.native not in command or "本地回环第二轮" not in command[-1] or
                                        "--chat-turn" not in command or command[command.index("--chat-turn") + 1] != identifier))):
                        raise RuntimeError("Chat request did not preserve isolation and capture choices")
                    if not first:
                        root = self.remote_root + "/home/.remote-ssh-chat/" + self.conversation + "/uploads/" + identifier
                        verify = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "--exec", "python3", "-c",
                                                 "import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert (p/'f1.txt').read_bytes()==b'attachment over ssh'; assert (p/'ready.json').is_file()", root], capture_output=True, timeout=10)
                        if verify.returncode: raise RuntimeError("Uploaded attachment was not staged")
                    fake = ("import json,pathlib,time; "
                            "pathlib.Path(" + repr(self.remote_root + "/once.txt") + ").open('a').write('once\\n'); "
                            "print(json.dumps({'type':'thread.started','thread_id':" + repr(self.native) + "}),flush=True); "
                            "print(json.dumps({'type':'item.started','item':{'id':'1','type':'command_execution','command':'echo fixture'}}),flush=True); "
                            "time.sleep(" + ("7" if first else "1") + "); "
                            "print(json.dumps({'type':'item.completed','item':{'id':'1','type':'command_execution','command':'echo fixture','status':'completed','exit_code':0,'aggregated_output':'fixture'}}),flush=True); "
                            "print(json.dumps({'type':'item.completed','item':{'id':'2','type':'agent_message','text':" + repr("回环回复" if first else "第二轮回复") + "}},ensure_ascii=False),flush=True); "
                            "print(json.dumps({'type':'turn.completed'}),flush=True)")
                    data = bytearray(json.dumps({"command": ["python3", "-u", "-c", fake], "cwd": "/tmp", "capture": True}).encode())
                elif action not in ("upload", "auth") and (bytes(data) != helper or identifier not in self.identifiers):
                    raise RuntimeError("Unexpected read helper or task ID")
                elif action == "auth" and data:
                    raise RuntimeError("Subscription status received unexpected input")
                self.actions.append(action)
                command = server.command if action in ("upload", "auth") else server.command + " --state-dir-b64 " + token
                wsl_user = ["-u", "nobody", "--cd", "/tmp"] if action == "auth" else []
                remote_home = self.auth_root + "/home" if action == "auth" else self.remote_root + "/home"
                if action == "auth" and auth.group(3):
                    source = auth.group(3)
                    setup = r'''import os,pathlib,shutil,sys
h=pathlib.Path(sys.argv[1]); source=sys.argv[2]; root=h/'.remote-ssh-chat'/source
root.mkdir(mode=0o700,parents=True); native=root/'native-home'; native.mkdir(mode=0o700); (native/'.claude').mkdir(mode=0o700)
config=root/'claude-home'; config.mkdir(mode=0o700); (config/'projects').mkdir(mode=0o700)
(config/'projects'/'source-private').write_text('fixture-private')
cred=config/'.credentials.json'; cred.write_text('fixture-only'); cred.chmod(0o600)
binary=h/'.local'/'bin'/'claude'; binary.parent.mkdir(parents=True); shutil.copy2('/usr/bin/true',binary); binary.chmod(0o700)
'''
                    made = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-c", setup, remote_home, source], capture_output=True, timeout=10)
                    if made.returncode: raise RuntimeError("Could not prepare synthetic shared profile")
                    self.shared_auth = True
                process = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, *wsl_user, "--exec", "env", "HOME=" + remote_home, "sh", "-c", command],
                                         input=bytes(data), capture_output=True, timeout=25, check=False)
                if action == "start":
                    reply = json.loads(process.stdout.decode("utf-8"))
                    if process.returncode or reply.get("outcome") != "accepted": raise RuntimeError("Fixture start failed")
                    self.dropped += 1; channel.close(); self.transport.close(); continue
                if action == "auth":
                    value = json.loads(process.stdout.decode("utf-8"))
                    if process.returncode or value != {"session": identifier, "status": value.get("status")} or value["status"] not in ("unavailable", "not_logged_in", "cli_missing"):
                        raise RuntimeError("Unexpected subscription status response")
                    profile = self.auth_root + "/home/.remote-ssh-chat/" + identifier
                    check_profile = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert p.is_dir() and p.stat().st_mode & 0o077 == 0"
                    if not auth.group(4): check_profile += "; assert (p/'native-home'/'.claude').is_dir(); assert (p/'claude-home').is_dir()"
                    verify = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-c",
                        check_profile, profile], capture_output=True, timeout=10)
                    if verify.returncode: raise RuntimeError("Subscription profile was not privately prepared")
                    if auth.group(4):
                        native_root = self.auth_root + "/home/.remote-ssh-chat/native-claude"
                        verify_native = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-c",
                            "import pathlib,sys; a=pathlib.Path(sys.argv[1]); assert (a/'home'/'.claude').is_dir(); assert (a.parent.parent/'.claude').is_dir()", native_root], capture_output=True, timeout=10)
                        if verify_native.returncode: raise RuntimeError("Common native profile was not prepared")
                    if auth.group(3):
                        source_profile = self.auth_root + "/home/.remote-ssh-chat/" + auth.group(3)
                        verify_shared = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-c",
                            "import pathlib,sys; a=pathlib.Path(sys.argv[1]); b=pathlib.Path(sys.argv[2]); assert (a/'.shared-account-v1.json').is_file(); assert (a/'claude-home'/'projects'/'source-private').is_file(); assert (b/'claude-home'/'projects').is_dir(); assert not (b/'claude-home'/'projects'/'source-private').exists()", source_profile, profile], capture_output=True, timeout=10)
                        if verify_shared.returncode: raise RuntimeError("Shared profile guard or history isolation was not prepared")
                if process.stdout: channel.sendall(process.stdout)
                if process.stderr: channel.sendall_stderr(process.stderr)
                channel.send_exit_status(process.returncode); channel.shutdown_write(); channel.close()
                deadline = time.monotonic() + 2
                while self.transport.is_active() and not self.stopped.is_set() and time.monotonic() < deadline: time.sleep(.02)
                self.transport.close()
        except BaseException as error:
            if not self.stopped.is_set(): self.errors.put(error)
        finally:
            if self.transport: self.transport.close()
            self.listener.close()


def cleanup(root, identifiers):
    script = r'''import json,os,pathlib,re,shutil,sys
p=pathlib.Path(sys.argv[1]); identifiers=sys.argv[2:]
assert p.parent==pathlib.Path('/tmp') and re.fullmatch(r'remote-chat-ui-[0-9a-f]{32}',p.name)
assert not p.is_symlink() and p.is_dir() and p.stat().st_uid==os.getuid()
assert len(identifiers)==2 and identifiers[0]!=identifiers[1]
for ident in identifiers:
 record=json.loads((p/'tasks'/ident/'state.json').read_text())
 assert record['task_id']==ident and record['phase']=='finished' and record['exit_code']==0
assert (p/'once.txt').read_text()=='once\nonce\n'
shutil.rmtree(p); assert not p.exists()
'''
    return subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "--exec", "python3", "-c", script, root, *identifiers],
                          capture_output=True, timeout=15, check=False)


def main():
    if len(sys.argv) != 2: raise ValueError("Expected a new evidence directory")
    directory = Path(sys.argv[1]).resolve(strict=False)
    if directory.exists(): raise ValueError("Evidence directory already exists")
    directory.mkdir()
    root = "/tmp/remote-chat-ui-" + uuid.uuid4().hex
    create = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "--exec", "python3", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).mkdir(mode=0o700,parents=True)", root + "/home"], capture_output=True, timeout=10)
    if create.returncode: raise RuntimeError("Could not create disposable remote home")
    test = managed.ROOT / "ChatGuiTests" / "bin" / "Release" / "net10.0-windows" / "ChatGuiTests.exe"
    if not test.is_file(): raise RuntimeError("Build ChatGuiTests first")
    with ChatFixture(root) as fixture:
        prepare_auth = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-c",
            "import pathlib,sys; pathlib.Path(sys.argv[1]).mkdir(mode=0o700,parents=True)", fixture.auth_root + "/home"], capture_output=True, timeout=10)
        if prepare_auth.returncode: raise RuntimeError("Could not create disposable unprivileged auth home")
        config = {"host": "127.0.0.1", "port": fixture.port, "user": "loopback",
                  "identity": fixture.profile["IdentityPath"], "known": fixture.profile["KnownHostsPath"],
                  "receipts": str(directory / "receipts"), "app": str(managed.APP)}
        path = directory / "ready.json"; path.write_text(json.dumps(config), encoding="utf-8")
        result = subprocess.run([str(test), str(path)], capture_output=True, timeout=120, check=False)
        print(result.stdout.decode("utf-8", "replace"), end="", flush=True)
        if result.returncode:
            raise RuntimeError("Chat GUI failed: " + result.stderr.decode("utf-8", "replace")[-3000:])
        if fixture.dropped != 2 or fixture.actions.count("start") != 2 or fixture.actions.count("upload") != 1 or fixture.actions.count("auth") != 3 or not fixture.shared_auth or "status" not in fixture.actions or "output" not in fixture.actions:
            raise RuntimeError("Expected two unique starts, one upload, dropped acknowledgements, and read-only recovery")
        cleared = cleanup(root, fixture.identifiers)
        if cleared.returncode: raise RuntimeError("Disposable remote state could not be verified: " + cleared.stderr.decode("utf-8", "replace"))
        clean_auth = r'''import os,pathlib,re,shutil,sys
p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path('/tmp') and re.fullmatch(r'remote-chat-auth-[0-9a-f]{32}',p.name)
assert not p.is_symlink() and p.is_dir() and p.stat().st_uid==os.getuid()
shutil.rmtree(p); assert not p.exists()
'''
        cleared_auth = subprocess.run([str(managed.WSL), "-d", managed.DISTRO, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-c", clean_auth, fixture.auth_root], capture_output=True, timeout=10)
        if cleared_auth.returncode: raise RuntimeError("Disposable auth profile could not be cleaned")
        print("PASS: two unique starts, one attachment, original receipt recovery and disposable remote cleanup", flush=True)
    path.unlink()


if __name__ == "__main__": main()
