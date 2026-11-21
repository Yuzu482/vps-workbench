"""Fail-closed shared Claude profile layout; never reads credential contents."""
import fcntl
import json
import os
from pathlib import Path
import stat
import uuid

SHARED_POLICY = ".shared-account-v1.json"


class SharedProfileError(ValueError):
    pass


def shared_id(value):
    if str(uuid.UUID(value)) != value:
        raise SharedProfileError("invalid identifier")
    return value


def shared_dir(parent, name, create=False):
    path = Path(parent) / name
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SharedProfileError("unsafe shared directory")
    return path


def shared_root(home, source):
    base = Path(os.path.realpath(home))
    info = base.stat()
    if not os.path.isabs(home) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise SharedProfileError("unsafe home")
    return shared_dir(shared_dir(base, ".remote-ssh-chat"), shared_id(source))


def shared_lock(root):
    fd = os.open(Path(root) / "session.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock = os.fdopen(fd, "r+b")
    info = os.fstat(lock.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        lock.close()
        raise SharedProfileError("unsafe shared lock")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        lock.close()
        raise
    return lock


def shared_snapshot(root):
    config = shared_dir(root, "claude-home")
    credential = (config / ".credentials.json").lstat()
    if (not stat.S_ISREG(credential.st_mode) or credential.st_uid != os.getuid() or credential.st_mode & 0o077 or
            credential.st_nlink != 1 or not 0 < credential.st_size <= 1024 * 1024):
        raise SharedProfileError("unsafe credential file")
    entries = []
    with os.scandir(config) as items:
        for item in items:
            if item.name == ".credentials.json":
                continue
            if len(entries) >= 128 or len(item.name.encode("utf-8")) > 255 or any(ord(c) < 32 or ord(c) == 127 for c in item.name):
                raise SharedProfileError("invalid shared entry")
            info = item.stat(follow_symlinks=False)
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise SharedProfileError("unsafe shared entry")
            if stat.S_ISDIR(info.st_mode):
                kind = "dir"
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                kind = "file"
            else:
                raise SharedProfileError("unsupported shared entry")
            entries.append([item.name, kind])
    return config, sorted(entries)


def shared_verify(root, source, create=False):
    source = shared_id(source)
    config, entries = shared_snapshot(root)
    policy = Path(root) / SHARED_POLICY
    expected = {"version": 1, "source": source, "entries": entries}
    if not os.path.lexists(policy):
        if not create:
            raise SharedProfileError("shared policy missing")
        payload = json.dumps(expected, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        fd = os.open(policy, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload); stream.flush(); os.fsync(stream.fileno())
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    fd = os.open(policy, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno()); data = stream.read(65537)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or
            info.st_nlink != 1 or len(data) > 65536):
        raise SharedProfileError("unsafe shared policy")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise SharedProfileError("duplicate policy field")
            result[key] = value
        return result
    if json.loads(data, object_pairs_hook=unique) != expected:
        raise SharedProfileError("shared profile changed")
    return config, entries


def shared_overlays(config, entries, child):
    child = Path(child)
    info = child.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SharedProfileError("unsafe conversation directory")
    if os.path.lexists(child / ".credentials.json"):
        raise SharedProfileError("conversation already has its own credential")
    result = []
    for name, kind in entries:
        target = child / name
        if kind == "dir":
            try: target.mkdir(mode=0o700)
            except FileExistsError: pass
        elif not os.path.lexists(target):
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        info = target.lstat()
        if (info.st_uid != os.getuid() or info.st_mode & 0o077 or
            (kind == "dir" and not stat.S_ISDIR(info.st_mode)) or
            (kind == "file" and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1))):
            raise SharedProfileError("unsafe conversation overlay")
        result.append((str(target), "/home/codex/.claude/" + name))
    return result
