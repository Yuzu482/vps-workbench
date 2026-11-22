"""SSH entry point for the bundled, user-scoped Workbench installer (Linux)."""

import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import uuid
import zlib


PROVIDERS = ("codex", "claude", "claude-sdk", "antigravity")
SHA = re.compile(r"[a-f0-9]{64}")
CODE = re.compile(r"[a-z][a-z0-9_]{0,79}")
MEMBER = re.compile(r"(VPS-Workbench-Backend-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?-linux)/"
                    r"((?:helpers/)?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)")
MAX_ARCHIVE = 4 * 1024**2
MAX_UNPACKED = 16 * 1024**2
JOB_ROOT = Path(".local/share/vps-workbench/backend-jobs")
PYTHON = "/usr/bin/python3"


class JobError(ValueError):
    """A public error identifier."""


def safe_code(value, fallback):
    return value if isinstance(value, str) and CODE.fullmatch(value) else fallback


def validate(request):
    if not isinstance(request, dict):
        raise JobError("invalid_request")
    kind = request.get("kind")
    keys = {"targetId", "kind"}
    if kind in ("start", "status"):
        keys.add("installId")
        ident = request.get("installId")
        try:
            parsed = uuid.UUID(ident) if isinstance(ident, str) else None
        except ValueError:
            parsed = None
        if not parsed or not parsed.int or str(parsed) != ident:
            raise JobError("invalid_install_id")
    if kind in ("probe", "start"):
        keys.add("workspace")
        work = request.get("workspace")
        if (not isinstance(work, str) or not work.startswith("/") or work.startswith("//") or
                any(ord(c) < 32 or ord(c) == 127 for c in work) or len(work.encode()) > 4096 or
                ".." in Path(work).parts):
            raise JobError("invalid_workspace")
    if kind == "start":
        keys.add("providers")
        selected = request.get("providers")
        if (not isinstance(selected, list) or not 1 <= len(selected) <= len(PROVIDERS) or
                any(p not in PROVIDERS for p in selected) or len(set(selected)) != len(selected)):
            raise JobError("invalid_providers")
    if (kind not in ("probe", "start", "status") or keys != request.keys() or
            not isinstance(request["targetId"], str) or not SHA.fullmatch(request["targetId"])):
        raise JobError("invalid_request")


def checked_directory(path, *, shared=False, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        else:
            sync_dir(path.parent)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
            info.st_mode & (0o022 if shared else 0o077) or path.resolve(strict=True) != path):
        raise JobError("unsafe_directory")
    return path


def ssh_home():
    import pwd

    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise JobError("non_root_user_required")
    actual = pwd.getpwuid(os.getuid()).pw_dir
    if not actual.startswith("/") or os.environ.get("HOME") != actual:
        raise JobError("invalid_home")
    return checked_directory(Path(actual), shared=True)


def child_environment(home):
    # Preserve search order (including a missing ~/.local/bin). Discard all ambient
    # agent sockets, proxies, loader settings, Python settings and provider keys.
    path = os.environ.get("PATH", "")
    if not path or len(path) > 8192:
        raise JobError("unsafe_ssh_path")
    for raw in path.split(":"):
        entry = Path(raw)
        if (not raw.startswith("/") or ".." in entry.parts or any(ord(c) < 32 for c in raw)):
            raise JobError("unsafe_ssh_path")
        try:
            resolved = entry.resolve(strict=False)
        except (OSError, RuntimeError) as exc:
            raise JobError("unsafe_ssh_path") from exc
        for directory in dict.fromkeys((entry, *entry.parents, resolved, *resolved.parents)):
            if not os.path.lexists(directory):
                continue
            info = directory.stat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()) or
                    info.st_mode & 0o022):
                raise JobError("unsafe_ssh_path")
    return {"HOME": str(home), "PATH": path, "LANG": "C.UTF-8"}


def jobs_root(home, create):
    root = home
    for i, part in enumerate(JOB_ROOT.parts):
        root = checked_directory(root / part, shared=i < 2, create=create)
    return root


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_receipt(job, data):
    with tempfile.NamedTemporaryFile(dir=job, delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(json.dumps(data, separators=(",", ":")).encode())
            f.flush()
            os.fsync(f.fileno())
            os.replace(tmp, job / "receipt.json")
            sync_dir(job)
        finally:
            tmp.unlink(missing_ok=True)


def private_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    f = os.fdopen(fd, "rb")
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 16384):
        f.close()
        raise JobError("install_receipt_unavailable")
    return f


