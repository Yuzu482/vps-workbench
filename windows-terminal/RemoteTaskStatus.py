#!/usr/bin/env python3
"""Read a remote task's status over SSH; retries never launch a task."""
import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import subprocess
import sys
import threading
import time
import uuid
import zlib

MAX_OUTPUT = 8192
MAX_CAPTURED_OUTPUT = 262144
MAX_SCRIPT = 65536
MAX_STEER_REQUEST = 8192
MAX_CATALOG_REQUEST = 16384
ATTEMPT_TIMEOUT = 15
RELAY_READY = b"DSH_VPS_RELAY_READY\n"


def valid_host(value):
    try:
        if "%" in value:
            return False
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return (len(value) <= 253 and bool(value) and all(
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
            for label in value.split(".")))


def checked_path(value):
    path = Path(value)
    if (not path.is_absolute() or not path.is_file() or len(value) > 2048 or
            any(ord(char) < 32 or ord(char) == 127 or char in '"%~*?<>|' for char in value) or "${" in value or
            any(part in (".", "..") for part in value.replace("\\", "/").split("/")) or
            (os.name == "nt" and (not re.match(r"^[A-Za-z]:[\\/]", value) or ":" in value[3:]))):
        raise ValueError("key and known_hosts must be existing absolute paths without expansion syntax")
    return path


def encode_remote_root(value):
    if not posixpath.isabs(value) or len(value) > 2048 or "\x00" in value:
        raise ValueError("remote state directory must be an absolute Linux path")
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def receipt_id(value, host, port, user, remote_root, proposed=None, create=False):
    path = Path(value)
    if not path.is_absolute() or len(value) > 2048:
        raise ValueError("receipt must be an absolute path")
    target = {"host": host.lower(), "port": port, "user": user, "state_dir": remote_root}
    proposed = str(uuid.UUID(proposed)) if proposed is not None else None
    if create:
        identifier = proposed or str(uuid.uuid4())
        record = {"version": 1, "task_id": identifier, **target}
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as stream:
                stream.write(json.dumps(record, separators=(",", ":")).encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
        raise ValueError("receipt is not a valid regular file")
    with path.open("rb") as stream:
        record = json.loads(stream.read(4097).decode("utf-8"))
    if (not isinstance(record, dict) or set(record) != {"version", "task_id", *target} or
            type(record.get("version")) is not int or record.get("version") != 1 or
            type(record.get("port")) is not int or not isinstance(record.get("task_id"), str) or
            any(record.get(key) != item for key, item in target.items())):
        raise ValueError("receipt target does not match")
    identifier = str(uuid.UUID(record["task_id"]))
    if proposed is not None and identifier != proposed:
        raise ValueError("receipt ID does not match")
    return identifier


def build_command(host, port, user, identity, known_hosts, identifier, remote_root=None):
    if not valid_host(host) or not 1 <= port <= 65535:
        raise ValueError("invalid host or port")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@\\-]{0,127}", user):
        raise ValueError("invalid SSH username")
    identity, known_hosts = checked_path(identity), checked_path(known_hosts)
    identifier = str(uuid.UUID(identifier))
    remote = f"python3 -B - status --id {identifier}"
    if remote_root is not None:
        remote += " --state-dir-b64 " + encode_remote_root(remote_root)
    ssh = Path(os.environ.get("WINDIR", "C:/Windows")) / "System32" / "OpenSSH" / "ssh.exe"
    return [str(ssh), "-F", "NUL", "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
            "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes", "-o", "IdentityFile=none", "-o", "BatchMode=yes",
            "-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no",
            "-o", "KbdInteractiveAuthentication=no", "-o", "StrictHostKeyChecking=yes",
            "-o", f'UserKnownHostsFile="{known_hosts.as_posix()}"', "-o", "GlobalKnownHostsFile=NUL",
            "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
            "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no",
            "-o", "CanonicalizeHostname=no", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
            "-i", str(identity), "-p", str(port), "-l", user, "-T", host, remote]


