#!/usr/bin/env python3
"""Prepare one private Claude profile and check native status without exporting it."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import resource
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid


def private_dir(parent, name):
    path = parent / name
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("unsafe profile")
    return path


def session_root(session, environment):
    if str(uuid.UUID(session)) != session or os.getuid() == 0:
        raise ValueError("invalid session")
    home = Path(environment.get("HOME", ""))
    if not home.is_absolute() or not home.is_dir() or home.stat().st_uid != os.getuid() or home.stat().st_mode & 0o022:
        raise ValueError("invalid home")
    return private_dir(private_dir(home.resolve(), ".remote-ssh-chat"), session)


def prepare(session, environment):
    root = session_root(session, environment)
    native = private_dir(root, "native-home")
    private_dir(native, ".claude")
    config = private_dir(root, "claude-home")
    return root, native, config


def prepare_native(session, environment):
    root = session_root(session, environment)
    base = Path(environment["HOME"]).resolve()
    account = private_dir(private_dir(base, ".remote-ssh-chat"), "native-claude")
    native = private_dir(account, "home")
    private_dir(native, ".claude")
    config = base / ".claude"
    try: config.mkdir(mode=0o700)
    except FileExistsError: pass
    info = config.lstat()
    if "native_directory_safe" not in globals() or not native_directory_safe(config, info):
        raise ValueError("unsafe native profile")
    return root, native, config, account


def native_executable(environment):
    path = shutil.which("claude", path=environment.get("PATH", ""))
    if path is None:
        path = os.path.join(environment.get("HOME", ""), ".local", "bin", "claude")
    path = os.path.realpath(path)
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & (stat.S_ISUID | stat.S_ISGID) or not os.access(path, os.X_OK):
        raise ValueError("invalid native executable")
    with open(path, "rb") as stream:
        if stream.read(4) != b"\x7fELF":
            raise ValueError("native executable required")
    return path


def check_profile(path):
    root = str(path)
    with open("/proc/self/mountinfo", "r", encoding="utf-8") as mounts:
        for line in mounts:
            fields = line.split()
            if len(fields) < 5:
                raise ValueError("invalid mount information")
            point = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
            if point != root and os.path.commonpath((point, root)) == root:
                raise ValueError("profile has nested mounts")
    pending, count = [root], 0
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                count += 1
                if count > 200000:
                    raise ValueError("profile inspection limit exceeded")
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISSOCK(info.st_mode) or stat.S_ISFIFO(info.st_mode) or stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode):
                    raise ValueError("profile contains IPC or device endpoint")
                if stat.S_ISDIR(info.st_mode):
                    pending.append(entry.path)


def status(session, environment, source=None, use_native=False):
    if use_native and source is not None:
        raise ValueError("native profile has no source")
    if use_native:
        root, native, config, account = prepare_native(session, environment)
    else:
        root, native, config = prepare(session, environment)
    check_profile(native); check_profile(config)
    try:
        executable = native_executable(environment)
    except FileNotFoundError:
        return "cli_missing"
    except ValueError:
        return "cli_unsupported"
    if source is not None and ("shared_root" not in globals() or shared_id(source) == session):
        raise ValueError("invalid shared source")
    guard_root = guard_id = shared_config = None
    overlays = []
    with contextlib.ExitStack() as locks:
        if source is not None:
            try:
                guard_root, guard_id = shared_root(environment["HOME"], source), source
                locks.enter_context(shared_lock(guard_root))
            except BlockingIOError:
                return "busy"
            except (OSError, ValueError):
                return "shared_profile_changed"
        fd = os.open(root / "session.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        lock = locks.enter_context(os.fdopen(fd, "r+b"))
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("invalid session lock")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return "busy"
        if source is None and os.path.lexists(root / ".shared-account-v1.json"):
            if "shared_verify" not in globals():
                return "shared_profile_changed"
            guard_root, guard_id = root, session
        if guard_root is not None:
            try:
                source_config, entries = shared_verify(guard_root, guard_id, create=source is not None)
                check_profile(source_config)
                if source is not None:
                    overlays = shared_overlays(source_config, entries, config)
                    check_profile(config)
                    shared_config = source_config
            except (OSError, ValueError):
                return "shared_profile_changed"
        command = ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
                   "--uid", "1000", "--gid", "1000", "--cap-drop", "ALL", "--new-session", "--die-with-parent",
                   "--dir", "/usr", "--ro-bind", "/usr/bin", "/usr/bin", "--ro-bind", "/usr/sbin", "/usr/sbin",
                   "--ro-bind", "/usr/lib", "/usr/lib", "--ro-bind-try", "/usr/lib64", "/usr/lib64",
                   "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
                   "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
                   "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home",
                   "--dir", "/home/codex", "--ro-bind", str(native), "/home/codex",
                   "--ro-bind", str(shared_config or config), "/home/codex/.claude"]
        for origin, target in overlays:
            command += ["--ro-bind", origin, target]
        command += ["--dir", "/opt", "--ro-bind", executable, "/opt/claude",
                   "--clearenv", "--setenv", "HOME", "/home/codex", "--setenv", "CLAUDE_CONFIG_DIR", "/home/codex/.claude",
                   "--setenv", "PATH", "/usr/bin:/usr/sbin:/bin", "--setenv", "LANG", "C.UTF-8", "--setenv", "TERM", "dumb",
                   "--setenv", "USER", "codex", "--setenv", "LOGNAME", "codex", "--chdir", "/tmp", "--", "/opt/claude", "auth", "status", "--json"]
        # The native CLI may print account metadata: capture it locally and only
        # return an enum. The read-only, networkless sandbox cannot refresh tokens.
        def limit_output():
            resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                                    env={"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8"},
                                    close_fds=True, timeout=15, preexec_fn=limit_output)
            output.seek(0)
            value = json.loads(output.read(65537))
        if guard_root is not None:
            try: shared_verify(guard_root, guard_id)
            except (OSError, ValueError): return "shared_profile_changed"
        if not isinstance(value, dict) or type(value.get("loggedIn")) is not bool:
            return "unavailable"
        if "configDirectory" in value and value["configDirectory"] != "/home/codex/.claude":
            return "wrong_profile"
        if not value["loggedIn"] and result.returncode == 1:
            return "not_logged_in"
        if result.returncode == 0 and value["loggedIn"]:
            if value.get("authMethod") == "claude.ai":
                return "ready"
            if value.get("authMethod") in ("api_key", "api_key_helper", "oauth_token", "third_party"):
                return "wrong_auth"
        return "unavailable"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--source")
    parser.add_argument("--native", action="store_true")
    args = parser.parse_args()
    try:
        state = status(args.session, os.environ, args.source, args.native)
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError, subprocess.SubprocessError):
        state = "unavailable"
    print(json.dumps({"session": args.session, "status": state}, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
