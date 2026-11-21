"""SOCKS bridge and OpenSSH use only disposable loopback servers."""
import base64
import contextlib
import os
from pathlib import Path
import json
import re
import select
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import paramiko

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "artifacts" / "app"
BRIDGE = APP / "RemoteSsh.Proxy.exe"
SSH = Path(os.environ["SystemRoot"]) / "System32" / "OpenSSH" / "ssh.exe"


@contextlib.contextmanager
def wait_for_copied_bridge(directory):
    # OpenSSH can exit just before its ProxyCommand process releases the
    # copied executable. Wait only for this test's disposable file.
    try:
        yield
    finally:
        path = Path(directory) / "RemoteSsh.Proxy.exe"
        deadline = time.monotonic() + 5
        while path.exists():
            try:
                with path.open("r+b"):
                    break
            except PermissionError:
                if time.monotonic() >= deadline: raise
                time.sleep(.05)


def receive(stream, length):
    data = b""
    while len(data) < length:
        part = stream.recv(length - len(data))
        if not part:
            raise EOFError("short SOCKS request")
        data += part
    return data


class Forwarder:
    def __init__(self, expected_port, reject=False):
        self.expected_port = expected_port
        self.reject = reject
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(12)
        self.port = self.listener.getsockname()[1]
        self.error = None
        self.connected = False
        self.thread = threading.Thread(target=self.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def run(self):
        try:
            with self.listener.accept()[0] as client:
                client.settimeout(12)
                if receive(client, 3) != b"\x05\x01\x00":
                    raise AssertionError("incorrect SOCKS greeting")
                client.sendall(b"\x05\xff" if self.reject else b"\x05\x00")
                if self.reject:
                    return
                if receive(client, 4) != b"\x05\x01\x00\x01":
                    raise AssertionError("incorrect SOCKS connect header")
                target = socket.inet_ntoa(receive(client, 4))
                port = int.from_bytes(receive(client, 2), "big")
                if target != "127.0.0.1" or port != self.expected_port:
                    raise AssertionError("unexpected SOCKS destination")
                with socket.create_connection((target, port), timeout=5) as remote:
                    self.connected = True
                    # Deliberately fragment the reply to exercise exact reads.
                    client.sendall(b"\x05\x00"); client.sendall(b"\x00\x01\x7f\x00\x00\x01\x00\x00")
                    client.settimeout(None); remote.settimeout(None)
                    peers = {client: remote, remote: client}
                    active = set(peers)
                    while active:
                        readable, _, _ = select.select(list(active), [], [], 12)
                        if not readable:
                            raise TimeoutError("SOCKS forwarding stalled")
                        for source in readable:
                            try: data = source.recv(65536)
                            except (ConnectionResetError, ConnectionAbortedError): data = b""
                            if data:
                                try: peers[source].sendall(data)
                                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                                    active.clear()
                                    break
                            else:
                                active.remove(source)
                                try: peers[source].shutdown(socket.SHUT_WR)
                                except OSError: pass
        except BaseException as exc:
            self.error = exc
        finally:
            self.listener.close()

    def __exit__(self, exc_type, exc, tb):
        self.thread.join(15)
        if self.thread.is_alive():
            self.listener.close()
            raise AssertionError("SOCKS fixture did not finish")
        if self.error and not exc_type:
            raise self.error


class TestSshServer(paramiko.ServerInterface):
    def __init__(self):
        self.executed = threading.Event()

    def get_allowed_auths(self, username): return "none"
    def check_auth_none(self, username):
        return paramiko.AUTH_SUCCESSFUL if username == "loopback" else paramiko.AUTH_FAILED
    def check_channel_request(self, kind, channel):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
    def check_channel_exec_request(self, channel, command):
        if command != b"fixture": return False
        self.executed.set()
        return True


class PrivacySshServer(TestSshServer):
    def __init__(self, actual_source):
        super().__init__()
        self.actual_source = actual_source
        self.command = None

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes): return True
    def check_channel_exec_request(self, channel, command):
        self.command = command
        self.executed.set()
        return True

    def result(self):
        words = shlex.split(self.command.decode("ascii"))
        if len(words) != 8 or words[:3] != ["python3", "-B", "-c"] or words[4:6] != ["--expected-ipv4", "203.0.113.4"] or words[6] != "--expected-ssh-source":
            raise AssertionError("Unexpected privacy command")
        match = re.fullmatch(r'import base64;exec\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\)', words[2 + 1])
        if not match or base64.b64decode(match.group(1)) != (APP / "RemoteCodexPrivacy.py").read_bytes():
            raise AssertionError("Unexpected remote helper")
        runner = """import base64,sys
scope={'__name__':'fixture_helper'}
exec(compile(base64.b64decode(sys.argv[1]),'<fixture>','exec'),scope)
scope['preflight']=lambda *args: True
scope['shutil'].which=lambda *args,**kwargs:'/fixture/codex'
def execute(path,argv,env):
 if any(k.upper().startswith('SSH_') for k in env): raise RuntimeError('SSH environment leaked')
 print('fixture-codex-started',flush=True)
 raise SystemExit(0)
scope['os'].execve=execute
sys.exit(scope['main'](sys.argv[2:]))
"""
        env = os.environ.copy()
        env["SSH_CONNECTION"] = f"{self.actual_source} 23456 192.0.2.8 22"
        return subprocess.run([sys.executable, "-B", "-c", runner, match.group(1), *words[4:]],
                              env=env, capture_output=True, timeout=10)