def read_receipt(job):
    try:
        with private_read(job / "receipt.json") as f:
            data = json.load(f)
        if (not isinstance(data, dict) or not isinstance(data.get("install"), dict) or
                not isinstance(data.get("binding"), dict)):
            raise ValueError()
        validate(data["binding"]["request"])
        request = data["binding"]["request"]
        install = data["install"]
        if (request["kind"] != "start" or request["installId"] != job.name or
                not SHA.fullmatch(data["binding"]["digest"]) or
                install["id"] != job.name or install["providers"] != request["providers"] or
                install["state"] not in ("running", "succeeded", "failed", "unknown") or
                not isinstance(install["results"], dict) or set(install["results"]) - set(request["providers"]) or
                set(install) - {"id", "providers", "state", "results", "code"} or
                ("code" in install and not CODE.fullmatch(install["code"]))):
            raise ValueError()
        for item in install["results"].values():
            if (not isinstance(item, dict) or item.get("runtime") not in ("installed", "existing", "failed") or
                    set(item) - {"runtime", "onSshPath", "code"} or
                    ("onSshPath" in item and type(item["onSshPath"]) is not bool) or
                    ("code" in item and not CODE.fullmatch(item["code"]))):
                raise ValueError()
        if install["state"] == "succeeded" and (set(install["results"]) != set(request["providers"]) or
                                                any(r["runtime"] == "failed" for r in install["results"].values())):
            raise ValueError()
        return data
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise JobError("install_receipt_unavailable") from exc


def inspect_job(job, request, binding=None):
    import fcntl

    def snapshot():
        data = read_receipt(job)
        original = data["binding"]
        if original["request"]["targetId"] != request["targetId"] or (binding and binding != original):
            raise JobError("install_binding_mismatch")
        return data["install"]

    install = snapshot()
    if install["state"] == "running":
        with private_read(job / "worker.lock") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                install = snapshot()
                if install["state"] == "running":
                    install.update(state="unknown", code="worker_unconfirmed")
    return {"ok": True, "targetId": request["targetId"], "install": install}


def check_archive(archive, digest):
    if (not isinstance(archive, bytes) or not 0 < len(archive) <= MAX_ARCHIVE or
            not isinstance(digest, str) or not SHA.fullmatch(digest) or
            hashlib.sha256(archive).hexdigest() != digest):
        raise JobError("package_digest_mismatch")


def unpack(archive, directory):
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as gz:
            raw = gz.read(MAX_UNPACKED + 1)
        if len(raw) > MAX_UNPACKED:
            raise JobError("invalid_backend_archive")
        prefix = None
        seen = set()
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
            for member in tar:
                match = MEMBER.fullmatch(member.name)
                if (not match or member.type != tarfile.REGTYPE or member.pax_headers or
                        member.issparse() or not 0 < member.size <= 1024**2 or len(seen) >= 129):
                    raise JobError("invalid_backend_archive")
                root, name = match.groups()
                if prefix not in (None, root) or name in seen:
                    raise JobError("invalid_backend_archive")
                prefix = root
                seen.add(name)
                target = directory / name
                target.parent.mkdir(mode=0o700, exist_ok=True)
                with tar.extractfile(member) as src, target.open("xb") as dest:
                    dest.write(src.read())
        if not {"manifest.json", "workbench-vps.py"} <= seen:
            raise JobError("invalid_backend_archive")
    except (tarfile.TarError, EOFError, gzip.BadGzipFile, zlib.error) as exc:
        raise JobError("invalid_backend_archive") from exc


def default_missing(home, workspace):
    return workspace == str(home / "vps-workbench-project") and not os.path.lexists(workspace)


def run_package(archive, request, home, env):
    installing = request["kind"] == "start"
    workspace = str(Path(request["workspace"]))
    create_default = default_missing(home, workspace)
    with tempfile.TemporaryDirectory(prefix="vps-workbench-package-", dir="/tmp") as scratch:
        unpack(archive, Path(scratch))
        args = [PYTHON, "-I", "-B", str(Path(scratch) / "workbench-vps.py"), "install" if installing else "doctor"]
        if not create_default:
            args += ["--workspace", workspace]
        for provider in request.get("providers", []):
            args += ["--provider", provider]
        result = subprocess.run(args, env=env, cwd=scratch, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, timeout=3600 if installing else 90, check=False)
    if len(result.stdout) > 65536:
        raise JobError("installer_result_unavailable")
    try:
        report = json.loads(result.stdout)
    except ValueError as exc:
        raise JobError("installer_result_unavailable") from exc
    if not isinstance(report, dict):
        raise JobError("installer_result_unavailable")
    if not installing:
        if "system" not in report or "architecture" not in report or "blocker" not in report:
            raise JobError(safe_code(report.get("error"), "doctor_result_unavailable"))
        if result.returncode != 0 and not report["blocker"]:
            raise JobError("doctor_result_unavailable")
        report = {key: report[key] for key in ("version", "system", "distribution", "distributionVersion",
                  "architecture", "packageManager", "dependencyCommand", "blocker", "missing", "sandbox",
                  "workspace", "providers") if key in report}
        if create_default:
            report["workspace"] = "will_create"
        elif not os.path.lexists(workspace):
            report["workspace"] = "workspace_unavailable"
            report["blocker"] = report["blocker"] or "workspace_unavailable"
    return report, result.returncode


