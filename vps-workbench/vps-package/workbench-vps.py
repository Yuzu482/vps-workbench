"""Verify, check and install the standalone VPS Workbench Linux package."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import types


PACKAGE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True


ARCHITECTURES = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}
SYSTEM_PACKAGES = {
    "apt": ["apt-get", "install", "--no-install-recommends", "python3", "bubblewrap", "iproute2", "curl", "ca-certificates"],
    "dnf": ["dnf", "install", "python3", "bubblewrap", "iproute", "curl", "ca-certificates"],
}
STANDARD_PATH = "/usr/bin:/usr/sbin:/bin"
SANDBOX_ENV = {"PATH": STANDARD_PATH, "LANG": "C.UTF-8", "HOME": "/nonexistent"}
VERSION = r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?"
FILE = re.compile(r"(?:helpers/)?[A-Za-z0-9_-]+(?:[.][A-Za-z0-9_-]+)+")
PROVIDERS = ("codex", "claude", "claude-sdk", "antigravity")


class SetupError(ValueError):
    """A package or host check status suitable for printing."""


def verified_file(path, pin):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or path.resolve(strict=True) != path or
            not 0 < info.st_size == pin["size"] <= 1024 * 1024):
        raise SetupError("package_digest_mismatch")
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != pin["sha256"]:
        raise SetupError("package_digest_mismatch")
    return content


def manifest(package):
    index = package / "manifest.json"
    if not stat.S_ISREG(index.lstat().st_mode) or index.stat().st_size > 64 * 1024:
        raise SetupError("invalid_manifest")
    data = json.loads(index.read_bytes())
    if (not isinstance(data, dict) or data.get("schema") != 1 or not re.fullmatch(VERSION, data.get("version", "")) or
            data.get("architectures") != ["x64", "arm64"] or not isinstance(data.get("files"), dict) or
            not 1 <= len(data["files"]) <= 128 or "manifest.json" in data["files"]):
        raise SetupError("invalid_manifest")
    expected = data["files"]
    for name, pin in expected.items():
        if not FILE.fullmatch(name) or not isinstance(pin, dict) or set(pin) != {"size", "sha256"}:
            raise SetupError("invalid_manifest")
        verified_file(package / name, pin)
    if {item.relative_to(package).as_posix() for item in package.rglob("*")
            if not item.is_dir() or item.is_symlink()} != set(expected) | {"manifest.json"}:
        raise SetupError("unexpected_package_files")
    return data


def load_runtimes(package, metadata):
    path = package / "vps_runtimes.py"
    source = verified_file(path, metadata["files"][path.name])
    module = types.ModuleType("vps_runtimes")
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


def distro_fields(contents):
    """Read os-release values without running the file as shell code."""
    result = {}
    for line in contents.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in ("ID", "ID_LIKE", "VERSION_ID"):
            try:
                fields = shlex.split(value)
            except ValueError:
                continue
            if len(fields) == 1 and re.fullmatch(r"[a-zA-Z0-9._ -]{1,120}", fields[0]):
                result[key] = fields[0].lower()
    return result


def classify(system, machine, fields, libc):
    arch = ARCHITECTURES.get(machine.lower())
    distro = fields.get("ID", "")
    aliases = set(fields.get("ID_LIKE", "").split()) | {distro}
    family = None
    if aliases & {"debian", "ubuntu"}:
        family = "apt"
    elif aliases & {"fedora", "rhel", "centos", "centos-stream", "rocky", "almalinux"}:
        family = "dnf"
    library = re.fullmatch(r"glibc ([0-9]+)[.]([0-9]+)(?:[.][0-9]+)?", libc)
    if system != "Linux":
        blocker = "linux_required"
    elif not arch:
        blocker = "unsupported_cpu"
    elif not library or tuple(map(int, library.groups())) < (2, 28):
        blocker = "glibc_2_28_required"
    else:
        blocker = None
    return {"system": system, "distribution": distro or None, "distributionVersion": fields.get("VERSION_ID"),
            "architecture": arch, "packageManager": family if system == "Linux" else None,
            "dependencyCommand": SYSTEM_PACKAGES.get(family) if system == "Linux" else None, "blocker": blocker}


def platform_info():
    distro = {}
    libc = ""
    if sys.platform == "linux":
        try:
            with open("/etc/os-release", encoding="utf-8") as stream:
                distro = distro_fields(stream.read(16 * 1024))
        except OSError:
            pass
        try:
            libc = os.confstr("CS_GNU_LIBC_VERSION") or ""
        except (OSError, ValueError):
            pass
    return classify(platform.system(), platform.machine(), distro, libc)


def home_directory(runtimes):
    raw = Path(os.environ.get("HOME", ""))
    if not raw.is_absolute():
        raise SetupError("invalid_home")
    if os.getuid() == 0 or os.geteuid() == 0:
        raise SetupError("non_root_user_required")
    return runtimes.private_dir(raw, shared_read=True)


def run_quiet(command, timeout=12):
    return subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          cwd="/tmp", env=SANDBOX_ENV, timeout=timeout, check=False).returncode == 0


def check_dependencies():
    missing = []
    path = os.environ.get("PATH", "")
    expected_python = Path("/usr/bin/python3")
    try:
        python = shutil.which("python3", path=path)
        if (not python or not Path(python).samefile(expected_python) or
                not run_quiet([str(expected_python), "-I", "-B", "-c", "import sys; sys.exit(sys.version_info < (3, 9))"])):
            missing.append("python3")
    except (OSError, subprocess.SubprocessError):
        missing.append("python3")
    if not os.access("/usr/bin/bwrap", os.X_OK):
        missing.append("bubblewrap")
    for tool in ("curl", "ip"):
        if not shutil.which(tool, path=path):
            missing.append(tool)
    for directory in ("/usr/bin", "/usr/sbin", "/usr/lib"):
        if not Path(directory).is_dir():
            missing.append(directory)
    return missing


PROBE = r'''
import json, os, pathlib, resource, ssl, subprocess, sys, tempfile
context = json.loads(sys.argv[2])
if (os.getuid() != 1000 or "SSH_CONNECTION" in os.environ or
    os.readlink("/proc/self/ns/net") == context["net"] or
    pathlib.Path(context["private"]).exists() or
    pathlib.Path("/workspace/read-me").read_text() != "workbench probe"):
    sys.exit(3)
try:
    pathlib.Path("/workspace/should-not-exist").write_text("probe")
except OSError:
    pass
else:
    sys.exit(3)
if ssl.create_default_context().cert_store_stats()["x509_ca"] == 0:
    sys.exit(4)
if context["args"] is not None:
    env = {"HOME": "/home/codex", "PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8",
           "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1"}
    def limit_output():
        resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))
    with tempfile.TemporaryFile() as output:
        code = subprocess.run(["/opt/agy", *context["args"]], env=env, stdin=subprocess.DEVNULL,
                              stdout=output, stderr=output, preexec_fn=limit_output).returncode
        output.seek(0)
        observed = output.read(65536).lower()
    if code or any(flag.encode() not in observed for flag in context["required"]):
        sys.exit(5)
'''


def sandbox_probe(isolation, executable="/usr/bin/true", arguments=None, sdk=None, required=()):
    with tempfile.TemporaryDirectory(prefix="vps-workbench-probe-", dir="/tmp") as directory:
        root = Path(directory)
        work = root / "project"
        gate = root / "gate"
        work.mkdir(mode=0o700)
        gate.mkdir(mode=0o700)
        (work / "read-me").write_text("workbench probe", encoding="utf-8")
        private = root / "private"
        private.touch(mode=0o600)
        for name, value in {"passwd": "codex:x:1000:1000:Codex:/home/codex:/bin/sh\n",
                            "group": "codex:x:1000:\n", "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files\n",
                            "hosts": "127.0.0.1 localhost\n"}.items():
            (gate / name).write_text(value, encoding="ascii")
        if sdk is not None:
            arguments = ["--input-type=module", "-e",
                         "import {query} from '/opt/dsh-claude-sdk/sdk.mjs'; if(typeof query!=='function')process.exit(1);"]
        context = {"net": os.readlink("/proc/self/ns/net"), "private": str(private), "args": arguments, "required": required}
        command = isolation["sandbox_command"](str(executable), str(work), None, str(gate), [], provider="agy",
                                                runner_script=PROBE, read_only_workspace=True)
        if sdk is not None:
            split = command.index("--")
            command[split:split] = ["--ro-bind", str(sdk), "/opt/dsh-claude-sdk"]
        command.append(json.dumps(context))
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    cwd="/tmp", env={**SANDBOX_ENV, "SSH_CONNECTION": "fixture"}, timeout=15, check=False)
        except (OSError, subprocess.SubprocessError) as error:
            raise SetupError("sandbox_unavailable") from error
    if result.returncode != 0:
        raise SetupError({3: "sandbox_isolation_failed", 4: "sandbox_ca_missing", 5: "runtime_unavailable"}
                         .get(result.returncode, "sandbox_unavailable"))


def check_workspace(isolation, work, home):
    executable = "/usr/bin/true"
    if not work.is_absolute() or work.resolve(strict=True) != work or work.stat().st_uid != os.getuid():
        raise SetupError("workspace_unavailable")
    sdk_root = home / ".dsh-claude-sdk"
    if work == sdk_root or sdk_root in work.parents or work in sdk_root.parents:
        raise SetupError("workspace_unavailable")
    isolation["validate_paths"](executable, str(work), {"HOME": str(home)}, provider="agy")


def doctor(package, version, runtimes, workdir=None):
    report = {"version": version, **platform_info(), "missing": [], "sandbox": "not_checked",
              "workspace": "not_checked", "providers": {}}
    if report["blocker"]:
        return report, None, None
    try:
        home = home_directory(runtimes)
    except (OSError, ValueError) as error:
        report["blocker"] = str(error) if isinstance(error, (SetupError, runtimes.SetupError)) else "invalid_home"
        return report, None, None
    report["missing"] = check_dependencies()
    if report["missing"]:
        report["blocker"] = "dependency_missing"
        return report, None, None
    isolation = runpy.run_path(str(package / "helpers/RemoteCodexIsolate.py"))
    try:
        sandbox_probe(isolation)
        report["sandbox"] = "passed"
    except SetupError as error:
        report["sandbox"] = report["blocker"] = str(error)
        return report, None, None
    if workdir is not None:
        try:
            check_workspace(isolation, workdir, home)
            report["workspace"] = "passed"
        except (OSError, ValueError):
            report["workspace"] = report["blocker"] = "workspace_unavailable"
            return report, None, None
    paths = os.environ.get("PATH", "")
    architecture = report["architecture"]
    for name, tool in runtimes.PROVIDERS.items():
        executable = runtimes.find_binary(tool, home, architecture, paths)
        state = "found" if executable else "missing"
        if name == "claude-sdk" and executable:
            try:
                node, _ = runpy.run_path(str(package / "helpers/RemoteDshClaudeSdk.py"))["sdk_runtime"](str(home))
                if not runtimes.binary_path(node, architecture):
                    raise ValueError()
            except (OSError, ValueError):
                state = "sdk_missing"
        if name == "antigravity" and executable:
            profile = home / ".dsh-antigravity"
            try:
                runtimes.private_dir(profile)
                runtimes.private_dir(profile / "home")
                support = runpy.run_path(str(package / "helpers/RemoteDshCodexStream.py"))
                antigravity = runpy.run_path(str(package / "helpers/RemoteDshAntigravity.py"))
                antigravity["allowed_hosts"](support["read_private_json"](profile / "hosts.json", 4096))
            except (OSError, ValueError):
                state = "profile_not_configured"
        report["providers"][name] = {"runtime": state, "onSshPath": bool(executable and shutil.which(tool, path=paths)),
                                      "account": "unchecked"}
    return report, home, isolation


def install(package, metadata, report, home, isolation, args, runtimes):
    catalog = json.loads((package / "runtime-catalog.json").read_bytes())
    architecture = report["architecture"]
    antigravity = runpy.run_path(str(package / "helpers/RemoteDshAntigravity.py"))
    if args.agy_host:
        if "antigravity" not in args.provider:
            raise SetupError("antigravity_selection_required")
        try:
            antigravity["allowed_hosts"]({"hosts": args.agy_host})
        except ValueError as error:
            raise SetupError("invalid_antigravity_hosts") from error
    runtimes.private_dir(home / ".local", shared_read=True, create=True)
    runtimes.private_dir(home / ".local/share", shared_read=True, create=True)
    root = runtimes.private_dir(home / ".local/share/vps-workbench", create=True)
    releases = runtimes.private_dir(root / "backend", create=True)
    deployments = runtimes.private_dir(root / "runtimes", create=True)
    digest = hashlib.sha256((package / "manifest.json").read_bytes()).hexdigest()[:12]
    release = releases / (metadata["version"] + "-" + digest)
    project = args.workspace or home / "vps-workbench-project"
    results = {}
    with runtimes.install_lock(root / "install.lock"):
        if args.workspace is None:
            runtimes.private_dir(project, shared_read=True, create=True)
            check_workspace(isolation, project, home)
        if os.path.lexists(release):
            if manifest(runtimes.private_dir(release)) != metadata:
                raise SetupError("existing_backend_conflict")
        else:
            with tempfile.TemporaryDirectory(prefix=".backend-", dir=releases) as directory:
                stage = Path(directory) / "payload"
                shutil.copytree(package, stage)
                stage.chmod(0o700)
                if manifest(stage) != metadata:
                    raise SetupError("package_changed")
                runtimes.publish_directory(stage, release)
        sdk_runtime = runpy.run_path(str(package / "helpers/RemoteDshClaudeSdk.py"))["sdk_runtime"]

        def probe(binary, argv, sdk=None, required=()):
            sandbox_probe(isolation, binary, argv, sdk, required)

        cli_results = {}
        for provider in dict.fromkeys(args.provider):
            cli = "claude" if provider == "claude-sdk" else provider
            try:
                if cli not in cli_results:
                    cli_results[cli] = runtimes.install_cli(catalog, cli, architecture, home, deployments, args.offline_dir, probe)
                state = cli_results[cli]
                if provider == "claude-sdk":
                    state = runtimes.install_sdk(catalog, architecture, home, args.offline_dir, probe, sdk_runtime)
                if provider == "antigravity":
                    runtimes.prepare_antigravity_profile(home, args.agy_host, antigravity["allowed_hosts"])
                results[provider] = {"runtime": state, "account": "unchecked",
                                     "onSshPath": bool(shutil.which(runtimes.PROVIDERS[provider], path=os.environ.get("PATH", "")))}
            except (OSError, ValueError) as error:
                code = str(error) if isinstance(error, (SetupError, runtimes.SetupError)) else "local_install_failed"
                results[provider] = {"runtime": "failed", "code": code}
    print(json.dumps({"backend": metadata["version"], "workspace": str(project), "release": str(release),
                      "providers": results}, ensure_ascii=False, indent=2))
    return int(any(result["runtime"] == "failed" for result in results.values()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("verify", help="Verify the extracted package files.")
    check = commands.add_parser("doctor", help="Check the host and start a network-isolated sandbox probe.")
    check.add_argument("--workspace", type=Path)
    authorize = commands.add_parser("install", help="Install a private backend and the selected provider runtimes.")
    authorize.add_argument("--workspace", type=Path)
    authorize.add_argument("--provider", choices=PROVIDERS, action="append", default=[])
    authorize.add_argument("--offline-dir", type=Path)
    authorize.add_argument("--agy-host", action="append", default=[])
    args = parser.parse_args()
    try:
        data = manifest(PACKAGE)
        if args.command == "verify":
            print(json.dumps({"verified": True, "version": data["version"], "revision": data.get("revision")}))
            return 0
        runtimes = load_runtimes(PACKAGE, data)
        try:
            report, home, isolation = doctor(PACKAGE, data["version"], runtimes, args.workspace)
            if args.command == "doctor" or report["blocker"]:
                print(json.dumps(report, ensure_ascii=False, indent=2))
                return 2 if report["blocker"] else 0
            return install(PACKAGE, data, report, home, isolation, args, runtimes)
        except runtimes.SetupError as error:
            raise SetupError(str(error)) from error
    except (OSError, ValueError, KeyError, TypeError) as error:
        code = str(error) if isinstance(error, SetupError) else "package_or_storage_error"
        print(json.dumps({"error": code}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
