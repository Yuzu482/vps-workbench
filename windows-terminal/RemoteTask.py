#!/usr/bin/env python3
"""One-shot Linux tasks with durable IDs and conservative status reporting.

This is for non-interactive commands only. It never retries a task, and it does
not turn a lost supervisor or an incomplete record into evidence of failure.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import select
import selectors
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone

MAX_PAYLOAD = 32768
MAX_CHAT_PAYLOAD = 1280 * 1024
MAX_RECORD = 16384
MAX_OUTPUT = 262144
VERSION = 1
DEFAULT_ROOT = Path.home() / ".local" / "state" / "remote-ssh" / "tasks"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def task_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError) as error:
        raise argparse.ArgumentTypeError("task ID must be a UUID") from error


def state_root(value, encoded=None):
    if value is not None and encoded is not None:
        raise ValueError("choose one state directory")
    if encoded is not None:
        if len(encoded) > 4096 or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
            raise ValueError("invalid encoded state directory")
        try:
            raw = encoded.encode("ascii")
            value = base64.b64decode(raw + b"=" * (-len(raw) % 4), altchars=b"-_", validate=True).decode("utf-8")
        except (ValueError, UnicodeError) as error:
            raise ValueError("invalid encoded state directory") from error
    root = Path(value).expanduser() if value is not None else DEFAULT_ROOT
    if not root.is_absolute() or len(str(root)) > 2048 or "\x00" in str(root):
        raise ValueError("state directory must be an absolute path")
    return root


def private_directory(path, create=False):
    if create:
        missing = []
        parent = path
        while not parent.exists():
            missing.append(parent)
            if parent.parent == parent:
                raise ValueError("cannot create state directory")
            parent = parent.parent
        for directory in reversed(missing):
            try:
                directory.mkdir(mode=0o700)
                sync_directory(directory.parent)
            except FileExistsError:
                pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("state directory must be private and owned by the current user")


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_record(directory, record):
    temp = directory / (".state-" + uuid.uuid4().hex + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(record, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, directory / "state.json")
        sync_directory(directory)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def read_record(directory):
    fd = os.open(directory / "state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("record is not a regular file")
        raw = stream.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError("record too large")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("invalid record")
    return value


def process_identity(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    try:
        proc = Path("/proc") / str(pid)
        if proc.stat().st_uid != os.getuid():
            return None
        value = (proc / "stat").read_text(encoding="ascii")
        end = value.rfind(")")
        fields = value[end + 2:].split() if end >= 0 else []
        if len(fields) < 20 or fields[0] in ("Z", "X"):
            return None
        boot = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
        return {"pid": pid, "start_ticks": int(fields[19]), "boot_id": boot}
    except (OSError, ValueError, UnicodeError):
        return None


def same_process(value):
    return (isinstance(value, dict) and set(value) == {"pid", "start_ticks", "boot_id"}
            and process_identity(value.get("pid")) == value)


def inspect(root, identifier):
    result = {"task_id": identifier, "state": "unknown"}
    try:
        private_directory(root)
        directory = root / identifier
        private_directory(directory)
        record = read_record(directory)
        if record.get("version") != VERSION or record.get("task_id") != identifier:
            raise ValueError("record identity mismatch")
        phase = record.get("phase")
        if phase == "running":
            if same_process(record.get("supervisor")) and same_process(record.get("worker")):
                result["state"] = "running"
            else:
                result["reason"] = "process_identity_unconfirmed"
        elif phase == "finished" and type(record.get("exit_code")) is int:
            result.update(state="finished", exit_code=record["exit_code"],
                          output_captured=record.get("output_captured") is True,
                          output_truncated=record.get("output_truncated") is True,
                          stdout_truncated=record.get("stdout_truncated") is True,
                          stderr_truncated=record.get("stderr_truncated") is True)
        elif phase == "launch_failed":
            result["state"] = "launch_failed"
        elif phase == "reserved":
            result["reason"] = "reserved_not_finalized"
        else:
            result["reason"] = "invalid_record"
    except FileNotFoundError:
        # A missing record inside an existing task directory is uncertain.
        result["state"] = "unknown" if (root / identifier).exists() else "not_found"
        result["reason"] = "record_missing" if result["state"] == "unknown" else "task_directory_missing"
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        result["reason"] = "record_unavailable_or_invalid"
    return result


def validate_command(command, cwd):
    if not command or len(command) > 64 or not os.path.isabs(cwd) or not os.path.isdir(cwd):
        raise ValueError("a command and an existing absolute working directory are required")
    if not command[0] or any(not isinstance(item, str) or "\x00" in item or len(item) > 12288 for item in command):
        raise ValueError("invalid command arguments")
    payload = json.dumps({"command": command, "cwd": cwd}, ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("command is too large")


def start(root, identifier, command, cwd, capture, chat_stream=False, chat_input=None):
    validate_command(command, cwd)
    payload = json.dumps({"command": command, "cwd": cwd, "capture": capture}, ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("command is too large")
    private_directory(root, create=True)
    directory = root / identifier
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        return {"task_id": identifier, "outcome": "already_exists", "status": inspect(root, identifier)}, 3
    # A crash after reservation is intentionally unresolved; never delete the ID.
    sync_directory(root)
    record = {"version": VERSION, "task_id": identifier, "phase": "reserved", "created_at": now()}
    if chat_stream:
        record["chat_stream"] = True
    write_record(directory, record)
    read_fd, write_fd = os.pipe()
    try:
        pid = os.fork()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        raise
    if pid == 0:
        os.close(read_fd)
        detached = False
        try:
            os.setsid()
            null_fd = os.open(os.devnull, os.O_RDWR)
            for descriptor in (0, 1, 2):
                os.dup2(null_fd, descriptor)
            if null_fd > 2:
                os.close(null_fd)
            os.write(write_fd, b"1")
            detached = True
        except BaseException:
            try:
                os.write(write_fd, b"0")
            except OSError:
                pass
        finally:
            os.close(write_fd)
        if detached:
            try:
                supervise(root, identifier, {"command": command, "cwd": cwd, "capture": capture,
                                             "chatInput": chat_input})
            except BaseException:
                pass
        os._exit(0)
    os.close(write_fd)
    try:
        ready, _, _ = select.select([read_fd], [], [], 5)
        handoff = os.read(read_fd, 1) if ready else b""
    finally:
        os.close(read_fd)
    if handoff != b"1":
        # The supervisor may already have started the task. Keep the reservation.
        return {"task_id": identifier, "outcome": "unknown", "reason": "supervisor_handoff_uncertain"}, 2
    return {"task_id": identifier, "outcome": "accepted", "state": "unknown"}, 0


def supervise(root, identifier, request):
    private_directory(root)
    directory = root / identifier
    private_directory(directory)
    claim = os.open(directory / ".supervisor-claim", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(claim)
    sync_directory(directory)
    command, cwd, capture = request["command"], request["cwd"], request["capture"]
    if not isinstance(command, list) or type(capture) is not bool:
        raise ValueError("invalid payload")
    validate_command(command, cwd)
    record = read_record(directory)
    if record.get("version") != VERSION or record.get("task_id") != identifier or record.get("phase") != "reserved":
        raise ValueError("task is not reserved")
    outputs = {}
    try:
        stream_input = None
        if record.get("chat_stream") is True:
            if request.get("chatInput") is None:
                stream_input = command[-1].encode("ascii")
                command = command[:-1]
            else:
                stream_input = json.dumps(request["chatInput"], ensure_ascii=False,
                                          separators=(",", ":")).encode("utf-8")
        if capture:
            for name in ("stdout", "stderr"):
                fd = os.open(directory / (name + ".bin"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                outputs[name] = os.fdopen(fd, "wb")
        try:
            # SSH client addresses and agent sockets must not be inherited by the
            # task. This affects only the worker, not the login or server config.
            worker_env = {key: value for key, value in os.environ.items() if not key.upper().startswith("SSH_")}
            worker = subprocess.Popen(command, cwd=cwd,
                                      stdin=subprocess.PIPE if stream_input is not None else subprocess.DEVNULL, env=worker_env,
                                      stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                      stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
                                      close_fds=True)
        except OSError:
            record.update(phase="launch_failed", completed_at=now())
            write_record(directory, record)
            return
        record.update(phase="running", started_at=now(), supervisor=process_identity(os.getpid()),
                      worker=process_identity(worker.pid))
        write_record(directory, record)
        if stream_input is not None:
            try:
                with worker.stdin as stream:
                    stream.write(stream_input)
            except BrokenPipeError:
                pass
        written = {"stdout": 0, "stderr": 0}
        truncated = {"stdout": False, "stderr": False}
        if capture:
            with selectors.DefaultSelector() as selector:
                for name, stream in (("stdout", worker.stdout), ("stderr", worker.stderr)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, name)
                while selector.get_map():
                    for key, _ in selector.select():
                        try:
                            chunk = os.read(key.fd, 8192)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                            continue
                        name = key.data
                        remaining = MAX_OUTPUT - written[name]
                        if remaining > 0:
                            piece = chunk[:remaining]
                            outputs[name].write(piece)
                            # Permit a reconnecting reader to see completed
                            # output while the task is still running. Durability
                            # is still confirmed only by the final fsync/state.
                            outputs[name].flush()
                            written[name] += len(piece)
                        if len(chunk) > remaining:
                            truncated[name] = True
            for output in outputs.values():
                output.flush()
                os.fsync(output.fileno())
        code = worker.wait()
        record.update(phase="finished", completed_at=now(), exit_code=code,
                      output_captured=capture, output_truncated=any(truncated.values()),
                      stdout_truncated=truncated["stdout"], stderr_truncated=truncated["stderr"])
        record.pop("supervisor", None)
        record.pop("worker", None)
        write_record(directory, record)
    finally:
        for output in outputs.values():
            output.close()


def output_file(root, identifier, stream_name):
    private_directory(root)
    directory = root / identifier
    private_directory(directory)
    fd = os.open(directory / (stream_name + ".bin"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("output is not a regular file")
        data = stream.read(MAX_OUTPUT + 1)
    if len(data) > MAX_OUTPUT:
        raise ValueError("output exceeds the capture limit")
    sys.stdout.buffer.write(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for name in ("start", "status", "output"):
        command = commands.add_parser(name)
        command.add_argument("--id", type=task_id, required=True)
        command.add_argument("--state-dir")
        command.add_argument("--state-dir-b64", help=argparse.SUPPRESS)
        if name == "start":
            command.add_argument("--cwd", default=os.getcwd())
            command.add_argument("--capture-output", action="store_true")
            command.add_argument("--chat-stream", action="store_true")
            command.add_argument("--payload-stdin", action="store_true", help=argparse.SUPPRESS)
            command.add_argument("command", nargs=argparse.REMAINDER)
        elif name == "output":
            command.add_argument("--stream", choices=("stdout", "stderr"), default="stdout")
    args = parser.parse_args(argv)
    if sys.platform != "linux":
        parser.error("this helper requires Linux")
    try:
        root = state_root(args.state_dir, args.state_dir_b64)
        if args.action == "start":
            chat_input = None
            if args.payload_stdin:
                if args.command or args.capture_output:
                    raise ValueError("payload cannot be combined with command arguments")
                limit = MAX_CHAT_PAYLOAD if args.chat_stream else MAX_PAYLOAD
                payload = sys.stdin.buffer.read(limit + 1)
                if len(payload) > limit:
                    raise ValueError("payload too large")
                request = json.loads(payload.decode("utf-8"))
                if args.chat_stream and isinstance(request, dict) and isinstance(request.get("chatInput"), dict):
                    chat_input = request.pop("chatInput")
                elif len(payload) > MAX_PAYLOAD:
                    raise ValueError("payload too large")
                if not isinstance(request, dict) or set(request) != {"command", "cwd", "capture"}:
                    raise ValueError("invalid payload")
                command, cwd, capture = request["command"], request["cwd"], request["capture"]
                if not isinstance(command, list) or type(capture) is not bool or (cwd is not None and not isinstance(cwd, str)):
                    raise ValueError("invalid payload")
                cwd = cwd if cwd is not None else os.getcwd()
            else:
                command = args.command[1:] if args.command[:1] == ["--"] else args.command
                cwd, capture = args.cwd, args.capture_output
            if args.chat_stream and (not args.payload_stdin or not capture or args.state_dir is not None or args.state_dir_b64 is not None):
                raise ValueError("invalid chat stream request")
            result, code = start(root, args.id, command, cwd, capture, args.chat_stream, chat_input)
        elif args.action == "status":
            result, code = inspect(root, args.id), 0
        elif args.action == "output":
            output_file(root, args.id, args.stream)
            return 0
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError, KeyError, TypeError):
        result, code = {"task_id": args.id, "state": "unknown", "reason": "local_error"}, 2
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