def relay_command(command, environment):
    port = environment.get("DSH_VPS_CHAT_SOCKS_PORT")
    source = environment.get("DSH_VPS_CHAT_EXPECTED_SSH_SOURCE")
    if port is None and source is None:
        return command, False
    if not port or not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535:
        raise ValueError("invalid relay port")
    expected = str(ipaddress.IPv4Address(source))
    helper = Path(__file__).resolve().parent / "relay" / "RemoteSsh.Proxy.exe"
    path = helper.as_posix()
    if not re.fullmatch(r"[A-Za-z]:/[\w. /-]+", path) or not helper.is_file():
        raise ValueError("relay launcher unavailable")
    options = list(command)
    host, port_target = options[-2], options[options.index("-p") + 1]
    options[options.index("ProxyCommand=none")] = f'ProxyCommand="{path}" {port} {host} {port_target}'
    options[-1] = (
        f'case "${{SSH_CONNECTION-}}" in \'{expected} \'*) '
        f"printf '%s\\n' DSH_VPS_RELAY_READY; exec {options[-1]};; *) exit 41;; esac"
    )
    return options, True


def run_ssh(command, payload, timeout=ATTEMPT_TIMEOUT, stdout_limit=MAX_OUTPUT):
    env = os.environ.copy()
    env["SSH_ASKPASS_REQUIRE"] = "never"
    try:
        command, relayed = relay_command(command, env)
    except (ValueError, TypeError, OSError):
        return None, b""
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    output = {"stdout": bytearray(), "stderr": bytearray()}
    overflow = threading.Event()
    relay_checked = threading.Event()
    relay_verified = threading.Event()

    def stop():
        try:
            if process.poll() is None:
                process.kill()
        except OSError:
            pass

    def drain(stream, name):
        try:
            if relayed and name == "stdout":
                if stream.readline(len(RELAY_READY)) != RELAY_READY:
                    relay_checked.set()
                    stop()
                    return
                relay_verified.set()
                relay_checked.set()
            while True:
                data = stream.read(4096)
                if not data:
                    break
                limit = stdout_limit if name == "stdout" else MAX_OUTPUT
                if len(output[name]) + len(data) > limit:
                    overflow.set()
                    stop()
                    break
                output[name].extend(data)
        except (OSError, ValueError):
            pass

    def send():
        try:
            if relayed and (not relay_checked.wait(timeout) or not relay_verified.is_set()):
                return
            process.stdin.write(payload)
        except (OSError, ValueError):
            pass
        finally:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass

    threads = [threading.Thread(target=drain, args=(process.stdout, "stdout"), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, "stderr"), daemon=True),
               threading.Thread(target=send, daemon=True)]
    for thread in threads:
        thread.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        stop()
        process.wait(timeout=5)
    finally:
        stop()
        relay_checked.set()
        for thread in threads:
            thread.join(timeout=2)
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
    if timed_out or overflow.is_set() or (relayed and not relay_verified.is_set()) or any(thread.is_alive() for thread in threads):
        return None, b""
    return process.returncode, bytes(output["stdout"])


def parse_status(raw, identifier):
    try:
        value = json.loads(raw.decode("utf-8"))
        if (not isinstance(value, dict) or value.get("task_id") != identifier or
                value.get("state") not in {"not_found", "unknown", "running", "finished", "launch_failed"}):
            return None
        if value["state"] == "finished" and type(value.get("exit_code")) is not int:
            return None
        return value
    except (ValueError, UnicodeError):
        return None


def query(command, payload, identifier, attempts=3, interval=1, runner=run_ssh):
    for number in range(1, attempts + 1):
        try:
            code, raw = runner(command, payload)
        except (OSError, subprocess.SubprocessError):
            code, raw = None, b""
        if code == 0:
            value = parse_status(raw, identifier)
            if value is None:
                return {"task_id": identifier, "state": "unknown", "reason": "invalid_status_response"}, 2
            return value, 0
        if code is not None and code != 255:
            value = parse_status(raw, identifier)
            if value is not None and value["state"] == "unknown":
                return value, 2
            return {"task_id": identifier, "state": "unknown", "reason": "remote_status_failed"}, 2
        if number < attempts and interval:
            time.sleep(interval)
    return {"task_id": identifier, "state": "unknown", "reason": "ssh_status_unavailable", "attempts": attempts}, 2


