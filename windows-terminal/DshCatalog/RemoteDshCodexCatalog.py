"""Read the model catalog through the isolated VPS Codex App Server."""

import contextlib
import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


MAX_MODELS = 64
MAX_PAGES = 8
MODEL_ID = re.compile(r"[A-Za-z0-9_.:-]{1,100}")
EFFORT = re.compile(r"[A-Za-z0-9_-]{1,24}")


def project_model(value):
    if not isinstance(value, dict) or value.get("hidden") is not False:
        return None
    model = value.get("model")
    label = value.get("displayName")
    if (not isinstance(model, str) or not MODEL_ID.fullmatch(model) or
            not isinstance(label, str) or not label.strip() or len(label) > 80 or
            not label.isprintable() or len(label.encode("utf-16-le")) > 160 or
            type(value.get("isDefault")) is not bool):
        return None
    options = value.get("supportedReasoningEfforts")
    efforts = []
    if isinstance(options, list):
        for option in options[:8]:
            effort = option.get("reasoningEffort") if isinstance(option, dict) else None
            if isinstance(effort, str) and EFFORT.fullmatch(effort) and effort not in efforts:
                efforts.append(effort)
    default = value.get("defaultReasoningEffort")
    return {
        "id": model,
        "displayName": label.strip(),
        "isDefault": value["isDefault"],
        "efforts": efforts,
        "defaultEffort": default if default in efforts else None,
    }


def response(frames, identifier, deadline):
    for packet in frames:
        if time.monotonic() >= deadline:
            raise TimeoutError("model catalog timed out")
        if packet is None or "id" not in packet:
            continue
        result = packet.get("result")
        if ("method" in packet or type(packet["id"]) is not int or packet["id"] != identifier or
                "error" in packet or not isinstance(result, dict)):
            raise ValueError("invalid model catalog response")
        return result
    raise EOFError("model catalog closed before replying")


def read_models(process, stream):
    send = stream["send"]
    deadline = time.monotonic() + 16
    with contextlib.closing(stream["read_frames"](process)) as frames:
        send(process, "initialize", {"clientInfo": {
            "name": "dsh_vps_catalog",
            "title": "DSH VPS model catalog",
            "version": "0.9.0",
        }}, 1)
        response(frames, 1, deadline)
        send(process, "initialized", {})
        models = {}
        seen_cursors = set()
        params = {"includeHidden": False, "limit": MAX_MODELS}
        for identifier in range(2, MAX_PAGES + 2):
            send(process, "model/list", params, identifier)
            page = response(frames, identifier, deadline)
            items = page.get("data")
            if not isinstance(items, list) or len(items) > params["limit"]:
                raise ValueError("invalid model catalog page")
            for item in items:
                model = project_model(item)
                if model is not None and (model["id"] not in models or model["isDefault"]):
                    models[model["id"]] = model

            cursor = page.get("nextCursor")
            if cursor is None or len(models) == MAX_MODELS:
                if not models:
                    raise ValueError("model catalog has no available models")
                return list(models.values())
            if (not isinstance(cursor, str) or not 0 < len(cursor) <= 512 or
                    not cursor.isprintable() or cursor in seen_cursors):
                raise ValueError("invalid model catalog cursor")
            seen_cursors.add(cursor)
            params = {"includeHidden": False, "limit": MAX_MODELS - len(models), "cursor": cursor}
    raise ValueError("model catalog pagination limit reached")


def catalog(config, privacy, isolation, stream):
    """Project the native picker without starting a conversation or a turn."""
    try:
        if not isinstance(config, dict) or set(config) != {"workspace", "expectedIpv4", "expectedIpv6"}:
            raise ValueError()
        workspace = config["workspace"]
        ipv4 = config["expectedIpv4"]
        ipv6 = config["expectedIpv6"]
        if (not isinstance(workspace, str) or not workspace.startswith("/") or
                len(workspace.encode("utf-16-le")) > 4096 or
                any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in workspace) or
                not isinstance(ipv4, str) or (ipv6 is not None and not isinstance(ipv6, str))):
            raise ValueError()
        environment = privacy["clean_environment"](os.environ)
        expected4 = privacy["address"](ipv4, 4)
        expected6 = privacy["address"](ipv6, 6) if ipv6 is not None else None
        with contextlib.redirect_stdout(io.StringIO()):
            if not privacy["preflight"](expected4, expected6, environment):
                raise ValueError()

        executable_path = shutil.which("codex", path=environment.get("PATH"))
        executable_path = executable_path or str(Path(environment["HOME"]) / ".local/bin/codex")
        executable, _, auth = isolation["validate_paths"](executable_path, workspace, environment)
        if not os.lstat(auth).st_size:
            raise ValueError()
        with tempfile.TemporaryDirectory(prefix="codex-catalog-") as directory:
            home, work, gate = (Path(directory) / name for name in ("home", "work", "gate"))
            for entry in (home, work, gate):
                entry.mkdir(mode=0o700)
            (home / "auth.json").touch(mode=0o600, exist_ok=False)
            (gate / "codex-config.toml").touch(mode=0o600, exist_ok=False)
            with isolation["Gateway"](str(gate / "proxy.sock"), isolation["global_connection"], isolation["ALLOWED_HOSTS"]):
                command = isolation["sandbox_command"](
                    executable, str(work), auth, str(gate), ["app-server", "--listen", "stdio://"],
                    str(home), codex_stdio=True,
                )
                process = subprocess.Popen(
                    command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    env={"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"},
                )
                try:
                    return read_models(process, stream)
                finally:
                    stream["close_server"](process)
    except (OSError, ValueError, KeyError, EOFError, subprocess.SubprocessError):
        raise ValueError("model catalog unavailable") from None
