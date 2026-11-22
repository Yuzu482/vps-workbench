"""Install locked official Linux runtimes without invoking a package install script."""

import base64
from collections import deque
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


PROVIDERS = {"codex": "codex", "claude": "claude", "claude-sdk": "claude", "antigravity": "agy"}
ELF_MACHINES = {"x64": 62, "arm64": 183}
CODEX_TARGET = {"x64": "x86_64-unknown-linux-musl", "arm64": "aarch64-unknown-linux-musl"}
SDK_PATH = Path("node_modules/@anthropic-ai/claude-agent-sdk")
MAX_DOWNLOAD = 512 * 1024**2
MAX_ARCHIVE = 2 * 1024**3
CHUNK = 1024**2


class SetupError(ValueError):
    """An installation or prerequisite status suitable for printing."""


def private_dir(path, *, shared_read=False, create=False):
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
            info.st_mode & (0o022 if shared_read else 0o077) or path.resolve(strict=True) != path):
        raise SetupError("unsafe_directory")
    return path


@contextmanager
def install_lock(path):
    import fcntl

    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or
                info.st_mode & 0o077):
            raise SetupError("unsafe_install_lock")
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SetupError("install_busy") from error
        yield


def publish_directory(candidate, target):
    # Directory rename with RENAME_NOREPLACE avoids overwriting an external install.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(candidate), -100, os.fsencode(target), 1) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def trusted_location(path):
    if not path.is_absolute():
        raise SetupError("relative_runtime_path")
    owners = {0, os.getuid()}
    resolved = Path("/")
    pending = deque(path.parts[1:])
    links = 0
    while pending:
        part = pending.popleft()
        if part == "..":
            resolved = resolved.parent
            continue
        if part == ".":
            continue
        candidate = resolved / part
        info = candidate.lstat()
        if info.st_uid not in owners:
            raise SetupError("untrusted_runtime_path")
        if stat.S_ISLNK(info.st_mode):
            links += 1
            if links > 32:
                raise SetupError("untrusted_runtime_path")
            target = candidate.readlink()
            if target.is_absolute():
                resolved = Path("/")
            parts = target.parts[1:] if target.is_absolute() else target.parts
            pending.extendleft(reversed(parts))
            continue
        if info.st_mode & 0o022 and (not stat.S_ISDIR(info.st_mode) or not info.st_mode & stat.S_ISVTX):
            raise SetupError("untrusted_runtime_path")
        resolved = candidate
    return resolved


def binary_path(path, architecture):
    try:
        resolved = trusted_location(Path(path))
        info = resolved.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or
                info.st_mode & 0o6022 or not os.access(resolved, os.X_OK)):
            return None
        with resolved.open("rb") as stream:
            header = stream.read(20)
        if (header[:7] == b"\x7fELF\x02\x01\x01" and
                int.from_bytes(header[18:20], "little") == ELF_MACHINES[architecture]):
            return resolved
    except (OSError, SetupError):
        pass
    return None


def find_binary(name, home, architecture, path):
    found = shutil.which(name, path=path)
    return binary_path(found or home / ".local/bin" / name, architecture)


def selected_artifact(catalog, name, arch):
    item = catalog[name]
    spec = item["all"] if "all" in item else item[arch]
    if not re.fullmatch(r"\d+\.\d+\.\d+", item["version"]):
        raise SetupError("invalid_runtime_catalog")
    return spec


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise SetupError("artifact_redirect_refused")


