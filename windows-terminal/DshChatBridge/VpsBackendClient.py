#!/usr/bin/env python3
"""Send the bundled VPS installation helper over the existing strict SSH transport."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid

from RemoteTaskStatus import build_command, run_ssh


BASE = Path(__file__).resolve().parent
MAX_PACKAGE = 256 * 1024
MAX_HELPER = 64 * 1024
MAX_REQUEST = 16 * 1024
PROVIDERS = ("codex", "claude", "claude-sdk", "antigravity")
PROBE = r'''
system=$(uname -s 2>/dev/null)
machine=$(uname -m 2>/dev/null)
case "$system" in Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS) ;; *) system=Unknown;; esac
case "$machine" in x86_64|amd64|AMD64) architecture='"x64"';; aarch64|arm64) architecture='"arm64"';; *) architecture=null;; esac
if [ "$system" = Linux ] && command -v python3 >/dev/null 2>&1 &&
   python3 -I -B -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    exec python3 -I -B -
fi
distribution=null
manager=null
if [ "$system" = Linux ]; then
    if [ -r /etc/os-release ]; then
        while IFS= read -r line; do
            case "$line" in
                ID=ubuntu|ID='"ubuntu"') distribution='"ubuntu"'; manager='"apt"';;
                ID=debian|ID='"debian"') distribution='"debian"'; manager='"apt"';;
                ID=fedora|ID='"fedora"') distribution='"fedora"'; manager='"dnf"';;
                ID=rhel|ID='"rhel"') distribution='"rhel"'; manager='"dnf"';;
                ID=rocky|ID='"rocky"') distribution='"rocky"'; manager='"dnf"';;
                ID=almalinux|ID='"almalinux"') distribution='"almalinux"'; manager='"dnf"';;
            esac
        done < /etc/os-release
    fi
    blocker=dependency_missing
    missing='["python3"]'
else
    blocker=linux_required
    missing='[]'
fi
printf '{"ok":true,"targetId":"%s","platform":{"system":"%s","distribution":%s,"architecture":%s,"packageManager":%s,"blocker":"%s","missing":%s}}\n' \
    "$1" "$system" "$distribution" "$architecture" "$manager" "$blocker" "$missing"
'''


def read_bounded(path, limit):
    if path.is_symlink() or not path.is_file():
        raise ValueError("missing bundled file")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if not 0 < len(data) <= limit:
        raise ValueError("bundled file exceeds its limit")
    return data


def release_archive():
    archive = read_bounded(BASE / "vps-backend.tar.gz", MAX_PACKAGE)
    digest = read_bounded(BASE / "vps-backend.sha256", 256).decode("ascii").strip()
    if digest != hashlib.sha256(archive).hexdigest():
        raise ValueError("backend package checksum does not match")
    return archive, digest


def valid_request(data, identifier):
    if not isinstance(data, dict) or not isinstance(data.get("targetId"), str) or not re.fullmatch(r"[a-f0-9]{64}", data["targetId"]):
        return False
    kind = data.get("kind")
    common = {"kind", "targetId"}
    if kind == "status":
        return set(data) == common | {"installId"} and data["installId"] == identifier
    if kind not in ("probe", "start"):
        return False
    workspace = data.get("workspace")
    if not isinstance(workspace, str) or not workspace.startswith("/") or len(workspace) > 2048 or any(ord(c) < 32 for c in workspace):
        return False
    if kind == "probe":
        return set(data) == common | {"workspace"}
    providers = data.get("providers")
    return (set(data) == common | {"workspace", "installId", "providers"} and data["installId"] == identifier and
            isinstance(providers, list) and 1 <= len(providers) <= 4 and all(item in PROVIDERS for item in providers) and
            len(set(providers)) == len(providers))


def request_backend(command, request, runner=run_ssh):
    source = read_bounded(BASE / "RemoteVpsBackend.py", MAX_HELPER)
    kind = request["kind"]
    archive, digest = release_archive() if kind != "status" else (b"", "")
    source64 = base64.b64encode(source)
    config = base64.b64encode(json.dumps(request, ensure_ascii=False).encode("utf-8"))
    payload = (
        "import base64,json\n"
        f"source = base64.b64decode({source64!r})\n"
        "scope = {'__name__': 'workbench_vps_remote'}\n"
        "exec(compile(source, '<workbench-vps-install>', 'exec'), scope)\n"
        f"request = json.loads(base64.b64decode({config!r}))\n"
        f"archive = base64.b64decode({base64.b64encode(archive)!r})\n"
        f"reply = scope['dispatch'](request, archive, {digest!r}, source)\n"
        "print(json.dumps(reply, separators=(',', ':')), flush=True)\n"
    ).encode("ascii")
    remote = "python3 -I -B -"
    if kind == "probe":
        remote = "/bin/sh -c " + shlex.quote(PROBE) + " workbench-probe " + request["targetId"]
    options = [*command[:-1], remote]
    code, response = runner(options, payload, timeout=44, stdout_limit=16 * 1024)
    if code != 0:
        return 2
    value = json.loads(response)
    if not isinstance(value, dict) or type(value.get("ok")) is not bool:
        return 2
    if not value["ok"]:
        value = {"ok": False, "targetId": request["targetId"], "code": value.get("code")}
    sys.stdout.buffer.write(json.dumps(value, separators=(",", ":")).encode("utf-8"))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("host", "user", "identity", "known-hosts", "id"):
        parser.add_argument("--" + field, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    try:
        identifier = str(uuid.UUID(args.id))
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if not 0 < len(raw) <= MAX_REQUEST:
            return 2
        request = json.loads(raw)
        if not valid_request(request, identifier):
            return 2
        command = build_command(args.host, args.port, args.user, args.identity, args.known_hosts, identifier)
        return request_backend(command, request)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