class Target:
    def __init__(self, server=None, expect_rejection=False):
        self.host_key = paramiko.RSAKey.generate(2048)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0)); self.listener.listen(1); self.listener.settimeout(12)
        self.port = self.listener.getsockname()[1]
        self.error = None
        self.expect_rejection = expect_rejection
        self.server = server or TestSshServer()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def run(self):
        try:
            with self.listener.accept()[0] as client:
                transport = paramiko.Transport(client)
                transport.add_server_key(self.host_key)
                transport.start_server(server=self.server)
                channel = transport.accept(10)
                if channel is None and self.expect_rejection:
                    transport.close()
                    return
                if channel is None or not self.server.executed.wait(10):
                    raise AssertionError("SSH exec request missing")
                if isinstance(self.server, PrivacySshServer):
                    result = self.server.result()
                    if result.stdout: channel.sendall(result.stdout)
                    if result.stderr: channel.sendall_stderr(result.stderr)
                    channel.send_exit_status(result.returncode)
                else:
                    channel.sendall(b"relay-ssh-ok\n"); channel.send_exit_status(0)
                channel.shutdown_write(); channel.close()
                transport.close()
        except (EOFError, paramiko.SSHException, OSError) as exc:
            if not self.expect_rejection: self.error = exc
        except BaseException as exc:
            self.error = exc
        finally:
            self.listener.close()

    def __exit__(self, exc_type, exc, tb):
        self.thread.join(15)
        if self.thread.is_alive():
            self.listener.close()
            raise AssertionError("SSH fixture did not finish")
        if self.error and not exc_type:
            raise self.error


