"""Open a private account display and carry its framebuffer over SSH."""
import contextlib
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time


FIREFOX = "/snap/bin/firefox"
XTERM = "/usr/bin/xterm"
BROWSER_URLS = {
    "chatgpt-account": "https://chatgpt.com/#settings/Account",
    "claude-account": "https://claude.ai/settings/account",
    "claude-console": "https://platform.claude.com/settings/keys",
    "google-account": "https://myaccount.google.com/",
}
TERMINAL_ACTIONS = {
    "codex-login": "Codex CLI login",
    "claude-login": "Claude Code subscription login",
    "claude-api-key": "Claude API key on the VPS",
    "antigravity-login": "Antigravity CLI login",
}
OAUTH_ENDPOINTS = {
    "claude-login": (
        ("claude.com", "/cai/oauth/authorize"),
        ("claude.ai", "/oauth/authorize"),
        ("platform.claude.com", "/oauth/authorize"),
        ("console.anthropic.com", "/oauth/authorize"),
    ),
    "codex-login": (
        ("auth.openai.com", "/oauth/authorize"),
        ("auth.openai.com", "/api/accounts/authorize"),
    ),
    "antigravity-login": (
        ("accounts.google.com", "/o/oauth2/v2/auth"),
        ("accounts.google.com", "/o/oauth2/auth"),
    ),
}
CLIPBOARD_LIMIT = 8192
CHECK_URLS = {
    4: ("https://api.ipify.org/", "https://ipv4.icanhazip.com/"),
    6: ("https://api64.ipify.org/", "https://ipv6.icanhazip.com/"),
}


class AccountStartupError(RuntimeError):
    """Report a fixed startup reason without exposing remote diagnostics."""


KEY_WRITER = r"""
import fcntl
import getpass
import os
import re
import secrets
import stat
import sys
import warnings

def key_snapshot(directory, name):
    try:
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
        info.st_mode & 0o077 or info.st_nlink != 1):
        raise ValueError()
    return info.st_dev, info.st_ino, info.st_ctime_ns

def store(directory):
    name = "anthropic-api-key"
    fd = os.open(directory, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW)
    temporary = None
    lock = None
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError()
        lock = os.open(".account-key.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        lock_info = os.fstat(lock)
        if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid() or
            lock_info.st_mode & 0o077 or lock_info.st_nlink != 1):
            raise ValueError()
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = key_snapshot(fd, name)
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise ValueError()
        warnings.simplefilter("error", getpass.GetPassWarning)
        key = getpass.getpass("Claude API key (hidden): ")
        if not re.fullmatch(r"sk-ant-[A-Za-z0-9_-]{20,240}", key) or key.startswith("sk-ant-admin"):
            print("The API key format is not supported.")
            return
        action = "replace the current VPS key" if previous is not None else "save the VPS key"
        if input(f"Type SAVE to {action}: ") != "SAVE":
            print("Cancelled.")
            return
        temporary = ".account-key-" + secrets.token_hex(12)
        staged = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(staged, "w", encoding="ascii") as stream:
            stream.write(key + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        if key_snapshot(fd, name) != previous:
            print("The VPS key changed while this prompt was open. Reopen the window and review.")
            return
        os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        temporary = None
        try:
            os.fsync(fd)
        except OSError:
            print("API key installed on the VPS. Disk sync could not be confirmed.")
            return
        print("API key saved on the VPS.")
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=fd)
        if lock is not None:
            os.close(lock)
        os.close(fd)

try:
    store(sys.argv[1])
except (OSError, ValueError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
    print("The VPS key could not be saved.")
    raise SystemExit(1)
"""


def owned_directory(parent, name):
    directory = parent / name
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
        info.st_mode & 0o022 or info.st_dev != parent.stat().st_dev):
        raise RuntimeError("unsafe account profile")
    return directory


