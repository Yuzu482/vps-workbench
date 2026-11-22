"""Build the portable VPS package using only explicitly listed repository files."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
WINDOWS = ROOT / "windows-terminal"
CHAT = ROOT / "remote-workbench" / "vps-chat"

SOURCES = {
    "workbench-vps.py": HERE / "workbench-vps.py",
    "vps_runtimes.py": HERE / "vps_runtimes.py",
    "runtime-catalog.json": HERE / "runtime-catalog.json",
    "README.md": HERE / "README.md",
    **{f"helpers/{name}.py": WINDOWS / f"{name}.py" for name in (
        "Probe-RemoteEgress", "RemoteChatFiles", "RemoteClaudeAuth", "RemoteClaudeShared",
        "RemoteCodexIsolate", "RemoteCodexPrivacy", "RemoteNativeSafety", "RemoteNativeSession",
        "RemoteTask", "RemoteTaskStart", "RemoteTaskStatus",
    )},
    **{f"helpers/{name}.py": WINDOWS / "DshChatBridge" / f"{name}.py" for name in (
        "RemoteDshAntigravity", "RemoteDshClaudeSdk", "RemoteDshCodexStream", "RemoteDshExtensions",
        "RemoteDshSetup", "RemoteWorkflowArtifacts", "RemoteWorkflowFiles",
    )},
    "helpers/RemoteDshCodexCatalog.py": WINDOWS / "DshCatalog" / "RemoteDshCodexCatalog.py",
    "helpers/RemoteClaudeAccount.py": CHAT / "host" / "RemoteClaudeAccount.py",
    "helpers/dsh-claude-sdk-worker.mjs": CHAT / "claude-sdk" / "worker.mjs",
    "helpers/sessions.py": ROOT / "dsh-terminal-workbench/native/sessions.py",
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def build(output, revision=None):
    version = json.loads((HERE.parent / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("invalid Workbench version")
    if revision is not None and not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("invalid source revision")
    files = {name: path.read_bytes() for name, path in SOURCES.items()}
    for name, data in files.items():
        if name.endswith(".py"):
            compile(data, name, "exec")  # Syntax only. No helper or official runtime is executed.
    manifest = {"schema": 1, "version": version, "revision": revision, "architectures": ["x64", "arm64"],
                "files": {name: {"size": len(data), "sha256": sha256(data)} for name, data in sorted(files.items())}}
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    prefix = f"VPS-Workbench-Backend-{version}-linux"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / (prefix + ".tar.gz")
    checksum = archive.with_name(archive.name + ".sha256")
    if archive.exists() or checksum.exists():
        raise FileExistsError("release artifacts already exist")
    stream = archive.open("xb")
    try:
        with stream, gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as bundle:
                for path, data in sorted(files.items()):
                    entry = tarfile.TarInfo(prefix + "/" + path)
                    entry.size = len(data)
                    entry.mode = 0o644
                    bundle.addfile(entry, io.BytesIO(data))
    except BaseException:
        archive.unlink(missing_ok=True)
        raise
    digest = sha256(archive.read_bytes())
    with checksum.open("x", encoding="ascii", newline="\n") as stream:
        stream.write(f"{digest}  {archive.name}\n")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE.parent / "dist" / "vps-backend")
    parser.add_argument("--revision", help="Exact Git commit included in the archive manifest.")
    args = parser.parse_args()
    print(build(args.output, args.revision))
