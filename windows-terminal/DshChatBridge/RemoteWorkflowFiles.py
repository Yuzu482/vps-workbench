"""Materialize one workbench stage's explicit file grants before its sandbox starts."""
import base64
import array
import contextlib
import ctypes
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import uuid


ATTACHMENT_BYTES = 512 * 1024
FILE_BYTES = 32 * 1024 * 1024
PROJECT_BYTES = 64 * 1024 * 1024
OUTPUT_BYTES = 256 * 1024 * 1024
OUTPUT_ENTRIES = 8192


def parts(name, single=False):
    if (not isinstance(name, str) or not name or len(name.encode("utf-8")) > 512 or
            "\\" in name or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name)):
        raise ValueError("invalid workflow file name")
    segments = name.split("/")
    if ((single and len(segments) != 1) or
            any(s in ("", ".", "..") or len(s.encode("utf-8")) > 255 for s in segments)):
        raise ValueError("invalid workflow path")
    return segments


def validate(value):
    if not isinstance(value, dict) or set(value) != {"paths", "attachments"}:
        raise ValueError("invalid workflow grant")
    paths, attachments = value["paths"], value["attachments"]
    if not isinstance(paths, list) or len(paths) > 16 or not isinstance(attachments, list) or len(attachments) > 8:
        raise ValueError("invalid workflow grant count")
    grants = [parts(name) for name in paths]
    if len(set(paths)) != len(paths):
        raise ValueError("duplicate workflow path")
    files, size = {}, 0
    for item in attachments:
        if not isinstance(item, dict) or set(item) != {"name", "data"}:
            raise ValueError("invalid workflow attachment")
        name, = parts(item["name"], single=True)
        encoded = item["data"]
        if name in files or not isinstance(encoded, str) or len(encoded) > 4 * ((ATTACHMENT_BYTES - size + 2) // 3):
            raise ValueError("invalid workflow attachment")
        raw = base64.b64decode(encoded, validate=True)
        size += len(raw)
        if size > ATTACHMENT_BYTES or base64.b64encode(raw).decode("ascii") != encoded:
            raise ValueError("invalid workflow attachment data")
        files[name] = raw
    return grants, files


@contextlib.contextmanager
def opened(name, flags, parent=None):
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


def snapshot(root, segments, destination, remaining):
    with contextlib.ExitStack() as stack:
        parent = root
        for segment in segments[:-1]:
            parent = stack.enter_context(opened(segment, os.O_RDONLY | os.O_DIRECTORY, parent))
        # Inspect the inode without opening devices or FIFOs. Pin it while reading.
        fd = stack.enter_context(opened(segments[-1], os.O_PATH, parent))
        before = os.fstat(fd)
        limit = min(FILE_BYTES, remaining)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError("invalid workflow input file")
        target = destination.joinpath(*segments)
        target.parent.mkdir(parents=True, exist_ok=True)
        with open("/proc/self/fd/" + str(fd), "rb") as source, target.open("xb") as output:
            count = 0
            while chunk := source.read(min(65536, limit - count + 1)):
                count += len(chunk)
                if count > limit:
                    raise ValueError("workflow input too large")
                output.write(chunk)
        after = os.fstat(fd)
        if (before.st_size, before.st_ctime_ns) != (count, after.st_ctime_ns):
            raise ValueError("workflow input changed during snapshot")
        return count


def prepare(value, workspace, home, task, temporary, isolated=False):
    grants, files = validate(value)
    if str(uuid.UUID(task)) != task or (isolated and grants):
        raise ValueError("invalid workflow scope")
    project, attachments = Path(temporary) / "project", Path(temporary) / "attachments"
    project.mkdir(mode=0o700)
    attachments.mkdir(mode=0o700)
    if not os.path.isabs(workspace) or os.path.normpath(workspace) != workspace or workspace.startswith("//"):
        raise ValueError("invalid workflow workspace")
    with contextlib.ExitStack() as stack:
        directory = stack.enter_context(opened("/", os.O_DIRECTORY | os.O_RDONLY))
        for component in Path(workspace).parts[1:]:
            directory = stack.enter_context(opened(component, os.O_DIRECTORY | os.O_RDONLY, directory))
        if os.fstat(directory).st_uid != os.getuid():
            raise ValueError("invalid workflow project owner")
        remaining = PROJECT_BYTES
        for segments in grants:
            remaining -= snapshot(directory, segments, project, remaining)
    for name, data in files.items():
        (attachments / name).write_bytes(data)
    root = Path(home)
    for name in (".remote-ssh-chat", "workflow-outputs"):
        root /= name
        root.mkdir(mode=0o700, exist_ok=True)
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("unsafe workflow output parent")
    output = root / task
    if os.path.lexists(output):
        raise FileExistsError("workflow output already exists")
    return str(project), str(attachments), str(output)


HANDOFF = """
import array, os, socket
with socket.socket(fileno=%d) as control:
    control.settimeout(10)
    directory = os.open('/output', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        control.sendmsg([b'D'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [directory]))])
    finally:
        os.close(directory)
    if control.recv(2) != b'A':
        raise SystemExit(2)
"""


def receive_output(control):
    rights = array.array("i")
    data, ancillary, flags, _ = control.recvmsg(2, socket.CMSG_SPACE(rights.itemsize), socket.MSG_CMSG_CLOEXEC)
    try:
        for level, kind, raw in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                rights.frombytes(raw)
        if (flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or data != b"D" or len(rights) != 1
                or not stat.S_ISDIR(os.fstat(rights[0]).st_mode)):
            raise ValueError("invalid workflow output handoff")
        control.sendall(b"A")
        return rights.pop()
    finally:
        for fd in rights:
            os.close(fd)


def export_output(root, staging):
    remaining, entries = OUTPUT_BYTES, 0
    def walk(directory, prefix):
        nonlocal remaining, entries
        with os.scandir(directory) as children:
            for entry in children:
                entries += 1
                segments = parts("/".join((*prefix, entry.name)))
                if entries > OUTPUT_ENTRIES or len(segments) > 64:
                    raise ValueError("too many workflow outputs")
                with opened(entry.name, os.O_PATH, directory) as inode:
                    info = os.fstat(inode)
                    if info.st_dev != os.fstat(root).st_dev:
                        raise ValueError("unexpected output filesystem")
                    target = staging.joinpath(*segments)
                    if stat.S_ISDIR(info.st_mode):
                        target.mkdir(mode=0o700)
                        with open_directory_fd(inode) as child:
                            walk(child, segments)
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= remaining:
                        with open("/proc/self/fd/" + str(inode), "rb") as source, target.open("xb") as dest:
                            os.fchmod(dest.fileno(), 0o600)
                            while chunk := source.read(min(65536, info.st_size - dest.tell() + 1)):
                                if dest.tell() + len(chunk) > info.st_size:
                                    raise ValueError("workflow output grew during export")
                                dest.write(chunk)
                            if dest.tell() != info.st_size or os.fstat(inode).st_ctime_ns != info.st_ctime_ns:
                                raise ValueError("workflow output changed")
                        remaining -= info.st_size
                    else:
                        raise ValueError("invalid workflow output file")
    walk(root, ())


@contextlib.contextmanager
def open_directory_fd(inode):
    fd = os.open("/proc/self/fd/" + str(inode), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def output_process(command, destination, **options):
    split = command.index("--")
    if command[split+1:split+4] != ["/usr/bin/python3", "-I", "-c"]:
        raise ValueError("unexpected workflow runner")
    destination = Path(destination)
    staging = destination.with_name(".pending-" + destination.name)
    staging.mkdir(mode=0o700)
    published = False
    try:
        if os.path.lexists(destination):
            raise FileExistsError("workflow output already exists")
        with contextlib.ExitStack() as lifetime:
            host, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            with host, child:
                host.settimeout(10)
                command = command.copy()
                command[split+4] = (HANDOFF % child.fileno()) + command[split+4]
                command[split:split] = ["--size", str(OUTPUT_BYTES), "--tmpfs", "/output"]
                pass_fds = (*options.pop("pass_fds", ()), child.fileno())
                process = subprocess.Popen(command, pass_fds=pass_fds, **options)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        lifetime.callback(stream.close)
                try:
                    child.close()
                    root = receive_output(host)
                    lifetime.callback(os.close, root)
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
            try:
                yield process
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
                export_output(root, staging)
                # Never replace a different launch's archive, including an empty directory.
                rename = ctypes.CDLL(None, use_errno=True).renameat2
                if rename(-100, os.fsencode(staging), -100, os.fsencode(destination), 1):
                    raise OSError(ctypes.get_errno(), "cannot publish workflow output")
                published = True
    finally:
        if not published:
            shutil.rmtree(staging)


def api_input(packet):
    if not isinstance(packet, dict) or set(packet) != {"prompt", "memory", "workflowFiles"}:
        raise ValueError("invalid workflow API packet")
    validate(packet["workflowFiles"])
    content = []
    for name, limit in (("prompt", 8192), ("memory", 24832)):
        text = packet[name]
        if text is None and name == "memory":
            continue
        if not isinstance(text, str) or not text.strip() or len(text) > limit or "\0" in text:
            raise ValueError("invalid workflow API input")
        content.append({"type": "text", "text": text})
    message = {"type": "user", "message": {"role": "user", "content": content}}
    frame = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
    if len(frame) > 65536:
        raise ValueError("invalid workflow API frame")
    return frame


def run_api(isolation, program, command, workspace, environment, task):
    # The privacy launcher has already verified the pinned egress. Keep the
    # API route's encrypted credential, validated executable, and gateway checks.
    if (command[:4] != ["claude", "-p", "--dsh-encrypted-credentials", "--dsh-api-chat-stdin"] or
            not isolation["dsh_api_storage_ready"](environment["HOME"])):
        raise ValueError("invalid workflow API isolation")
    args, session, turn, prompt, images, subscription, source = isolation["chat_args"](command[:2] + command[4:])
    if not session or turn or prompt or images or subscription or source or "--resume" in args:
        raise ValueError("invalid workflow API session")
    payload = sys.stdin.buffer.read(1280 * 1024 + 1)
    if len(payload) > 1280 * 1024:
        raise ValueError("invalid workflow API payload")
    packet = json.loads(payload)
    message = api_input(packet)
    executable, _, auth = isolation["validate_paths"](program, workspace, environment, provider="claude")
    root, _, _ = isolation["chat_paths"](environment["HOME"], session, None, "claude")
    with opened(root / "session.lock", os.O_RDWR | os.O_CREAT) as lock, tempfile.TemporaryDirectory(prefix="workflow-inputs-") as temporary, tempfile.TemporaryDirectory(prefix="claude-gate-") as gate:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError("invalid workflow API session lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        project, attachments, output = prepare(packet["workflowFiles"], workspace, environment["HOME"], task, temporary)
        with isolation["Gateway"](os.path.join(gate, "proxy.sock"), isolation["global_connection"], isolation["CLAUDE_HOSTS"]):
            command = isolation["sandbox_command"](executable, project, auth, gate, args[1:], uploads=attachments,
                provider="claude", read_only_workspace=True, claude_stdin=True)
            # The API emits its terminal reply on stdout. Forward it only after
            # archiving, retaining the extra byte used by the task capture limit.
            with tempfile.TemporaryFile() as incoming:
                incoming.write(message)
                incoming.seek(0)
                with output_process(command, output, stdin=incoming, stdout=subprocess.PIPE, close_fds=True,
                        env={"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"}) as result:
                    reply = result.stdout.read(262145)
                    while result.stdout.read(65536):
                        pass
                    result.wait()
            sys.stdout.buffer.write(reply)
            sys.stdout.buffer.flush()
    return result.returncode if result.returncode >= 0 else 128 - result.returncode
