"""Shared native CLI profiles with the existing egress and namespace boundary."""

def native_profile(home, provider):
    base = Path(os.path.realpath(home))
    info = base.stat()
    if not os.path.isabs(home) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError()
    state = chat_directory(chat_directory(base, ".remote-ssh-chat", True), "native-" + provider, True)
    native_home = chat_directory(state, "home", True)
    chat_directory(native_home, "." + provider, True)
    profile = base / ("." + provider)
    info = profile.lstat()
    if not native_directory_safe(profile, info):
        raise ValueError()
    check_workspace(str(profile))
    return state, native_home, profile


def native_lock(root):
    fd = os.open(root / "session.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock = os.fdopen(fd, "r+b")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError()
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock
    except BaseException:
        lock.close()
        raise


def run(program, command, workspace, environment, _connector=None, _auth_path=None, _argv_override=None):
    provider = os.path.basename(command[0]) if command else ""
    if provider not in ("codex", "claude") or command[1:2] != (["exec"] if provider == "codex" else ["-p"]):
        print("原生会话仅支持指定的非交互模型程序。", file=sys.stderr)
        return 2
    try:
        for path in ("/usr/bin/bwrap", "/usr/bin/python3"):
            if not os.path.isfile(path) or not os.access(path, os.X_OK): raise ValueError()
        command, session, turn, prompt, images, subscription, source = chat_args(command)
        if session is None or source is not None or (provider == "claude") != subscription:
            raise ValueError()
        if (provider == "claude" and prompt is None) or (provider == "codex" and (prompt is not None or images)):
            raise ValueError()
        executable, work, _ = validate_paths(program, workspace, environment, _auth_path, provider, subscription)
        root, _, uploads = chat_paths(environment["HOME"], session, turn, provider)
        _, home, profile = native_profile(environment["HOME"], provider)
        if provider == "claude":
            info = (profile / ".credentials.json").lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
                raise ValueError()
        with native_lock(root) as lease:
            argv = _argv_override if _argv_override is not None else command[1:]
            with tempfile.TemporaryDirectory(prefix="codex-gate-") as directory:
                allowed = ALLOWED_HOSTS if provider == "codex" else CLAUDE_SUBSCRIPTION_HOSTS
                with Gateway(os.path.join(directory, "proxy.sock"), _connector or global_connection, allowed):
                    start = sandbox_command(executable, work, None, directory, argv, str(profile), uploads,
                                            provider, prompt, images, str(home) if subscription else None, subscription)
                    fd = lease.fileno(); start[1:1] = ["--sync-fd", str(fd)]
                    result = subprocess.run(start, stdin=subprocess.DEVNULL, close_fds=True, pass_fds=(fd,),
                                            env={"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"})
        return result.returncode if result.returncode >= 0 else 128 - result.returncode
    except BlockingIOError:
        print("原生会话正忙；本任务未启动模型。", file=sys.stderr)
        return 2
    except (OSError, ValueError, subprocess.SubprocessError):
        print("原生会话的隔离环境无法建立；未以普通模式启动。", file=sys.stderr)
        return 2
