"""Build a Windows update archive from a target and known existing builds."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_build(directory):
    app = directory / "resources" / "app"
    package = json.loads((app / "package.json").read_text(encoding="utf-8-sig"))
    web = json.loads((app / "desktop" / "web" / "revision.json").read_text(encoding="utf-8-sig"))
    if package["name"] != "vps-workbench" or not re.fullmatch(r"[0-9a-f]{64}", web["revision"]):
        raise ValueError("Unexpected VPS Workbench package metadata")
    return app / "package.json", {"version": package["version"], "revision": web["revision"]}


def build_update(target, bases, output, instructions):
    tools = Path(__file__).resolve().parent
    package, target_info = read_build(target)
    base_info = []
    for base in bases:
        _, info = read_build(base)
        if info not in base_info:
            base_info.append(info)
    manifest = {"version": target_info["version"], "webRevision": target_info["revision"],
                "bases": base_info, "files": []}
    changed = []
    names = set()
    for file in sorted(target.rglob("*")):
        if not file.is_file():
            continue
        relative = file.relative_to(target).as_posix()
        if (not re.fullmatch(r"[\w][\w@./ -]*", relative)
                or re.search(r"[. ](/|$)|//|/\.", relative)
                or relative.lower() in names):
            raise ValueError(f"Unsupported application file name: {relative}")
        names.add(relative.lower())
        checksum = digest(file)
        needs_payload = any(not (base / relative).is_file() or digest(base / relative) != checksum for base in bases)
        manifest["files"].append({"path": relative, "sha256": checksum, "changed": needs_payload})
        if needs_payload:
            changed.append((relative, file))
    if not changed:
        raise ValueError("There is nothing to publish")
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr("update.json", json.dumps(manifest, indent=2) + "\n")
        archive.write(package, "package.json")
        archive.write(tools / "Install.cmd", "Install.cmd")
        archive.write(tools / "Install-Update.ps1", "Install-Update.ps1")
        archive.write(tools.parent / "Sync-Local.ps1", "Sync-Local.ps1")
        archive.write(instructions, "README.md")
        for relative, file in changed:
            archive.write(file, "Payload/" + relative)
    print(f"{len(changed)} changed files out of {len(manifest['files'])} verified files")
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--base", required=True, action="append", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--instructions", required=True, type=Path)
    options = parser.parse_args()
    build_update(options.target, options.base, options.output, options.instructions)
