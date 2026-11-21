#!/usr/bin/env python3
"""Stage selected chat attachments once, without interpreting their names.

The SSH stream contains a bounded JSON header followed by raw file bytes.
Only a fully written, fsynced manifest makes a turn usable by the sandbox.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

MAX_FILE = 5 * 1024 * 1024
MAX_TOTAL = 20 * 1024 * 1024
MAX_HEADER = 8192


def identity(value):
    parsed = str(uuid.UUID(value))
    if value != parsed:
        raise ValueError("invalid identifier")
    return parsed


def private_dir(parent, name, strict=False):
    path = parent / name
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
            info.st_mode & (0o077 if strict else 0o022)):
        raise ValueError("unsafe chat state directory")
    return path


def conversation_root(session, environment):
    session = identity(session)
    home = Path(environment.get("HOME", ""))
    if not home.is_absolute() or not home.is_dir() or home.stat().st_uid != os.getuid() or home.stat().st_mode & 0o022:
        raise ValueError("invalid home")
    root = home.resolve()
    root = private_dir(root, ".remote-ssh-chat", strict=True)
    return private_dir(root, session, strict=True)


def exact(stream, count):
    result = bytearray()
    while len(result) < count:
        part = stream.read(min(count - len(result), 65536))
        if not part:
            raise ValueError("incomplete attachment stream")
        result.extend(part)
    return bytes(result)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def stage(session, turn, stream, environment):
    session, turn = identity(session), identity(turn)
    length = int.from_bytes(exact(stream, 4), "big")
    if length < 1 or length > MAX_HEADER:
        raise ValueError("invalid header length")
    header = json.loads(exact(stream, length).decode("utf-8"))
    files = header.get("files") if isinstance(header, dict) and set(header) == {"files"} else None
    if not isinstance(files, list) or not 1 <= len(files) <= 4:
        raise ValueError("invalid attachment list")
    total = 0
    for index, item in enumerate(files, 1):
        if not isinstance(item, dict) or set(item) != {"name", "size", "sha256"}:
            raise ValueError("invalid attachment metadata")
        name, size, digest = item["name"], item["size"], item["sha256"]
        if (not isinstance(name, str) or not re.fullmatch(r"f" + str(index) + r"(?:\.[a-z0-9]{1,10})?", name) or
                type(size) is not int or not 0 <= size <= MAX_FILE or
                not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
            raise ValueError("invalid attachment metadata")
        total += size
    if total > MAX_TOTAL:
        raise ValueError("attachments too large")
    root = conversation_root(session, environment)
    uploads = private_dir(root, "uploads", strict=True)
    destination = uploads / turn
    # A repeated or uncertain upload is never overwritten or silently reused.
    destination.mkdir(mode=0o700)
    sync_dir(uploads)
    for item in files:
        fd = os.open(destination / item["name"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        hasher = hashlib.sha256()
        with os.fdopen(fd, "wb") as output:
            remaining = item["size"]
            while remaining:
                part = exact(stream, min(remaining, 65536))
                output.write(part); hasher.update(part); remaining -= len(part)
            output.flush(); os.fsync(output.fileno())
        if hasher.hexdigest() != item["sha256"]:
            raise ValueError("attachment hash mismatch")
    if stream.read(1):
        raise ValueError("unexpected trailing data")
    fd = os.open(destination / "ready.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(header, output, separators=(",", ":")); output.flush(); os.fsync(output.fileno())
    sync_dir(destination)
    return {"session": session, "turn": turn, "files": files, "outcome": "staged"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--turn", required=True)
    args = parser.parse_args()
    try:
        result = stage(args.session, args.turn, sys.stdin.buffer, os.environ)
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        print(json.dumps({"outcome": "not_confirmed"}), flush=True)
        return 2
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