def download(spec, target, offline):
    url = urlsplit(spec["url"])
    sources = {"registry.npmjs.org": ("/@openai/codex/-/", "/@anthropic-ai/"),
               "nodejs.org": ("/dist/",), "storage.googleapis.com": ("/antigravity-public/antigravity-cli/",)}
    if (url.scheme != "https" or url.netloc not in sources or url.query or url.fragment or
            not url.path.startswith(sources[url.netloc])):
        raise SetupError("invalid_runtime_catalog")
    filename = PurePosixPath(url.path).name
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.(?:tgz|tar\.gz|tar\.xz)", filename):
        raise SetupError("invalid_runtime_catalog")
    algorithm, _, expected = spec["integrity"].partition("-")
    if algorithm == "sha512" and re.fullmatch(r"[A-Za-z0-9+/]{86}==", expected):
        expected = base64.b64decode(expected, validate=True).hex()
    lengths = {"sha256": 64, "sha512": 128}
    if algorithm not in lengths or not re.fullmatch(r"[a-f0-9]{" + str(lengths[algorithm]) + r"}", expected):
        raise SetupError("invalid_runtime_catalog")
    digest = hashlib.new(algorithm)
    total = 0
    deadline = time.monotonic() + 300
    try:
        if offline:
            source = offline / filename
            if not stat.S_ISREG(source.lstat().st_mode):
                raise SetupError("offline_artifact_unavailable")
            stream = source.open("rb")
        else:
            opener = build_opener(ProxyHandler({}), NoRedirect())
            stream = opener.open(Request(url.geturl(), headers={"Accept-Encoding": "identity"}), timeout=20)
        with stream, target.open("xb") as output:
            while data := stream.read(CHUNK):
                total += len(data)
                if time.monotonic() > deadline or total > MAX_DOWNLOAD:
                    raise SetupError("artifact_limit_exceeded")
                digest.update(data)
                output.write(data)
    except URLError as error:
        raise SetupError("artifact_download_failed") from error
    except FileNotFoundError as error:
        raise SetupError("offline_artifact_unavailable" if offline else "artifact_download_failed") from error
    if not total or digest.hexdigest() != expected:
        raise SetupError("artifact_digest_mismatch")


def copy_members(archive, directory, files):
    """Copy only selected regular files. Archive metadata never sets destination paths or permissions."""
    seen = set()
    unpacked = 0
    try:
        with tarfile.open(archive, mode="r|*") as stream:
            for index, member in enumerate(stream):
                unpacked += member.size
                if index >= 20_000 or not 0 <= unpacked <= MAX_ARCHIVE:
                    raise SetupError("archive_limit_exceeded")
                name = member.name.removeprefix("./")
                if name not in files:
                    continue
                if not member.isfile() or member.issparse() or name in seen:
                    raise SetupError("invalid_archive_member")
                relative, mode, _required = files[name]
                target = directory / relative
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with stream.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, CHUNK)
                target.chmod(mode)
                seen.add(name)
    except (tarfile.TarError, EOFError) as error:
        raise SetupError("invalid_runtime_archive") from error
    if any(required and name not in seen for name, (_, _, required) in files.items()):
        raise SetupError("runtime_archive_layout_changed")


def fetch_members(catalog, kind, arch, stage, scratch, offline, files):
    archive = scratch / (kind + ".archive")
    download(selected_artifact(catalog, kind, arch), archive, offline)
    copy_members(archive, stage, files)
    archive.unlink()


def stage_cli(catalog, kind, arch, stage, scratch, offline):
    if kind == "codex":
        prefix = "package/vendor/" + CODEX_TARGET[arch] + "/"
        files = {prefix + "bin/codex": ("codex", 0o700, True),
                 prefix + "bin/codex-code-mode-host": ("codex-code-mode-host", 0o700, False),
                 prefix + "bin/codex-exec-server": ("codex-exec-server", 0o700, False),
                 prefix + "codex-path/rg": ("codex-path/rg", 0o700, False),
                 "package/LICENSE": ("LICENSE", 0o600, False)}
    elif kind == "claude":
        files = {"package/claude": ("claude", 0o700, True),
                 "package/LICENSE.md": ("LICENSE.md", 0o600, True)}
    else:
        files = {"antigravity": ("agy", 0o700, True)}
    fetch_members(catalog, kind, arch, stage, scratch, offline, files)
    target = stage / PROVIDERS[kind]
    if not binary_path(target, arch):
        raise SetupError("invalid_runtime_binary")
    return target


def check_cli(probe, kind, executable):
    probe(executable, ["--version"])
    if kind == "codex":
        probe(executable, ["app-server", "--help"], required=("--listen", "stdio"))
    elif kind == "antigravity":
        probe(executable, ["acp", "--help"], required=("acp", "--sandbox", "--disable-telemetry"))