@unittest.skipUnless(os.name == "nt", "uses Windows OpenSSH and apphost")
class SocksBridgeTests(unittest.TestCase):
    def test_binary_streams_and_half_close(self):
        target = socket.socket(); target.bind(("127.0.0.1", 0)); target.listen(1); target.settimeout(10)
        port = target.getsockname()[1]
        def serve():
            with target.accept()[0] as client:
                data = b""
                while part := client.recv(1024): data += part
                client.sendall(b"reply\x00" + data)
            target.close()
        thread = threading.Thread(target=serve, daemon=True); thread.start()
        with Forwarder(port) as proxy:
            result = subprocess.run([str(BRIDGE), str(proxy.port), "127.0.0.1", str(port)],
                                    input=b"binary\x00\xff", capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b"reply\x00binary\x00\xff")
        thread.join(10); self.assertFalse(thread.is_alive())

    def test_rejected_proxy_does_not_connect_to_target(self):
        target = socket.socket(); target.bind(("127.0.0.1", 0)); target.listen(1); target.settimeout(0.5)
        try:
            with Forwarder(target.getsockname()[1], reject=True) as proxy:
                result = subprocess.run([str(BRIDGE), str(proxy.port), "127.0.0.1", str(target.getsockname()[1])],
                                        input=b"", capture_output=True, timeout=20)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertFalse(proxy.connected)
            with self.assertRaises(socket.timeout): target.accept()
        finally:
            target.close()

    def test_real_windows_ssh_uses_proxy_and_pinned_host_key(self):
        with tempfile.TemporaryDirectory(prefix="relay 中文 with spaces ") as directory, wait_for_copied_bridge(directory), Target() as target, Forwarder(target.port) as proxy:
            # The application path may contain spaces; use only copied build artifacts.
            path = Path(directory)
            for name in ("RemoteSsh.Proxy.exe", "RemoteSsh.Proxy.dll", "RemoteSsh.Proxy.deps.json", "RemoteSsh.Proxy.runtimeconfig.json", "RemoteSsh.Core.dll"):
                shutil.copy2(APP / name, path / name)
            known = path / "known_hosts"
            known.write_text(f"[127.0.0.1]:{target.port} {target.host_key.get_name()} {target.host_key.get_base64()}\n", encoding="ascii")
            before = known.read_bytes()
            bridge = (path / "RemoteSsh.Proxy.exe").as_posix()
            option = f'ProxyCommand="{bridge}" {proxy.port} 127.0.0.1 {target.port}'
            result = subprocess.run([str(SSH), "-F", "NUL", "-o", option, "-o", "ProxyJump=none", "-o", "BatchMode=yes",
                                     "-o", "StrictHostKeyChecking=yes", "-o", f'UserKnownHostsFile="{known.as_posix()}"',
                                     "-o", "GlobalKnownHostsFile=NUL", "-o", "UpdateHostKeys=no", "-p", str(target.port),
                                     "-l", "loopback", "-T", "127.0.0.1", "fixture"], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b"relay-ssh-ok\n")
            self.assertTrue(proxy.connected)
            self.assertTrue(target.server.executed.is_set())
            self.assertEqual(before, known.read_bytes())

    def test_ssh_cannot_fall_back_to_direct_when_proxy_refuses(self):
        target = socket.socket(); target.bind(("127.0.0.1", 0)); target.listen(1); target.settimeout(0.5)
        try:
            port = target.getsockname()[1]
            with Forwarder(port, reject=True) as proxy:
                option = f'ProxyCommand="{BRIDGE.as_posix()}" {proxy.port} 127.0.0.1 {port}'
                result = subprocess.run([str(SSH), "-F", "NUL", "-o", option, "-o", "ProxyJump=none", "-o", "BatchMode=yes",
                                         "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=NUL",
                                         "-o", "GlobalKnownHostsFile=NUL", "-p", str(port), "-l", "loopback",
                                         "-T", "127.0.0.1", "fixture"], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(proxy.connected)
            with self.assertRaises(socket.timeout): target.accept()
        finally:
            target.close()

    def test_wrong_host_key_is_rejected_through_proxy(self):
        with tempfile.TemporaryDirectory(prefix="relay host key ") as directory, Target(expect_rejection=True) as target, Forwarder(target.port) as proxy:
            known = Path(directory) / "known_hosts"
            wrong = paramiko.RSAKey.generate(2048)
            known.write_text(f"[127.0.0.1]:{target.port} {wrong.get_name()} {wrong.get_base64()}\n", encoding="ascii")
            before = known.read_bytes()
            option = f'ProxyCommand="{BRIDGE.as_posix()}" {proxy.port} 127.0.0.1 {target.port}'
            result = subprocess.run([str(SSH), "-F", "NUL", "-o", option, "-o", "ProxyJump=none", "-o", "BatchMode=yes",
                                     "-o", "StrictHostKeyChecking=yes", "-o", f'UserKnownHostsFile="{known.as_posix()}"',
                                     "-o", "GlobalKnownHostsFile=NUL", "-o", "UpdateHostKeys=no", "-p", str(target.port),
                                     "-l", "loopback", "-T", "127.0.0.1", "fixture"], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(target.server.executed.is_set())
            self.assertTrue(proxy.connected)
            self.assertEqual(before, known.read_bytes())

    def test_packaged_console_relays_and_checks_remote_source_before_exec(self):
        for actual, allowed in (("198.51.100.8", True), ("198.51.100.9", False)):
            with self.subTest(allowed=allowed), tempfile.TemporaryDirectory(prefix="privacy relay ") as directory, \
                 Target(PrivacySshServer(actual)) as target, Forwarder(target.port) as proxy:
                known = Path(directory) / "known_hosts"
                known.write_text(f"[127.0.0.1]:{target.port} {target.host_key.get_name()} {target.host_key.get_base64()}\n", encoding="ascii")
                profile = {"Host":"127.0.0.1", "Port":target.port, "User":"loopback", "Authentication":"Password",
                           "IdentityPath":"", "KnownHostsPath":str(known)}
                token = base64.urlsafe_b64encode(json.dumps(profile).encode()).decode().rstrip("=")
                result = subprocess.run([str(APP / "RemoteSsh.Console.exe"), "--connection", token,
                                         "--privacy-ipv4", "203.0.113.4", "--socks-port", str(proxy.port),
                                         "--expected-ssh-source", "198.51.100.8"], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
                self.assertEqual(result.returncode == 0, allowed, result.stderr)
                self.assertEqual(b"fixture-codex-started" in result.stdout, allowed)
                self.assertTrue(proxy.connected)


if __name__ == "__main__":
    unittest.main()
