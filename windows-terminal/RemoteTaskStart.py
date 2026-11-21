#!/usr/bin/env python3
"""Explicitly submit one non-interactive remote task under a caller-supplied UUID.

The SSH start is attempted once. On an uncertain result, query the same UUID;
never generate a replacement ID or resend the operation automatically.
"""
import argparse
import base64
import ipaddress
import json
from pathlib import Path
import posixpath
import subprocess
import sys
import uuid
import zlib

import RemoteTaskStatus as status

MAX_HELPER = 20000
MAX_PAYLOAD = 32768
MAX_CHAT_PAYLOAD = 1280 * 1024


def use_outer_sandbox_only(command):
    """Select Codex's unrestricted inner mode only inside the outer sandbox."""
    if len(command) < 2 or posixpath.basename(command[0].replace("\\", "/")) != "codex" or command[1] != "exec":
        raise ValueError("outer-only mode requires codex exec")
    conflicting = ("--full-auto", "--approve-for-me", "--yolo", "--dangerously-bypass-approvals-and-sandbox",
                   "--sandbox", "--config", "--profile")
    prefixes = ("--sandbox=", "--config=", "--profile=", "-s", "-c", "-p")
    if any(item in conflicting or item.startswith(prefixes) for item in command[2:]):
        raise ValueError("outer-only mode conflicts with sandbox, approval, or config options")
    return command[:2] + ["--sandbox", "danger-full-access"] + command[2:]


def wrap_privacy(command, expected4, expected6=None, isolation_workspace=None):
    ip4 = ipaddress.ip_address(expected4)
    ip6 = ipaddress.ip_address(expected6) if expected6 else None
    if ip4.version != 4 or (ip6 is not None and (ip6.version != 6 or ip6.scope_id)):
        raise ValueError("invalid expected address")
    helper = (Path(__file__).resolve().parent / "RemoteCodexPrivacy.py").read_bytes()
    if not helper or len(helper) > MAX_HELPER:
        raise ValueError("invalid privacy helper")
    encoded = base64.b64encode(zlib.compress(helper, 9)).decode("ascii")
    script = f"import base64,zlib;exec(zlib.decompress(base64.b64decode('{encoded}')))"
    if len(script) > 8192:
        raise ValueError("privacy helper is too large")
    result = ["python3", "-B", "-c", script, "--expected-ipv4", str(ip4)]
    if ip6 is not None:
        result += ["--expected-ipv6", str(ip6)]
    if isolation_workspace is not None:
        source = (Path(__file__).resolve().parent / "RemoteCodexIsolate.py").read_bytes()
        if not source or len(source) > 32768:
            raise ValueError("invalid isolation helper")
        code = base64.b64encode(zlib.compress(source, 9)).decode("ascii")
        if len(code) > 12288:
            raise ValueError("isolation helper is too large")
        result += ["--isolation-code", code, "--isolation-workspace", isolation_workspace]
    return result + ["--"] + command


def read_local_request(stream, chat_stream=False):
    """Read one bounded request without placing the command in process arguments."""
    limit = MAX_CHAT_PAYLOAD if chat_stream else MAX_PAYLOAD
    raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("task request is too large")
    value = json.loads(raw.decode("utf-8"))
    fields = {"command", "cwd", "capture"}
    if chat_stream and isinstance(value, dict) and "chatInput" in value and isinstance(value["chatInput"], dict):
        fields.add("chatInput")
    elif len(raw) > MAX_PAYLOAD:
        raise ValueError("task request is too large")
    if (not isinstance(value, dict) or set(value) != fields or
            not isinstance(value["command"], list) or
            any(not isinstance(item, str) for item in value["command"]) or
            (value["cwd"] is not None and not isinstance(value["cwd"], str)) or
            type(value["capture"]) is not bool):
        raise ValueError("invalid task request")
    return value


def build_start(command, helper, identifier, state_dir=None, chat_stream=False):
    if not helper or len(helper) > MAX_HELPER:
        raise ValueError("invalid helper size")
    encoded = base64.b64encode(helper).decode("ascii")
    program = f'import base64;exec(base64.b64decode("{encoded}"))'
    remote = f"python3 -B -c '{program}' start --id {identifier}"
    if state_dir is not None:
        remote += " --state-dir-b64 " + status.encode_remote_root(state_dir)
    remote += " --payload-stdin"
    if chat_stream:
        remote += " --chat-stream"
    return [*command[:-1], remote]