def install_cli(catalog, kind, arch, home, deployments, offline, probe):
    name = PROVIDERS[kind]
    link = home / ".local/bin" / name
    path = os.environ.get("PATH", "")
    selected = shutil.which(name, path=path)
    existing = binary_path(selected or link, arch)
    if existing:
        check_cli(probe, kind, existing)
        return "existing"
    if selected:
        raise SetupError("incompatible_runtime_on_ssh_path")
    if os.path.lexists(link):
        raise SetupError("existing_runtime_path")
    private_dir(link.parent, shared_read=True, create=True)
    target = deployments / f"{kind}-{catalog[kind]['version']}-{arch}"
    # Always reconstruct from pinned bytes if no live CLI points at a managed tree.
    if os.path.lexists(target):
        raise SetupError("runtime_directory_already_present")
    with tempfile.TemporaryDirectory(prefix=".runtime-", dir=deployments) as directory:
        scratch = Path(directory)
        stage = private_dir(scratch / "payload", create=True)
        executable = stage_cli(catalog, kind, arch, stage, scratch, offline)
        check_cli(probe, kind, executable)
        publish_directory(stage, target)
        linked = False
        try:
            link.symlink_to(target / name)
            linked = True
            selected = shutil.which(name, path=path)
            if selected and Path(selected).resolve(strict=True) != target / name:
                raise SetupError("incompatible_runtime_on_ssh_path")
        except (OSError, SetupError):
            # Restore the unreferenced tree while preserving a concurrently created link.
            if linked and link.is_symlink() and link.readlink() == target / name:
                link.unlink()
            os.rename(target, stage)
            raise
    return "installed"


def install_sdk(catalog, arch, home, offline, probe, sdk_runtime):
    target = home / ".dsh-claude-sdk"
    if os.path.lexists(target):
        try:
            node, package = sdk_runtime(str(home))
        except (OSError, ValueError) as error:
            raise SetupError("existing_sdk_requires_review") from error
        if not binary_path(node, arch):
            raise SetupError("existing_sdk_requires_review")
        probe(node, ["--version"], package)
        return "existing"
    with tempfile.TemporaryDirectory(prefix=".workbench-claude-sdk-", dir=home) as directory:
        scratch = Path(directory)
        stage = private_dir(scratch / ".dsh-claude-sdk", create=True)
        node_prefix = f"node-v{catalog['node']['version']}-linux-{arch}/"
        fetch_members(catalog, "node", arch, stage, scratch, offline, {
            node_prefix + "bin/node": ("runtime/bin/node", 0o700, True),
            node_prefix + "LICENSE": ("runtime/LICENSE", 0o600, True),
        })
        # Pinned SDK 0.3.311 loads several adjacent ES modules.
        sdk_names = ("package.json", "manifest.json", "manifest.zst.json", "sdk.mjs", "bridge.mjs", "core.mjs",
                     "core-0bjz4v5z.mjs", "core-ptjgnrch.mjs", "core-rbkmqzx3.mjs", "core-zbftdwza.mjs",
                     "browser-sdk.js", "extractFromBunfs.js", "LICENSE.md")
        sdk_files = {f"package/{filename}": (SDK_PATH / filename, 0o600, True) for filename in sdk_names}
        fetch_members(catalog, "claude-sdk", arch, stage, scratch, offline, sdk_files)
        node, package = sdk_runtime(str(scratch))
        if not binary_path(node, arch):
            raise SetupError("invalid_runtime_binary")
        probe(node, ["--version"], package)
        publish_directory(stage, target)
    return "installed"


def prepare_antigravity_profile(home, hosts, validate_hosts):
    root = private_dir(home / ".dsh-antigravity", create=True)
    private_dir(root / "home", create=True)
    if hosts:
        data = {"hosts": hosts}
        validate_hosts(data)
        path = root / "hosts.json"
        if os.path.lexists(path):
            info = path.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or
                    info.st_mode & 0o077 or info.st_size > 4096 or json.loads(path.read_bytes()) != data):
                raise SetupError("existing_antigravity_hosts")
        else:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(data, stream)
