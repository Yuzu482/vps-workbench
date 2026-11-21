"""Disposable 127.0.0.1 SSH fixture. No external host or model invocation.

Both ends use real Windows ConPTY. The SSH server is Paramiko, not Windows sshd.
Generated keys are restricted to a temporary directory and removed on exit.
"""
import base64
import contextlib
import csv
import ctypes
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import tempfile
import threading
import time

import paramiko
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "TestHarness/bin/Release/net10.0-windows/BridgeHarness.exe"
SSH = Path(os.environ["SystemRoot"]) / "System32/OpenSSH"
TEST_PASSWORD = "loopback-test-only"


def token(profile):
    return base64.urlsafe_b64encode(json.dumps(profile, ensure_ascii=False).encode()).decode().rstrip("=")


def write_frame(process, frame, lock):
    with lock:
        process.stdin.write((json.dumps(frame) + "\n").encode())
        process.stdin.flush()


def process_alive(pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        code = ctypes.c_uint32()
        if not kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return code.value == 259
    finally:
        kernel.CloseHandle(ctypes.c_void_p(handle))


class Server(paramiko.ServerInterface):
    def __init__(self, fixture):
        self.fixture = fixture
        self.shell = threading.Event()
        self.attempted = False
        self.authenticated = False
        self.pty = False
        self.width, self.height = 100, 30

    def get_allowed_auths(self, username):
        return "password" if self.fixture.password else "publickey"

    def check_auth_publickey(self, username, key):
        self.attempted = True
        self.authenticated = not self.fixture.deny and username == "loopback" and key == self.fixture.public
        return paramiko.AUTH_SUCCESSFUL if self.authenticated else paramiko.AUTH_FAILED

    def check_auth_password(self, username, password):
        self.attempted = True
        self.authenticated = not self.fixture.deny and username == "loopback" and password == TEST_PASSWORD
        return paramiko.AUTH_SUCCESSFUL if self.authenticated else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        self.pty = True
        self.width, self.height = width, height
        return True

    def check_channel_shell_request(self, channel):
        self.shell.set()
        return True

    def check_channel_window_change_request(self, channel, width, height, pixelwidth, pixelheight):
        self.width, self.height = width, height
        if self.fixture.remote:
            try:
                write_frame(self.fixture.remote, {"type": "resize", "columns": width, "rows": height}, self.fixture.lock)
            except (OSError, ValueError):
                return False
        return True


class Fixture:
    def __init__(self, password=False, passphrase=False, wrong_host=False, deny=False, observe_output=None):
        self.password, self.passphrase, self.wrong_host, self.deny = password, passphrase, wrong_host, deny
        self.lock = threading.Lock()
        self.remote = None
        self.transport = None
        self.errors = queue.Queue()
        self.remote_pids = []
        self.stopped = threading.Event()
        self.observe_output = observe_output
        self.remote_exit_code = None
        self.cleanup_verified = False

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote ssh 中文-")
        self.work = Path(self.temp.name)
        try:
            key = self.work / "identity"
            generated = Ed25519PrivateKey.generate()
            encryption = serialization.BestAvailableEncryption(TEST_PASSWORD.encode()) if self.passphrase else serialization.NoEncryption()
            key.write_bytes(generated.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, encryption))
            # Restrict only this newly generated test private key, never the
            # user's existing keys or system SSH configuration.
            system = Path(os.environ["SystemRoot"]) / "System32"
            identity = subprocess.run([str(system / "whoami.exe"), "/user", "/fo", "csv", "/nh"], capture_output=True, check=True)
            sid = next(csv.reader(identity.stdout.decode().splitlines()))[1]
            secured = subprocess.run([str(system / "icacls.exe"), str(key), "/inheritance:r", "/grant:r", "*" + sid + ":F"], capture_output=True)
            if secured.returncode: raise RuntimeError("Could not restrict temporary key permissions")
            public = generated.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
            self.public = paramiko.Ed25519Key(data=base64.b64decode(public.split()[1]))
            self.host = paramiko.RSAKey.generate(2048)
            self.listener = socket.socket()
            self.listener.bind(("127.0.0.1", 0)); self.listener.listen(1); self.listener.settimeout(0.2)
            self.port = self.listener.getsockname()[1]
            known = self.work / "known_hosts"
            pinned = paramiko.RSAKey.generate(2048) if self.wrong_host else self.host
            known.write_text(f"[127.0.0.1]:{self.port} {pinned.get_name()} {pinned.get_base64()}\n", encoding="ascii")
            self.profile = dict(Host="127.0.0.1", Port=self.port, User="loopback",
                                Authentication="Password" if self.password else "Key",
                                IdentityPath="" if self.password else str(key), KnownHostsPath=str(known))
            self.before_known = known.read_bytes()
            self.server = Server(self)
            self.thread = threading.Thread(target=self.serve, daemon=True); self.thread.start()
            return self
        except BaseException:
            self.temp.cleanup()
            raise

    def serve(self):
        try:
            while not self.stopped.is_set():
                try:
                    conn, peer = self.listener.accept(); break
                except socket.timeout:
                    continue
            else:
                return
            if peer[0] != "127.0.0.1":
                raise RuntimeError("Unexpected peer")
            self.transport = paramiko.Transport(conn)
            self.transport.add_server_key(self.host)
            try:
                self.transport.start_server(server=self.server)
                channel = self.transport.accept(15)
            except (EOFError, paramiko.SSHException, OSError):
                if self.wrong_host or self.deny or self.stopped.is_set():
                    return
                raise
            if channel is None:
                if self.wrong_host or self.deny or self.stopped.is_set(): return
                raise RuntimeError("No authenticated session")
            if not self.server.shell.wait(10) or not self.server.pty or not self.server.authenticated:
                raise RuntimeError("Missing authentication, PTY or shell request")
            self.remote = subprocess.Popen([str(HARNESS), "fixture"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            def read_pids():
                for line in self.remote.stderr:
                    if line.startswith(b"TEST_CHILD_PID="):
                        self.remote_pids.append(int(line.split(b"=")[1]))
            threading.Thread(target=read_pids, daemon=True).start()
            write_frame(self.remote, {"type": "resize", "columns": self.server.width, "rows": self.server.height}, self.lock)

            def input_pump():
                try:
                    while data := channel.recv(4096):
                        write_frame(self.remote, {"type": "input", "data": base64.b64encode(data).decode()}, self.lock)
                except (OSError, EOFError, ValueError):
                    pass
                finally:
                    try: write_frame(self.remote, {"type": "close"}, self.lock)
                    except (OSError, ValueError): pass

            pump = threading.Thread(target=input_pump, daemon=True); pump.start()
            for line in self.remote.stdout:
                event = json.loads(line)
                if event["type"] == "output":
                    data = base64.b64decode(event["data"])
                    if self.observe_output: self.observe_output(data)
                    try: channel.sendall(data)
                    except (OSError, EOFError): break
                elif event["type"] == "exit":
                    self.remote_exit_code = event["code"]
                    if channel.active:
                        channel.send_exit_status(event["code"])
                        channel.shutdown_write()
                        channel.close()
                        # Let OpenSSH consume exit-status/channel-close and send
                        # its SSH disconnect before closing the TCP transport.
                        # An immediate transport.close() can produce a reset and
                        # turn a successful exit into 255 on the client.
                        end = time.monotonic() + 5
                        while self.transport.is_active() and not self.stopped.is_set() and time.monotonic() < end:
                            time.sleep(0.02)
                    break
        except BaseException as exc:
            if not self.stopped.is_set(): self.errors.put(exc)
        finally:
            if self.transport: self.transport.close()
            if self.remote:
                try:
                    if self.remote.poll() is None:
                        try: write_frame(self.remote, {"type": "close"}, self.lock)
                        except (OSError, ValueError): pass
                        self.remote.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.errors.put(RuntimeError("Remote fixture did not stop"))
                    self.remote.kill(); self.remote.wait(timeout=5)
            self.listener.close()

    def __exit__(self, exc_type, exc, tb):
        self.stopped.set()
        if self.transport: self.transport.close()
        self.listener.close()
        self.thread.join(timeout=20)
        try:
            if self.thread.is_alive(): raise RuntimeError("SSH server thread still alive")
            for pid in self.remote_pids:
                if process_alive(pid): raise RuntimeError(f"Remote fixture child leaked: {pid}")
            if Path(self.profile["KnownHostsPath"]).read_bytes() != self.before_known:
                raise RuntimeError("Trust file was modified")
            with socket.socket() as probe:
                probe.settimeout(0.2)
                if probe.connect_ex(("127.0.0.1", self.port)) == 0: raise RuntimeError("SSH listener still open")
            if exc is None and not self.errors.empty(): raise self.errors.get()
        finally:
            self.temp.cleanup()
            if self.work.exists(): raise RuntimeError("Temporary keys were not removed")
        self.cleanup_verified = True


class Client:
    def __init__(self, profile):
        self.process = subprocess.Popen([str(HARNESS), "console", token(profile)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.events = queue.Queue(); self.output = bytearray(); self.exit = None; self.lock = threading.Lock()
        self.pid = None
        def read():
            try:
                for line in self.process.stdout: self.events.put(json.loads(line))
            except BaseException as exc: self.events.put(exc)
        def read_pid():
            for line in self.process.stderr:
                if line.startswith(b"TEST_CHILD_PID="): self.pid = int(line.split(b"=")[1])
        self.reader = threading.Thread(target=read, daemon=True); self.reader.start()
        self.pid_reader = threading.Thread(target=read_pid, daemon=True); self.pid_reader.start()

    def send(self, data):
        if isinstance(data, str): data = data.encode("utf-8")
        write_frame(self.process, {"type": "input", "data": base64.b64encode(data).decode()}, self.lock)

    def key(self, virtual, scan, char=0, modifiers=0):
        # The local Windows ConPTY explicitly requests Win32 input mode (9001).
        # Emit key down/up records just as a mode-aware terminal does. An ANSI
        # arrow alone can arrive as literal ESC/[ /C rather than a RightArrow.
        self.send("".join(f"\x1b[{virtual};{scan};{char};{down};{modifiers};1_" for down in (1, 0)))

    def wait(self, text=None, seconds=20):
        marker = text.encode() if isinstance(text, str) else text
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if (marker is None and self.exit is not None) or (marker is not None and marker in self.output): return
            if self.exit is not None: raise RuntimeError(f"Early terminal exit {self.exit}; tail={self.output[-2500:].decode('utf-8', 'replace')}")
            try: event = self.events.get(timeout=0.1)
            except queue.Empty: continue
            if isinstance(event, BaseException): raise event
            if event["type"] == "output": self.output.extend(base64.b64decode(event["data"]))
            elif event["type"] == "exit": self.exit = event
        raise TimeoutError(f"Waiting for {text!r}; tail={self.output[-2500:].decode('utf-8', 'replace')}")

    def finish(self, code):
        self.wait()
        self.process.wait(timeout=10)
        if self.exit["code"] != code or self.exit["error"] is not None:
            raise RuntimeError(f"Bad exit: {self.exit}")

    def close(self):
        if self.process.poll() is None:
            try: write_frame(self.process, {"type": "close"}, self.lock)
            except (OSError, ValueError): pass
            try: self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=5)
                raise RuntimeError("Client harness cleanup timeout")
        self.reader.join(timeout=2); self.pid_reader.join(timeout=2)
        if self.pid and process_alive(self.pid): raise RuntimeError("Console helper leaked")


@contextlib.contextmanager
def client(profile):
    value = Client(profile)
    try: yield value
    finally: value.close()


def run_tests():
    with Fixture() as server, client(server.profile) as app:
        app.wait("LOCAL-SSH-READY")
        app.send("中文回环验证\r")
        app.wait("MOCK-ECHO:中文回环验证")
        app.send("keys\r"); app.wait("MOCK-PERMISSION")
        assert b"MOCK-DECISION" not in app.output
        app.key(39, 77, modifiers=256); app.wait("MOCK-SELECTION:DENY")
        assert b"MOCK-DECISION" not in app.output
        app.key(9, 15, 9); app.wait("MOCK-TAB")
        app.key(13, 28, 13); app.wait("MOCK-DECISION:DENY")
        write_frame(app.process, {"type": "resize", "columns": 91, "rows": 27}, app.lock)
        end = time.monotonic() + 5
        while (server.server.width, server.server.height) != (91, 27) and time.monotonic() < end: time.sleep(0.05)
        app.send("size\r"); app.wait("MOCK-SIZE:91x27")
        app.key(67, 46, 3, 8); app.wait("MOCK-CTRL-C")
        app.send("quit\r"); app.finish(0)
    print("PASS key SSH: Chinese, VT, arrow/Tab/Enter, Ctrl+C, real remote resize, exit and cleanup", flush=True)

    for mode in ("password", "passphrase"):
        with Fixture(**{mode: True}) as server, client(server.profile) as app:
            app.wait("password:" if mode == "password" else "Enter passphrase for key")
            app.send(TEST_PASSWORD + "\r"); app.wait("LOCAL-SSH-READY")
            assert TEST_PASSWORD.encode() not in app.output, "Authentication secret echoed"
            app.send("quit\r"); app.finish(0)
        print(f"PASS interactive {mode}, no secret echo, cleanup", flush=True)

    for failure, expected in (("wrong_host", "REMOTE HOST IDENTIFICATION HAS CHANGED"), ("deny", "Permission denied")):
        with Fixture(**{failure: True}) as server, client(server.profile) as app:
            app.wait(expected); app.wait("按任意键关闭")
            assert app.process.poll() is None, "Failure window would close immediately"
            if failure == "wrong_host": assert not server.server.attempted, "Authenticated before host-key validation"
            app.send("x"); app.finish(255)
        print(f"PASS {failure}: fail closed, visible error, unchanged trust, cleanup", flush=True)

    with Fixture() as server, client(server.profile) as app:
        app.wait("LOCAL-SSH-READY")
        app.send("fail\r"); app.wait("SSH 已退出，退出码 23"); app.wait("按任意键关闭")
        app.send("x"); app.finish(23)
    print("PASS remote nonzero status survives helper and remains visible", flush=True)

    with Fixture() as server, client(server.profile) as app:
        app.wait("LOCAL-SSH-READY")
        # Drop the SSH transport while the remote shell is open. The client
        # must report uncertainty and remain stopped until an explicit close.
        server.transport.close()
        app.wait("断线时最后的输入和远端任务状态可能未知")
        app.wait("按任意键关闭")
        assert app.process.poll() is None, "Disconnect message was not retained"
        app.send("x"); app.wait(); app.process.wait(timeout=10)
        # Windows OpenSSH can report -1 for a dropped transport rather than
        # the 255 commonly seen for an ordinary connection failure.
        assert app.exit["code"] != 0 and app.exit["error"] is None, f"Unexpected disconnect exit: {app.exit}"
    print("PASS dropped SSH transport: unknown remote state, no automatic reconnect, cleanup", flush=True)

    with Fixture() as server, client(server.profile) as app:
        app.wait("LOCAL-SSH-READY")
        # Abrupt helper termination exercises JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        assert app.pid
        os.kill(app.pid, 15)
        app.wait()
        end = time.monotonic() + 5
        while server.transport.is_active() and time.monotonic() < end: time.sleep(0.05)
        assert not server.transport.is_active(), "SSH child outlived helper job"
    print("PASS abrupt helper termination closes SSH transport and remote fixture", flush=True)


if __name__ == "__main__":
    run_tests()