def finish_install(install, report, returncode):
    if report.get("error") or report.get("blocker"):
        install.update(state="failed", code=safe_code(report.get("error") or report["blocker"], "install_failed"))
        return
    results = report.get("providers")
    if not isinstance(results, dict) or set(results) != set(install["providers"]):
        raise JobError("installer_result_unavailable")
    for provider in install["providers"]:
        value = results[provider]
        if not isinstance(value, dict) or value.get("runtime") not in ("installed", "existing", "failed"):
            raise JobError("installer_result_unavailable")
        result = {"runtime": value["runtime"]}
        if result["runtime"] == "failed":
            result["code"] = safe_code(value.get("code"), "install_failed")
        if type(value.get("onSshPath")) is bool:
            result["onSshPath"] = value["onSshPath"]
        install["results"][provider] = result
    if any(v["runtime"] == "failed" for v in install["results"].values()):
        install.update(state="failed", code="provider_install_failed")
    elif returncode == 0:
        install.update(state="succeeded")
    else:
        raise JobError("installer_result_unavailable")


def worker(job, archive_fd):
    # The inherited exclusive lock shares the launching process's file description.
    # It remains held until this process exits, including while publishing the result.
    data = read_receipt(job)
    try:
        with os.fdopen(archive_fd, "rb") as f:
            archive = f.read(MAX_ARCHIVE + 1)
        check_archive(archive, data["binding"]["digest"])
        report, rc = run_package(archive, data["binding"]["request"], Path(os.environ["HOME"]), dict(os.environ))
        finish_install(data["install"], report, rc)
    except JobError as exc:
        state = "unknown" if str(exc) == "installer_result_unavailable" else "failed"
        data["install"].update(state=state, code=str(exc))
    except (OSError, ValueError, subprocess.SubprocessError):
        data["install"].update(state="unknown", code="installer_result_unavailable")
    write_receipt(job, data)


def launch(job, source, archive, lock, env):
    # Anonymous files avoid persisting or reusing executable code in the receipt.
    with tempfile.TemporaryFile(dir="/tmp") as script, tempfile.TemporaryFile(dir="/tmp") as payload:
        for file, content in ((script, source), (payload, archive)):
            file.write(content)
            file.seek(0)
        process = subprocess.Popen(
            [PYTHON, "-I", "-B", f"/proc/self/fd/{script.fileno()}", str(job), str(payload.fileno())],
            cwd="/", env=env, start_new_session=True, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            pass_fds=(script.fileno(), payload.fileno(), lock.fileno()))
        # A long-lived dispatcher reaps its child. A one-shot SSH caller can exit immediately.
        try:
            threading.Thread(target=process.wait, daemon=True).start()
        except RuntimeError:
            # Reaping is optional in the short-lived SSH parent; launch already succeeded.
            pass


def dispatch(request, archive=b"", digest="", source=b""):
    try:
        validate(request)
        kind = request["kind"]
        try:
            home = ssh_home()
            if kind != "status":
                check_archive(archive, digest)
            if kind == "start":
                if not isinstance(source, bytes) or not 0 < len(source) <= 131072:
                    raise JobError("invalid_worker_source")
                root = jobs_root(home, True)
        except (JobError, OSError) as exc:
            if kind != "start":
                raise
            # No job has been reserved or launched by this request. The caller
            # can record this bound rejection and allow a new, explicit attempt.
            return {"ok": True, "targetId": request["targetId"], "install": {
                "id": request["installId"], "providers": request["providers"],
                "state": "failed", "results": {},
                "code": str(exc) if isinstance(exc, JobError) else "backend_storage_unavailable"}}
        if kind == "status":
            try:
                job = checked_directory(jobs_root(home, False) / request["installId"])
            except FileNotFoundError:
                raise JobError("install_receipt_missing")
            return inspect_job(job, request)
        if kind == "probe":
            platform, _ = run_package(archive, request, home, child_environment(home))
            return {"ok": True, "targetId": request["targetId"], "platform": platform}
        binding = {"request": request, "digest": digest}
        job = root / request["installId"]
        try:
            job.mkdir(mode=0o700)
        except FileExistsError:
            return inspect_job(checked_directory(job), request, binding)
        sync_dir(root)
        import fcntl

        fd = os.open(job / "worker.lock", os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_RDWR, 0o600)
        with os.fdopen(fd, "wb") as lock:
            fcntl.flock(fd, fcntl.LOCK_EX)
            install = {"id": job.name, "providers": request["providers"], "state": "running", "results": {}}
            data = {"binding": binding, "install": install}
            write_receipt(job, data)
            try:
                launch(job, source, archive, lock, child_environment(home))
            except (JobError, OSError, subprocess.SubprocessError) as exc:
                install.update(state="failed", code=str(exc) if isinstance(exc, JobError) else "worker_start_failed")
                write_receipt(job, data)
        return {"ok": True, "targetId": request["targetId"], "install": install}
    except JobError as exc:
        return {"ok": False, "code": str(exc)}
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return {"ok": False, "code": "backend_setup_unavailable"}


if __name__ == "__main__":
    worker(Path(sys.argv[1]), int(sys.argv[2]))