def chat_request(command, task_helper, identifier, action, request=None):
    local = Path(__file__).resolve().parent
    stream_helper = (local / "RemoteDshCodexStream.py").read_bytes()
    encoded_request = None if request is None else base64.b64encode(request).decode("ascii")
    script = (
        "import base64, json, sys, zlib\ntask = {'__name__': 'remote_task'}\nstream = {'__name__': 'dsh_chat_stream'}\n"
        f"exec(zlib.decompress(base64.b64decode({base64.b64encode(zlib.compress(task_helper, 9))!r})), task)\n"
        f"exec(zlib.decompress(base64.b64decode({base64.b64encode(zlib.compress(stream_helper, 9))!r})), stream)\n"
        f"request = {encoded_request!r}\n"
        "sys.exit(stream['remote_control'](task, sys.argv[1], sys.argv[2], "
        "json.loads(base64.b64decode(request)) if request is not None else None))\n"
    ).encode("ascii")
    if len(script) > MAX_SCRIPT:
        raise ValueError("chat control script exceeds its limit")
    command[-1] = f"python3 -I -B - {action} {identifier}"
    code, response = run_ssh(command, script, stdout_limit=MAX_CAPTURED_OUTPUT)
    if code != 0:
        return 2
    sys.stdout.buffer.write(response)
    sys.stdout.buffer.flush()
    return 0


def artifact_request(command, identifier, request):
    local = Path(__file__).resolve().parent
    script = bytearray(b"import base64,json,sys,zlib\nfrom pathlib import Path\n")
    for name, file in (("workflow", "RemoteWorkflowFiles.py"), ("artifacts", "RemoteWorkflowArtifacts.py")):
        raw = (local / file).read_bytes()
        if not 0 < len(raw) <= 32768:
            raise ValueError("invalid artifact helper size")
        packed = base64.b64encode(zlib.compress(raw, 9))
        script.extend(f"{name}={{'__name__':'{name}'}}\nexec(zlib.decompress(base64.b64decode({packed!r})), {name})\n".encode("ascii"))
    script.extend((
        f"query=json.loads(base64.b64decode({base64.b64encode(request)!r}))\n"
        "try:\n"
        " result=artifacts['read_artifacts'](workflow, Path.home(), sys.argv[1], query)\n"
        "except (OSError,ValueError,TypeError):\n"
        " raise SystemExit(2)\n"
        "print(json.dumps({'task_id':sys.argv[1],**result},separators=(',',':')))\n"
    ).encode("ascii"))
    if len(script) > MAX_SCRIPT:
        raise ValueError("artifact script exceeds its limit")
    command[-1] = f"python3 -I -B - {identifier}"
    code, response = run_ssh(command, script, stdout_limit=1536 * 1024)
    if code != 0:
        return 2
    sys.stdout.buffer.write(response)
    sys.stdout.buffer.flush()
    return 0