def claude_login_lock(home, resources):
    profile = owned_directory(owned_directory(home, ".remote-ssh-chat"), "native-claude")
    lock = os.fdopen(os.open(profile / "session.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "r+b")
    resources.enter_context(lock)
    info = os.fstat(lock.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise RuntimeError("unsafe Claude lock")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


def oauth_opener(action, home, profile):
    # A CLI can use BROWSER or xdg-open. Restrict both to the advisory login link
    # for that CLI and to the Firefox profile created for this view.
    return f"""#!/usr/bin/python3 -I
import os
import subprocess
import sys
from urllib.parse import urlsplit

endpoints = {OAUTH_ENDPOINTS[action]!r}
if len(sys.argv) != 2 or not sys.argv[1].isascii() or len(sys.argv[1]) > {CLIPBOARD_LIMIT}:
    raise SystemExit("Open the login link directly in the VPS browser.")
url = sys.argv[1]
if any(ord(char) < 33 or ord(char) == 127 for char in url):
    raise SystemExit("Open the login link directly in the VPS browser.")
try:
    target = urlsplit(url)
except ValueError:
    raise SystemExit("Unrecognized login link.") from None
if target.scheme != "https" or (target.netloc.lower(), target.path) not in endpoints or not target.query:
    raise SystemExit("Open the login link directly in the VPS browser.")
env = {{name: os.environ[name] for name in ("DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG") if name in os.environ}}
env.update(HOME={str(home)!r}, PATH="/usr/bin:/bin:/snap/bin")
try:
    result = subprocess.run([{FIREFOX!r}, "--profile", {str(profile)!r}, "--new-tab", url], env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=6)
except (OSError, subprocess.TimeoutExpired):
    raise SystemExit("Could not open the VPS browser. Copy the link from the terminal.") from None
if result.returncode:
    raise SystemExit("Could not open the VPS browser. Copy the link from the terminal.")
"""


def terminal_plan(action, home, directory, env, resources):
    if not os.access(XTERM, os.X_OK):
        raise AccountStartupError("account_terminal_missing")
    env = {**env, "PATH": str(home / ".local" / "bin") + ":/usr/local/bin:/usr/bin:/bin:/snap/bin"}
    if action == "claude-api-key":
        target = owned_directory(owned_directory(home, ".config"), "remote-ssh")
        return [sys.executable, "-I", "-c", KEY_WRITER, str(target)], env

    opener = directory / "xdg-open"
    opener.write_text(oauth_opener(action, home, directory / "profile"), encoding="utf-8")
    opener.chmod(0o700)
    env = {**env, "BROWSER": str(opener), "PATH": str(directory) + ":" + env["PATH"]}
    if action == "codex-login":
        name = "codex"
        argv = ["-c", 'cli_auth_credentials_store="file"', "login"]
        env["CODEX_HOME"] = str(owned_directory(home, ".codex"))
    elif action == "claude-login":
        name = "claude"
        argv = ["auth", "login"]
        claude_login_lock(home, resources)
        env["CLAUDE_CONFIG_DIR"] = str(owned_directory(home, ".claude"))
    else:
        name = "agy"
        argv = []
        env["HOME"] = str(owned_directory(owned_directory(home, ".dsh-antigravity"), "home"))

    program = shutil.which(name, path=env["PATH"])
    if not program or not Path(program).is_absolute():
        raise AccountStartupError("account_cli_missing")
    return [program, *argv], env


def run_output(args, env, timeout=8):
    return subprocess.check_output(args, env=env, timeout=timeout, stderr=subprocess.DEVNULL).strip()


def check_egress(expected4, expected6, env):
    for expected in (expected4, expected6):
        if expected is None:
            if run_output(["/usr/sbin/ip", "-6", "route", "show", "default"], env):
                raise RuntimeError("IPv6 egress is not pinned")
            continue
        for endpoint in CHECK_URLS[expected.version]:
            measured = run_output([
                "/usr/bin/curl", "-q", "--noproxy", "*", "--silent", "--show-error",
                "--fail", "--max-time", "5", "--proto", "=https", "-" + str(expected.version),
                endpoint,
            ], env)
            if ipaddress.ip_address(measured.decode("ascii")) != expected:
                raise RuntimeError("VPS egress mismatch")


def wait_for_display(process, socket_path):
    deadline = time.monotonic() + 5
    while not socket_path.is_socket():
        if process.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError("Private display did not start")
        time.sleep(0.04)


def wait_for_window(process, env, pattern):
    deadline = time.monotonic() + 14
    while time.monotonic() < deadline and process.poll() is None:
        windows = run_output(["/usr/bin/xwininfo", "-root", "-tree"], env, timeout=2)
        if re.search(pattern, windows, re.IGNORECASE):
            return
        time.sleep(0.2)
    raise RuntimeError("private window did not open")


def stop_process(process):
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2)


def relay(channel, browser):
    def disconnect():
        with contextlib.suppress(OSError):
            channel.shutdown(socket.SHUT_RDWR)

    def input_to_display():
        with contextlib.suppress(OSError):
            while data := sys.stdin.buffer.read1(65536):
                channel.sendall(data)
        disconnect()

    def monitor_browser():
        browser.wait()
        disconnect()

    threading.Thread(target=input_to_display, daemon=True).start()
    threading.Thread(target=monitor_browser, daemon=True).start()
    while data := channel.recv(65536):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def open_browser(directory, home, env, ipv6_allowed, action):
    authority = directory / "xauthority"
    display = ":" + str(300 + secrets.randbelow(600))
    rfb = directory / "rfb"
    profile = directory / "profile"
    profile.mkdir(mode=0o700)
    downloads = owned_directory(profile, "downloads")
    authority.touch(mode=0o600)
    run_output(["/usr/bin/xauth", "-f", str(authority), "add", display,
                "MIT-MAGIC-COOKIE-1", secrets.token_hex(16)], env)
    env = {**env, "DISPLAY": display, "XAUTHORITY": str(authority)}
    (profile / "user.js").write_text(
        'user_pref("network.proxy.type", 0);\n'
        'user_pref("network.trr.mode", 5);\n'
        'user_pref("media.peerconnection.enabled", false);\n'
        'user_pref("browser.shell.checkDefaultBrowser", false);\n'
        'user_pref("signon.rememberSignons", false);\n'
        'user_pref("browser.cache.disk.enable", false);\n'
        'user_pref("browser.sessionstore.resume_from_crash", false);\n'
        'user_pref("browser.download.folderList", 2);\n'
        f'user_pref("browser.download.dir", {json.dumps(str(downloads))});\n'
        'user_pref("browser.download.useDownloadDir", true);\n'
        'user_pref("browser.download.start_downloads_in_tmp_dir", false);\n'
        'user_pref("browser.widget.use-xdg-desktop-portal.file-picker", 0);\n'
        'user_pref("network.dns.disableIPv6", ' + ("false" if ipv6_allowed else "true") + ');\n',
        encoding="utf-8",
    )
    child_options = {
        "env": env, "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL, "start_new_session": True,
    }
    with contextlib.ExitStack() as resources:
        interactive = action in TERMINAL_ACTIONS
        clipboard = action in OAUTH_ENDPOINTS
        if interactive:
            argv, terminal_env = terminal_plan(action, home, directory, env, resources)
            page = BROWSER_URLS["claude-console"] if action == "claude-api-key" else "about:blank"
        else:
            page = BROWSER_URLS[action]
        vnc = subprocess.Popen([
            "/usr/bin/Xtigervnc", display, "-auth", str(authority), "-nolisten", "tcp",
            "-rfbport", "-1", "-rfbunixpath", str(rfb), "-rfbunixmode", "0600",
            "-SecurityTypes", "None", "-desktop", "DSH VPS account", "-geometry", "1366x900",
            "-depth", "24", f"-AcceptCutText={int(clipboard)}", f"-SendCutText={int(clipboard)}",
            "-SendPrimary=0", "-SetPrimary=0", f"-MaxCutText={CLIPBOARD_LIMIT}", "-AcceptSetDesktopSize=0",
            "-AllowOverride=",
        ], **child_options)
        resources.callback(stop_process, vnc)
        wait_for_display(vnc, rfb)
        browser_env = {**env, "MOZ_CRASHREPORTER_DISABLE": "1"}
        browser_mode = "--new-instance" if clipboard else "--no-remote"
        browser = subprocess.Popen([FIREFOX, browser_mode, "--profile", str(profile),
                                    "--width", "1366", "--height", "900", page],
                                   **{**child_options, "env": browser_env})
        resources.callback(stop_process, browser)
        wait_for_window(browser, env, rb'"navigator" "firefox(?:_firefox)?"')
        if clipboard:
            clipboard_helper = shutil.which("tigervncconfig", path=env["PATH"]) or shutil.which("vncconfig", path=env["PATH"])
            if clipboard_helper:
                bridge = subprocess.Popen([clipboard_helper, "-nowin"], **child_options)
                resources.callback(stop_process, bridge)
        if interactive:
            terminal = subprocess.Popen([
                XTERM, "-title", TERMINAL_ACTIONS[action], "-geometry", "126x15+0-0",
                "-xrm", "XTerm*selectToClipboard: true",
                "-xrm", "XTerm*VT100.translations: #override Shift <Key>Insert: insert-selection(CLIPBOARD)",
                "-hold", "-e", *argv,
            ], cwd=owned_directory(directory, "auth-work"),
               **{**child_options, "env": {**terminal_env, "DISPLAY": display, "XAUTHORITY": str(authority)}})
            resources.callback(stop_process, terminal)
            wait_for_window(terminal, env, rb'"xterm" "xterm"')
        with socket.socket(socket.AF_UNIX) as channel:
            channel.connect(str(rfb))
            relay(channel, browser)


def encrypted_browser_root(home):
    if not home.is_absolute() or home.resolve() != home or home.stat().st_uid != os.getuid():
        raise RuntimeError("invalid encrypted home")
    device = home.stat().st_dev
    identifier = Path("/sys/dev/block") / f"{os.major(device)}:{os.minor(device)}" / "dm" / "uuid"
    try:
        with identifier.open("r", encoding="ascii") as stream:
            if re.fullmatch(r"CRYPT-LUKS2-[0-9a-fA-F]{32}-[^\s]{1,128}", stream.read(256).strip()) is None:
                return None
    except FileNotFoundError:
        return None
    root = home / "snap" / "firefox" / "common"
    if root.resolve() != root:
        raise RuntimeError("invalid Firefox profile path")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    stat = root.stat()
    if stat.st_dev != device or stat.st_uid != os.getuid():
        raise RuntimeError("Firefox profile is outside the encrypted home")
    return root


def runtime_browser_root(runtime, env):
    """Keep a temporary web-only profile in Firefox's private runtime directory."""
    info = runtime.lstat()
    if (runtime.resolve() != runtime or not stat.S_ISDIR(info.st_mode) or
        info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise RuntimeError("unsafe runtime directory")
    mount = run_output(["/usr/bin/findmnt", "--noheadings", "--target", str(runtime),
                        "--output", "FSTYPE,OPTIONS"], env).split()
    if len(mount) != 2 or mount[0] != b"tmpfs":
        raise RuntimeError("runtime directory is not on tmpfs")
    if b"noswap" not in mount[1].split(b",") and len(Path("/proc/swaps").read_bytes().splitlines()) != 1:
        raise RuntimeError("runtime directory can be swapped")
    root = owned_directory(runtime, "snap.firefox")
    if root.stat().st_mode & 0o077:
        raise RuntimeError("Firefox runtime directory is not private")
    return root


def account_browser_root(home, runtime, action, env):
    encrypted = encrypted_browser_root(home)
    if encrypted is not None:
        return encrypted
    if action in TERMINAL_ACTIONS:
        raise AccountStartupError("account_encrypted_home_required")
    try:
        return runtime_browser_root(runtime, env)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        raise AccountStartupError("account_browser_storage_unavailable") from None


def main():
    expected4 = ipaddress.IPv4Address(sys.argv[1])
    ipv6 = sys.argv[2] if len(sys.argv) >= 3 else "-"
    expected6 = ipaddress.IPv6Address(ipv6) if ipv6 != "-" else None
    action = sys.argv[3] if len(sys.argv) == 4 else "claude-account"
    if len(sys.argv) > 4 or (action not in BROWSER_URLS and action not in TERMINAL_ACTIONS):
        raise RuntimeError("invalid account action")
    os.umask(0o077)
    home = Path.home()
    env = {"PATH": "/usr/bin:/bin:/snap/bin", "HOME": str(home), "LANG": "C.UTF-8"}
    runtime = Path("/run/user") / str(os.getuid())
    if runtime.is_dir():
        env["XDG_RUNTIME_DIR"] = str(runtime)
        bus = runtime / "bus"
        if bus.is_socket() and bus.stat().st_uid == os.getuid():
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"
    root = account_browser_root(home, runtime, action, env)
    try:
        check_egress(expected4, expected6, env)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        raise AccountStartupError("account_egress_unverified") from None
    with tempfile.TemporaryDirectory(prefix="dsh-account-", dir=root) as session:
        open_browser(Path(session), home, env, expected6 is not None, action)


def stop_session(_number, _frame):
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop_session)
    signal.signal(signal.SIGHUP, stop_session)
    try:
        main()
    except AccountStartupError as error:
        sys.stderr.write(f"DSH_ACCOUNT_ERROR {error}\n")
        raise SystemExit(1)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, IndexError):
        sys.stderr.write("DSH_ACCOUNT_BROWSER_UNAVAILABLE\n")
        raise SystemExit(1)
