"""Native session discovery and launch arguments; no authentication or network setup.

The caller must supply an already isolated process environment and workspace.
This module does not establish the SSH, egress or PTY privacy boundary.
"""
import hashlib
import json
import os
import posixpath
import select
import subprocess
import time
import uuid


class NativeSessionError(Exception):
    pass


def isolated_workspace_path(canonical_workspace):
    """Return a stable in-sandbox location for a validated remote workspace.

    The caller must first resolve symlinks and validate ownership/mounts on the
    remote host. The digest is an identifier, not a secret or anonymization.
    Old `/workspace` records cannot be assigned to a host project from this ID.
    """
    if (not isinstance(canonical_workspace, str) or not canonical_workspace.startswith("/") or
            canonical_workspace.startswith("//") or canonical_workspace == "/" or
            posixpath.normpath(canonical_workspace) != canonical_workspace or
            "\x00" in canonical_workspace or len(canonical_workspace.encode("utf-8")) > 4096):
        raise ValueError("expected a canonical remote workspace")
    digest = hashlib.sha256(("dsh-native-workspace-v1\0" + canonical_workspace).encode("utf-8")).hexdigest()
    return "/workspaces/" + digest


def _session_id(value):
    if not isinstance(value, str):
        raise ValueError("invalid native session ID")
    try:
        identifier = uuid.UUID(value)
        if identifier.int == 0:
            raise ValueError()
        parsed = str(identifier)
    except (ValueError, AttributeError):
        raise ValueError("invalid native session ID") from None
    if value != parsed:
        raise ValueError("invalid native session ID")
    return parsed


def interactive_args(provider, mode, session_id=None):
    """Build a fixed argv for the native TUI; never interpolate a shell command.

    `picker` and `resume` start a new UI process. Neither restores an interrupted
    process or resubmits the input that was in flight when it disconnected.
    """
    if provider == "claude" and mode == "login" and session_id is None:
        return ["claude", "auth", "login"]
    if provider not in ("codex", "claude") or mode not in ("new", "picker", "resume"):
        raise ValueError("unsupported native session operation")
    if mode == "resume":
        session_id = _session_id(session_id)
    elif session_id is not None:
        raise ValueError("unexpected native session ID")
    if provider == "codex":
        if mode == "new":
            return ["codex"]
        if mode == "picker":
            return ["codex", "resume", "--include-non-interactive"]
        return ["codex", "resume", session_id]
    if mode == "new":
        return ["claude"]
    return ["claude", "--resume"] + ([session_id] if session_id else [])


class CodexCatalog:
    """Bounded JSONL client for Codex app-server initialize and thread/list.

    Only metadata is returned and no session is resumed. Never use with an
    untrusted executable or without the caller's isolated HOME and network.
    """
    def __init__(self, executable, cwd, environment, config=(), timeout=30, allow_legacy=False):
        if not isinstance(executable, str) or not os.path.isabs(executable) or not isinstance(cwd, str) or not os.path.isabs(cwd):
            raise ValueError("expected absolute executable and workspace")
        if type(allow_legacy) is not bool:
            raise ValueError("invalid legacy option")
        if cwd == "/workspace" and not allow_legacy:
            # Older managed sessions use this same mount for every project;
            # filtering on it cannot establish which host workspace they used.
            raise ValueError("legacy workspace path is ambiguous")
        if not 0 < timeout <= 60:
            raise ValueError("invalid timeout")
        self.executable, self.cwd, self.environment = executable, cwd, environment
        self.config, self.timeout = list(config), timeout

    def list(self):
        try:
            process = subprocess.Popen([self.executable, "app-server", "--stdio", *self.config], cwd=self.cwd,
                                       env=self.environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL)
        except OSError as error:
            raise NativeSessionError("app-server process unavailable") from error
        pending = b""

        def send(value):
            process.stdin.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
            process.stdin.flush()

        def receive(request_id):
            nonlocal pending
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not line:
                        continue
                    try:
                        message = json.loads(line)
                    except (ValueError, UnicodeError):
                        raise NativeSessionError("invalid app-server response") from None
                    if not isinstance(message, dict):
                        raise NativeSessionError("invalid app-server response")
                    if message.get("id") == request_id:
                        if "error" in message or not isinstance(message.get("result"), dict):
                            raise NativeSessionError("app-server rejected request")
                        return message["result"]
                ready, _, _ = select.select([process.stdout], [], [], max(0, deadline-time.monotonic()))
                if not ready:
                    break
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                if len(pending) > 4 * 1024 * 1024:
                    raise NativeSessionError("app-server response too large")
            raise NativeSessionError("app-server request incomplete")

        try:
            send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "dsh-native-sessions", "version": "1"}}})
            receive(1)
            send({"method": "initialized", "params": {}})
            result, cursor, seen, cursors = [], None, set(), set()
            # Codex defaults to interactive sources. Include exec so managed
            # CLI sessions created in earlier versions are not silently hidden.
            for page in range(10):
                params = {"limit": 100, "cwd": self.cwd, "sourceKinds": ["cli", "exec"], "modelProviders": []}
                if cursor is not None:
                    params["cursor"] = cursor
                send({"id": page + 2, "method": "thread/list", "params": params})
                response = receive(page + 2)
                data = response.get("data")
                if not isinstance(data, list) or len(data) > 100:
                    raise NativeSessionError("invalid session list")
                for item in data:
                    if not isinstance(item, dict):
                        raise NativeSessionError("invalid session metadata")
                    try:
                        session_id = _session_id(item.get("id"))
                    except ValueError:
                        raise NativeSessionError("invalid native session ID") from None
                    if session_id in seen:
                        raise NativeSessionError("duplicate native session ID")
                    seen.add(session_id)
                    result.append(session_id)
                if "nextCursor" not in response:
                    raise NativeSessionError("incomplete session list")
                cursor = response["nextCursor"]
                if cursor is None:
                    return result
                if not isinstance(cursor, str) or not cursor or len(cursor) > 4096 or cursor in cursors:
                    raise NativeSessionError("invalid session cursor")
                cursors.add(cursor)
            raise NativeSessionError("session list exceeded page limit")
        except (OSError, BrokenPipeError) as error:
            raise NativeSessionError("app-server process unavailable") from error
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            process.stdin.close()
            process.stdout.close()