def submit_once(command, payload, identifier, runner=status.run_ssh):
    try:
        code, raw = runner(command, payload)
    except (OSError, subprocess.SubprocessError):
        code, raw = None, b""
    try:
        value = json.loads(raw.decode("utf-8"))
        if (isinstance(value, dict) and value.get("task_id") == identifier and
                ((code == 0 and value.get("outcome") == "accepted") or
                 (code == 3 and value.get("outcome") == "already_exists"))):
            return value, code
    except (ValueError, UnicodeError):
        pass
    return {"task_id": identifier, "outcome": "unknown", "reason": "start_result_unconfirmed",
            "next": "query_status_with_same_id"}, 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--user", required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--known-hosts", required=True)
    parser.add_argument("--id", help="Optional existing task UUID; the receipt supplies one otherwise")
    parser.add_argument("--receipt", required=True, help="Absolute local path for the task receipt")
    parser.add_argument("--state-dir", help="Optional absolute Linux state directory")
    parser.add_argument("--cwd", help="Optional absolute Linux working directory")
    parser.add_argument("--capture-output", action="store_true")
    parser.add_argument("--privacy-ipv4", help="Expected VPS IPv4; required for direct codex commands")
    parser.add_argument("--privacy-ipv6", help="Optional expected VPS IPv6")
    parser.add_argument("--isolate-workspace", help="Run codex exec isolated with this absolute Linux project directory")
    parser.add_argument("--outer-only", action="store_true", help="Use only outer isolation; Codex inner sandbox disabled, workspace writable")
    parser.add_argument("--request-stdin", action="store_true",
                        help="Read command, working directory and capture flag as JSON from stdin")
    parser.add_argument("--chat-stream", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    identifier = None
    try:
        chat_input = None
        candidate = str(uuid.UUID(args.id)) if args.id is not None else str(uuid.uuid4())
        if args.request_stdin:
            if args.command or args.cwd is not None or args.capture_output:
                raise ValueError("stdin request cannot be mixed with command options")
            request = read_local_request(sys.stdin.buffer, args.chat_stream)
            task_command, cwd, capture = request["command"], request["cwd"], request["capture"]
            chat_input = request.get("chatInput")
        else:
            task_command = args.command[1:] if args.command[:1] == ["--"] else args.command
            cwd, capture = args.cwd, args.capture_output
        if args.chat_stream and (not args.request_stdin or not capture or args.state_dir is not None):
            raise ValueError("invalid chat stream request")
        if (not task_command or len(task_command) > 64 or not task_command[0] or
                any("\x00" in item or len(item) > 12288 for item in task_command)):
            raise ValueError("invalid command")
        if args.privacy_ipv6 and not args.privacy_ipv4:
            raise ValueError("IPv6 check also requires expected IPv4")
        if args.outer_only:
            if args.isolate_workspace is None:
                raise ValueError("outer-only mode requires an isolated workspace")
            task_command = use_outer_sandbox_only(task_command)
        if args.isolate_workspace is not None:
            if (not args.privacy_ipv4 or not posixpath.isabs(args.isolate_workspace) or
                    len(args.isolate_workspace) > 2048 or "\x00" in args.isolate_workspace or
                    posixpath.basename(task_command[0].replace("\\", "/")) != "codex" or task_command[1:2] != ["exec"] or
                    (cwd is not None and cwd != args.isolate_workspace)):
                raise ValueError("invalid isolated task")
            cwd = args.isolate_workspace
        if task_command and posixpath.basename(task_command[0].replace("\\", "/")).lower() == "codex" and not args.privacy_ipv4:
            raise ValueError("direct codex requires privacy check")
        if args.privacy_ipv4:
            task_command = wrap_privacy(task_command, args.privacy_ipv4, args.privacy_ipv6, args.isolate_workspace)
        if (not task_command or len(task_command) > 64 or not task_command[0] or
                any("\x00" in item or len(item) > 12288 for item in task_command)):
            raise ValueError("invalid command")
        if cwd is not None and (not posixpath.isabs(cwd) or len(cwd) > 2048 or "\x00" in cwd):
            raise ValueError("working directory must be an absolute Linux path")
        request = {"command": task_command, "cwd": cwd, "capture": capture}
        if chat_input is not None:
            request["chatInput"] = chat_input
        payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > (MAX_CHAT_PAYLOAD if chat_input is not None else MAX_PAYLOAD):
            raise ValueError("task payload is too large")
        helper = (Path(__file__).resolve().parent / "RemoteTask.py").read_bytes()
        # Validate target and key paths before creating or using the receipt.
        status.build_command(args.host, args.port, args.user, args.identity, args.known_hosts, candidate, args.state_dir)
        identifier = status.receipt_id(args.receipt, args.host, args.port, args.user, args.state_dir,
                                       proposed=args.id, create=True)
        base = status.build_command(args.host, args.port, args.user, args.identity, args.known_hosts,
                                    identifier, args.state_dir)
        command = build_start(base, helper, identifier, args.state_dir, args.chat_stream)
        result, code = submit_once(command, payload, identifier)
    except (OSError, ValueError, UnicodeError):
        result, code = {"task_id": identifier, "outcome": "not_sent", "reason": "invalid_configuration"}, 2
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