def model_request(command, identifier, request):
    config = json.loads(request)
    if not isinstance(config, dict):
        raise ValueError("invalid catalog request")
    provider = config.pop("provider", "codex")
    if provider not in ("codex", "antigravity"):
        raise ValueError("invalid catalog provider")
    request = json.dumps(config, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    local = Path(__file__).resolve().parent
    helpers = {
        "privacy": "RemoteCodexPrivacy.py",
        "isolation": "RemoteCodexIsolate.py",
        "stream": "RemoteDshCodexStream.py",
        "models": "RemoteDshAntigravity.py" if provider == "antigravity" else "RemoteDshCodexCatalog.py",
    }
    packed = {}
    for name, filename in helpers.items():
        raw = (local / filename).read_bytes()
        if not 0 < len(raw) <= MAX_SCRIPT:
            raise ValueError("invalid catalog helper size")
        packed[name] = base64.b64encode(zlib.compress(raw, 9)).decode("ascii")
    script = (
        "import base64, json, subprocess, sys, zlib\n"
        f"packed = {packed!r}\n"
        "modules = {}\n"
        "for name, code in packed.items():\n"
        "    scope = {'__name__': name}\n"
        "    exec(zlib.decompress(base64.b64decode(code)), scope)\n"
        "    modules[name] = scope\n"
        "try:\n"
        f"    config = json.loads(base64.b64decode({base64.b64encode(request)!r}))\n"
        "    rows = modules['models']['catalog'](config, modules['privacy'], modules['isolation'], modules['stream'])\n"
        "except (OSError, ValueError, KeyError, TypeError, EOFError, subprocess.SubprocessError):\n"
        "    raise SystemExit(2)\n"
        "sys.stdout.buffer.write(json.dumps({'task_id': sys.argv[1], 'models': rows}, "
        "ensure_ascii=False, separators=(',', ':')).encode('utf-8'))\n"
    ).encode("ascii")
    if len(script) > MAX_SCRIPT:
        raise ValueError("catalog script exceeds its limit")
    command[-1] = f"python3 -I -B - {identifier}"
    code, response = run_ssh(command, script, timeout=49, stdout_limit=MAX_CAPTURED_OUTPUT)
    if code != 0:
        return 2
    sys.stdout.buffer.write(response)
    sys.stdout.buffer.flush()
    return 0


def setup_request(command, identifier, request):
    config = json.loads(request)
    if set(config) != {"kind", "provider", "workspace", "mcpServers", "enforceEncryptedKey", "expectedIpv4", "expectedIpv6"}:
        raise ValueError("invalid setup request")
    kind, provider, workspace, servers = (config[key] for key in ("kind", "provider", "workspace", "mcpServers"))
    if (kind not in ("ssh", "account", "model", "resources") or provider not in ("codex", "claude", "claude-sdk", "antigravity") or
            not isinstance(workspace, str) or not workspace.startswith("/") or len(workspace) > 2048 or
            not isinstance(servers, list) or len(servers) > 8 or
            (servers and (kind != "resources" or provider not in ("codex", "antigravity"))) or
            any(not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name) for name in servers) or
            len(set(servers)) != len(servers) or type(config["enforceEncryptedKey"]) is not bool):
        raise ValueError("invalid setup request")
    helpers = {"setup": "RemoteDshSetup.py"}
    if kind == "account" and provider != "antigravity":
        helpers["isolation"] = "RemoteCodexIsolate.py"
        if provider == "claude-sdk":
            helpers["sdk"] = "RemoteDshClaudeSdk.py"
    if kind == "resources":
        helpers["extensions"] = "RemoteDshExtensions.py"
    if kind == "model":
        helpers["privacy"] = "RemoteCodexPrivacy.py"
        if provider == "antigravity":
            helpers["agy"] = "RemoteDshAntigravity.py"
    local = Path(__file__).resolve().parent
    packed = {}
    for name, filename in helpers.items():
        raw = (local / filename).read_bytes()
        if not 0 < len(raw) <= MAX_SCRIPT:
            raise ValueError("invalid setup helper size")
        packed[name] = base64.b64encode(zlib.compress(raw, 9)).decode("ascii")
    script = (
        "import base64, json, sys, zlib\n"
        f"packed = {packed!r}\n"
        "modules = {}\n"
        "for name, code in packed.items():\n"
        "    scope = {'__name__': name}\n"
        "    exec(zlib.decompress(base64.b64decode(code)), scope)\n"
        "    modules[name] = scope\n"
        f"config = json.loads(base64.b64decode({base64.b64encode(request)!r}))\n"
        "status = modules['setup']['check'](config, modules)\n"
        "print(json.dumps({'task_id': sys.argv[1], 'status': status}))\n"
    ).encode("ascii")
    if len(script) > MAX_SCRIPT:
        raise ValueError("setup script exceeds its limit")
    command[-1] = f"python3 -I -B - {identifier}"
    code, response = run_ssh(command, script, timeout=46 if kind == "model" else 25, stdout_limit=2048)
    if code != 0:
        return 2
    sys.stdout.buffer.write(response)
    sys.stdout.buffer.flush()
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--user", required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--known-hosts", required=True)
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument("--id")
    identity.add_argument("--receipt", help="Local receipt created before submission")
    parser.add_argument("--state-dir", help="Optional absolute Linux state directory")
    streams = parser.add_mutually_exclusive_group()
    streams.add_argument("--output", action="store_true", help="Explicitly retrieve captured standard output")
    streams.add_argument("--stderr", action="store_true", help="Explicitly retrieve captured standard error")
    streams.add_argument("--chat-snapshot", action="store_true", help=argparse.SUPPRESS)
    streams.add_argument("--chat-stop", action="store_true", help=argparse.SUPPRESS)
    streams.add_argument("--chat-steer", action="store_true", help=argparse.SUPPRESS)
    streams.add_argument("--chat-approval", action="store_true", help=argparse.SUPPRESS)
    streams.add_argument("--chat-models", action="store_true", help=argparse.SUPPRESS)
    streams.add_argument("--setup-check", action="store_true", help=argparse.SUPPRESS)
    streams.add_argument("--workflow-artifacts", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--interval", type=float, default=1)
    args = parser.parse_args(argv)
    if not 1 <= args.attempts <= 3 or not 0 <= args.interval <= 5:
        parser.error("attempts must be 1-3 and interval must be 0-5 seconds")
    try:
        identifier = (receipt_id(args.receipt, args.host, args.port, args.user, args.state_dir)
                      if args.receipt else str(uuid.UUID(args.id)))
        command = build_command(args.host, args.port, args.user, args.identity, args.known_hosts, identifier, args.state_dir)
        if args.workflow_artifacts:
            request = sys.stdin.buffer.read(4097)
            if not args.receipt or args.state_dir is not None or not 0 < len(request) <= 4096:
                raise ValueError("invalid artifact request")
            return artifact_request(command, identifier, request)
        if args.chat_models or args.setup_check:
            if args.receipt or args.state_dir is not None:
                raise ValueError("catalog requires an independent query ID")
            request = sys.stdin.buffer.read(MAX_CATALOG_REQUEST + 1)
            if not request or len(request) > MAX_CATALOG_REQUEST:
                raise ValueError("invalid catalog request size")
            return (setup_request if args.setup_check else model_request)(command, identifier, request)
        payload = (Path(__file__).resolve().parent / "RemoteTask.py").read_bytes()
        if not payload or len(payload) > MAX_SCRIPT:
            raise ValueError("invalid helper size")
        if args.chat_snapshot or args.chat_stop or args.chat_steer or args.chat_approval:
            if not args.receipt or args.state_dir is not None:
                raise ValueError("chat control requires a default-root receipt")
            if args.chat_steer or args.chat_approval:
                limit = MAX_STEER_REQUEST if args.chat_steer else 512
                request = sys.stdin.buffer.read(limit + 1)
                if not request or len(request) > limit:
                    raise ValueError("invalid chat control size")
                return chat_request(command, payload, identifier, "steer" if args.chat_steer else "approval", request)
            return chat_request(command, payload, identifier, "stop" if args.chat_stop else "snapshot")
        if args.output or args.stderr:
            command[-1] = command[-1].replace(" - status --id ", " - output --id ", 1)
            if args.stderr:
                command[-1] += " --stream stderr"
            try:
                remote_code, raw = run_ssh(command, payload, stdout_limit=MAX_CAPTURED_OUTPUT)
            except (OSError, subprocess.SubprocessError):
                remote_code, raw = None, b""
            if remote_code != 0:
                print("Captured output is unavailable; task status has not been inferred.", file=sys.stderr)
                return 2
            sys.stdout.buffer.write(raw)
            sys.stdout.buffer.flush()
            return 0
        result, code = query(command, payload, identifier, args.attempts, args.interval)
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        result, code = {"state": "unknown", "reason": "invalid_configuration"}, 2
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
