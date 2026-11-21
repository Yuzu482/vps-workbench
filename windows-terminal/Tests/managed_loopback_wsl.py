"""Exercise the manager task client through Windows OpenSSH and a local Linux fixture.

The Paramiko SSH server listens only on loopback, accepts one generated test
key, and executes only the exact helper commands in a disposable WSL directory.
It discards the first successful start acknowledgement to simulate a drop.
"""
import base64
import json
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import uuid

import paramiko
import loopback

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "artifacts" / "app"
HARNESS = ROOT / "ManagedTaskHarness" / "bin" / "Release" / "net10.0-windows" / "ManagedTaskHarness.exe"
WSL = Path(os.environ["SystemRoot"]) / "System32" / "wsl.exe"
DISTRO = os.environ.get("REMOTE_TEST_WSL_DISTRO", "Ubuntu-24.04")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
START = re.compile(r"^python3 -B -c 'import base64;exec\(base64.b64decode\(\"([A-Za-z0-9+/=]+)\"\)\)' start --id (" + UUID + r") --state-dir-b64 ([A-Za-z0-9_-]+) --payload-stdin$")
READ = re.compile(r"^python3 -B - (status|output) --id (" + UUID + r") --state-dir-b64 ([A-Za-z0-9_-]+)(?: --stream stderr)?$")


class ExecServer(loopback.Server):
    def __init__(self, fixture):
        super().__init__(fixture)
        self.ready = threading.Event()
        self.command = None

    def check_channel_exec_request(self, channel, command):
        self.command = command.decode("ascii")
        self.ready.set()
        return True


class ExecFixture(loopback.Fixture):
    def __init__(self, remote_root):
        super().__init__()
        self.remote_root = remote_root
        self.actions = []
        self.dropped = False

    def serve(self):
        helper = (APP / "RemoteTask.py").read_bytes()
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
                self.transport = paramiko.Transport(conn)
                self.transport.add_server_key(self.host)
                server = ExecServer(self)
                self.transport.start_server(server=server)
                channel = self.transport.accept(15)
                if channel is None or not server.ready.wait(10) or not server.authenticated:
                    raise RuntimeError("Missing authenticated exec request")
                match = START.fullmatch(server.command)
                reading = READ.fullmatch(server.command)
                if match:
                    if base64.b64decode(match.group(1)) != helper: raise RuntimeError("Unexpected start helper")
                    action, root_token = "start", match.group(3)
                elif reading:
                    action, root_token = reading.group(1), reading.group(3)
                else:
                    raise RuntimeError("Unexpected remote command")
                root = base64.urlsafe_b64decode(root_token + "=" * (-len(root_token) % 4)).decode()
                if root != self.remote_root: raise RuntimeError("Unexpected state directory")
                data = bytearray()
                while part := channel.recv(65536):
                    data.extend(part)
                    if len(data) > 65536: raise RuntimeError("Unexpectedly large test payload")
                if action != "start" and bytes(data) != helper: raise RuntimeError("Unexpected read helper")
                self.actions.append(action)
                process = subprocess.run([str(WSL), "-d", DISTRO, "--exec", "sh", "-c", server.command],
                                         input=bytes(data), capture_output=True, timeout=25, check=False)
                if action == "start" and not self.dropped:
                    reply = json.loads(process.stdout.decode("utf-8"))
                    if process.returncode != 0 or reply.get("outcome") != "accepted":
                        raise RuntimeError("Fixture failed before dropping acknowledgement")
                    self.dropped = True
                    channel.close()
                    self.transport.close()
                    continue
                if process.stdout: channel.sendall(process.stdout)
                if process.stderr: channel.sendall_stderr(process.stderr)
                channel.send_exit_status(process.returncode)
                channel.shutdown_write()
                channel.close()
                deadline = time.monotonic() + 2
                while self.transport.is_active() and not self.stopped.is_set() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.transport.close()
        except BaseException as error:
            if not self.stopped.is_set(): self.errors.put(error)
        finally:
            if self.transport: self.transport.close()
            self.listener.close()


def cleanup(root, identifier):
    script = r'''import json,os,pathlib,re,shutil,sys
p=pathlib.Path(sys.argv[1]); ident=sys.argv[2]
assert p.parent==pathlib.Path('/tmp') and re.fullmatch(r'remote-managed-ui-[0-9a-f]{32}',p.name)
assert not p.is_symlink() and p.is_dir() and p.stat().st_uid==os.getuid()
record=json.loads((p/'tasks'/ident/'state.json').read_text())
assert record['task_id']==ident and record['phase']=='finished' and record['exit_code']==0
assert (p/'once.txt').read_text()=='once\n'
shutil.rmtree(p)
assert not p.exists()
print('PASS: exactly one side effect; disposable Linux state cleaned')
'''
    return subprocess.run([str(WSL), "-d", DISTRO, "--exec", "python3", "-c", script, root, identifier],
                          capture_output=True, timeout=15, check=False)


def main():
    if not HARNESS.is_file(): raise RuntimeError("Build ManagedTaskHarness in Release first")
    root = "/tmp/remote-managed-ui-" + uuid.uuid4().hex
    state = root + "/tasks"
    config = None
    with ExecFixture(state) as fixture:
        config = fixture.work / "manager-test.json"
        receipt = fixture.work / "receipt.json"
        config.write_text(json.dumps({"host": "127.0.0.1", "port": fixture.port,
                                      "identity": fixture.profile["IdentityPath"], "known": fixture.profile["KnownHostsPath"],
                                      "receipt": str(receipt), "state_root": state, "app": str(APP),
                                      "python": "python.exe", "side_effect": root + "/once.txt"}), encoding="utf-8")
        try:
            result = subprocess.run([str(HARNESS), str(config)], capture_output=True, timeout=90, check=False)
            print(result.stdout.decode("utf-8", errors="replace"), end="", flush=True)
            if result.returncode:
                raise RuntimeError("Manager task harness failed: " + result.stderr.decode("utf-8", errors="replace")[-1500:])
            if fixture.actions.count("start") != 1 or not fixture.dropped or "status" not in fixture.actions:
                raise RuntimeError("Expected one start, a dropped acknowledgement and a status query")
            identifier = json.loads(receipt.read_text())["task_id"]
            cleaned = cleanup(root, identifier)
            if cleaned.returncode: raise RuntimeError("Disposable Linux state could not be verified and cleaned")
            print(cleaned.stdout.decode("utf-8"), end="", flush=True)
        except BaseException:
            print("Retained Linux test state if created: " + root, file=sys.stderr, flush=True)
            raise
    print("PASS: test SSH listener, key and local receipt cleaned; host trust unchanged")


if __name__ == "__main__":
    main()
