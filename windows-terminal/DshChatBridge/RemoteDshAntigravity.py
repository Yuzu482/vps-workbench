"""Run authenticated Antigravity ACP turns inside the VPS sandbox."""
import base64
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zlib

HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", re.ASCII)
CONVERSATION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", re.ASCII)
TURN_TIMEOUT = 615
MAX_AUTO_READS = 128
MAX_PERMISSION_REQUESTS = 256
SANDBOX_ENV = {"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"}
PRIVATE_PATH = re.compile(
    r"(?:^|[._-])(?:auth|credentials?|passwords?|secrets?|tokens?|api[-_]?key)(?:[._-]|$)"
    r"|(?:^id_(?:rsa|dsa|ecdsa|ed25519)$|\.(?:key|pem|pfx|p12)$)", re.IGNORECASE)


def allowed_hosts(value):
    hosts = value.get("hosts") if isinstance(value, dict) and set(value) == {"hosts"} else None
    if not isinstance(hosts, list) or not 1 <= len(hosts) <= 16:
        raise ValueError("invalid Antigravity hosts")
    if any(not isinstance(host, str) or len(host) > 253 or not HOST.fullmatch(host) or
           not (host.endswith(".googleapis.com") or host in ("antigravity.google", "accounts.google.com"))
           for host in hosts) or len(set(hosts)) != len(hosts):
        raise ValueError("invalid Antigravity host")
    return tuple(hosts)


def conversation_id(value):
    if not isinstance(value, str) or not CONVERSATION.fullmatch(value):
        raise ValueError("invalid Antigravity conversation ID")
    return value


def previous_conversation(binding, expected, session, workspace):
    if binding is None and expected is None:
        return None
    if (expected != session or not isinstance(binding, dict) or
            set(binding) not in ({"conversation", "workspace"}, {"conversation", "workspace", "protocol"}) or
            binding["workspace"] != workspace or binding.get("protocol", "legacy") not in ("legacy", "acp")):
        raise ValueError("Antigravity history mismatch")
    return conversation_id(binding["conversation"])


def sandbox_command(isolation, executable, work, profile, gate, previous, effort=None, mounts=None, credentials=(),
                    *, acp=False, model=None):
    prefix, separator, _ = isolation["RUNNER"].partition("input_data=None\n")
    if not separator:
        raise ValueError("incompatible sandbox runner")
    runner = prefix + r'''
env.pop('CODEX_HOME',None)
os.umask(0o077)
try:
 result=subprocess.run(['/opt/agy',*command],cwd='/workspace',env=env,
                       stderr=subprocess.DEVNULL,timeout=610)
finally:
 stopped.set(); listener.close()
sys.exit(result.returncode if result.returncode>=0 else 128-result.returncode)
'''
    args = ["acp", "--sandbox", "--disable-telemetry"] if acp else [
        "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "10m",
        "--disable-slash-commands", "--mode", "accept-edits" if mounts else "plan", "--sandbox"]
    if mounts:
        args.extend(("--add-dir", "/output", "--add-dir", "/attachments"))
        if acp:
            args.append("--include-default-customizations=false")
    if not acp:
        if previous is not None:
            args.extend(("--conversation", previous))
        if effort is not None:
            args.extend(("--effort", effort))
        if model is not None:
            args.extend(("--model", model))
    command = isolation["sandbox_command"](
        executable, mounts[0] if mounts else work, None, gate, args, provider="agy",
        overlays=None if mounts else [(str(profile), "/home/codex")], uploads=mounts[1] if mounts else None,
        runner_script=runner, read_only_workspace=True)
    if mounts:
        for fd, name in credentials:
            index = command.index("--")
            command[index:index] = ["--ro-bind", "/proc/self/fd/" + str(fd), "/home/codex/" + name]
    return command


def credential_files(workflow, manifest, profile, lifetime):
    if not isinstance(manifest, dict) or set(manifest) != {"files"} or not isinstance(manifest["files"], list) or not 1 <= len(manifest["files"]) <= 4:
        raise ValueError("missing Antigravity workflow credential manifest")
    entries = []
    size = 0
    opened = workflow["opened"]
    root = lifetime.enter_context(opened(profile, os.O_DIRECTORY | os.O_RDONLY))
    for name in manifest["files"]:
        parts = workflow["parts"](name)
        if (parts[-1] in ("settings.json", "AGENTS.md", "GEMINI.md") or any(existing == name for _, existing in entries)):
            raise ValueError("invalid credential file")
        parent = root
        for part in parts[:-1]:
            parent = lifetime.enter_context(opened(part, os.O_DIRECTORY | os.O_RDONLY, parent))
        fd = lifetime.enter_context(opened(parts[-1], os.O_PATH, parent))
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or
                info.st_nlink != 1 or info.st_size <= 0):
            raise ValueError("unsafe credential file")
        size += info.st_size
        if size > 4 * 1024 * 1024:
            raise ValueError("credential files too large")
        entries.append((fd, name))
    return entries


def consume(process, support, reply, previous):
    active = result = None
    deadline = time.monotonic() + TURN_TIMEOUT
    try:
        for frame in support["read_frames"](process):
            if time.monotonic() >= deadline:
                raise TimeoutError("Antigravity turn timed out")
            event = frame.get("event") if frame is not None else None
            if event == "init":
                observed = conversation_id(frame.get("conversation_id"))
                if active is not None or result is not None or (previous is not None and observed != previous):
                    raise ValueError("Antigravity session mismatch")
                active = observed
            elif event == "result":
                value = frame.get("result")
                if result is not None or not isinstance(value, dict):
                    raise ValueError("unexpected Antigravity result")
                result = value
                deadline = min(deadline, time.monotonic() + 10)
            if result is None and support["stop_requested"](reply.directory):
                process.terminate()
                return "stopped", None, None
    except EOFError:
        pass

    exit_code = process.wait(timeout=4)
    if not result:
        return "unknown", None, None
    status = result.get("status")
    if status in ("ERROR", "INVALID", "WAITING"):
        return "failed", None, None
    text = result.get("response")
    if (exit_code or status != "SUCCESS" or active is None or
            conversation_id(result.get("conversation_id")) != active or not isinstance(text, str)):
        return "unknown", None, None
    return "complete", active, text


class AcpStopped(Exception):
    pass


class AcpRejected(Exception):
    def __init__(self, reason):
        self.reason = reason


def acp_option(info, category):
    options = info.get("configOptions")
    if isinstance(options, list):
        return next((option for option in options if isinstance(option, dict) and
                     option.get("category") == category and option.get("type") == "select"), {})
    return {}


def acp_choices(option):
    choices = option.get("options")
    if isinstance(choices, list):
        for choice in choices:
            if isinstance(choice, dict):
                group = choice.get("options")
                for item in group if isinstance(group, list) else [choice]:
                    if isinstance(item, dict) and isinstance(item.get("value"), str):
                        yield item


def valid_model(model, support):
    return support["valid_choice"](model, 100, "_.:-") and model.startswith("gemini-")


def workspace_read_path(tool):
    args = tool.get("rawInput")
    if (not isinstance(args, dict) or tool.get("opaque") or tool.get("_meta") not in (None, {}) or
            tool.get("status") not in (None, "pending")):
        return None
    if tool.get("name") == "view_file" and tool.get("kind") == "read":
        if set(args) - {"AbsolutePath", "StartLine", "EndLine", "IsSkillFile"} or args.get("IsSkillFile", False) is not False:
            return None
        lines = [args[field] for field in ("StartLine", "EndLine") if field in args]
        if any(type(line) is not int or not 1 <= line <= 2147483647 for line in lines) or lines != sorted(lines):
            return None
        target, directory = args.get("AbsolutePath"), False
    elif tool.get("name") == "list_dir" and tool.get("kind") in ("read", "search") and set(args) == {"DirectoryPath"}:
        target, directory = args["DirectoryPath"], True
    else:
        return None
    if (not isinstance(target, str) or len(target) > 1024 or "\\" in target or not target.isprintable() or
            (target != "/workspace" and not target.startswith("/workspace/"))):
        return None
    locations = tool.get("locations")
    if locations is not None and (not isinstance(locations, list) or len(locations) > 8 or any(
            not isinstance(location, dict) or set(location) - {"path", "line"} or location.get("path") != target
            for location in locations)):
        return None
    parts = target.split("/")[2:]
    if (not parts and not directory) or len(parts) > 24 or any(
            not part or part.startswith(".") or PRIVATE_PATH.search(part) for part in parts):
        return None
    return parts, directory


def workspace_identity(info):
    return info.st_dev, info.st_ino


def ordinary_workspace_read(tool, workspace_binding):
    target = workspace_read_path(tool)
    if target is None:
        return False
    parts, directory = target
    workspace, identity = workspace_binding
    flags = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        with contextlib.ExitStack() as opened:
            fd = os.open(workspace, flags)
            opened.callback(os.close, fd)
            if workspace_identity(os.fstat(fd)) != identity:
                return False
            device = identity[0]
            for part in parts if directory else parts[:-1]:
                fd = os.open(part, flags, dir_fd=fd)
                opened.callback(os.close, fd)
                if os.fstat(fd).st_dev != device:
                    return False
            if directory:
                return True
            info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
            return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_dev == device
    except OSError:
        return False


class AcpTurn:
    def __init__(self, process, support, reply, workbench_session, *, read_only_workspace=None, design=False):
        self.process, self.support, self.reply = process, support, reply
        self.workbench_session = workbench_session
        self.design = design
        self.frames = support["read_frames"](process)
        self.session = None
        self.identifier = 0
        self.submitted = False
        self.cancel_deadline = None
        self.approvals = self.steering = self.supplement = None
        self.supplement_sent = False
        self.permissions, self.tool_details, self.tool_requests = {}, {}, {}
        self.read_only_workspace = read_only_workspace
        self.auto_reads = set()
        self.permission_ids = set()
        self.mcp_prefixes = ()

    def enable_controls(self):
        mailbox = self.support["ApprovalMailbox"](self.reply.directory)
        mailbox.enable()
        self.approvals = mailbox
        self.steering = self.support["SteeringMailbox"](self.reply.directory)
        self.reply.steer_ready = False

    def close_controls(self, cancel=False):
        if self.approvals is None:
            return
        self.reply.set_steer_ready(False)
        if self.reply.dirty:
            self.reply.publish("running", self.workbench_session)
        self.steering.close()
        self.approvals.close()
        if cancel:
            for identifier, _, _ in self.permissions.values():
                self.permission_outcome(identifier, None)
        self.permissions.clear()

    def write(self, packet):
        data = json.dumps({"jsonrpc": "2.0", **packet}, ensure_ascii=True, separators=(",", ":"))
        self.process.stdin.write(data.encode("ascii") + b"\n")
        self.process.stdin.flush()

    def request(self, method, params, timeout=35):
        def stopped():
            return self.reply is not None and self.support["stop_requested"](self.reply.directory)

        if stopped():
            raise AcpStopped()
        prompt = method == "session/prompt"
        if prompt:
            self.submitted = True
        identifier = self.issue(method, params)
        active_note = None
        deadline = time.monotonic() + timeout
        for frame in self.frames:
            if frame is not None and frame.get("jsonrpc") != "2.0":
                raise ValueError("invalid Antigravity ACP version")
            if (frame is not None and "method" not in frame and
                    type(frame.get("id")) is int and frame["id"] == identifier):
                if active_note is not None:
                    self.settle_note(active_note, frame)
                error = frame.get("error")
                if isinstance(error, dict):
                    message = error.get("message")
                    auth = (error.get("code") == -32000 and isinstance(message, str) and
                            "authentication required" in message.lower())
                    reason = "agy_auth" if auth else (
                        "agy_rejected" if self.submitted else "agy_acp")
                    raise AcpRejected(reason)
                if not isinstance(frame.get("result"), dict):
                    raise ValueError("invalid Antigravity ACP result")
                if prompt and self.supplement:
                    # agy can finish the superseded RPC before streaming the revised reply.
                    # Continue the same Workbench turn with the already dispatched supplement.
                    identifier, active_note = self.supplement
                    self.supplement = None
                    for receipt in tuple(self.permissions):
                        self.withdraw_permission(receipt)
                    self.reply.set_steer_ready(False)
                    if "usage" not in frame["result"] and self.cancel_deadline is None and not stopped():
                        self.reply.update("antigravity", "", replace=True)
                    self.reply.publish("running", self.workbench_session)
                    continue
                return frame["result"]
            now = time.monotonic()
            if now >= deadline or (self.cancel_deadline is not None and now >= self.cancel_deadline):
                raise TimeoutError("Antigravity ACP request timed out")
            if stopped():
                if not self.submitted:
                    raise AcpStopped()
                if self.cancel_deadline is None:
                    self.cancel_deadline = now + 5
                    self.write({"method": "session/cancel", "params": {"sessionId": self.session}})
                    self.close_controls(cancel=True)
            if frame is not None and self.supplement and "method" not in frame:
                self.settle_supplement(frame)
            if frame is not None and "method" in frame:
                self.incoming(frame)
            if prompt and self.approvals is not None and self.cancel_deadline is None and not stopped():
                self.dispatch_controls()
            if self.reply is not None and self.reply.dirty and now - self.reply.last_write >= 0.2:
                self.reply.publish("running", self.workbench_session)
        raise EOFError("Antigravity ACP closed")

    def issue(self, method, params):
        self.identifier += 1
        self.write({"id": self.identifier, "method": method, "params": params})
        return self.identifier

    def prompt_params(self, text):
        return {"sessionId": self.session, "prompt": [{"type": "text", "text": text}]}

    def dispatch_controls(self):
        approval = self.approvals.claim() if self.permissions else None
        if approval:
            identifier, options, _ = self.permissions.pop(approval["id"])
            stopped = self.dispatch_permission(identifier, options.get(approval["decision"]))
            self.approvals.settle(approval["id"], "closed" if stopped else "submitted")
        if self.supplement is None and self.reply.steer_ready:
            note = self.steering.claim()
            if note:
                if self.support["stop_requested"](self.reply.directory):
                    self.steering.settle(note["id"], "rejected")
                    return
                identifier = self.issue("session/prompt", self.prompt_params(note["prompt"]))
                self.supplement = identifier, note["id"]
                self.supplement_sent = True

    def settle_supplement(self, frame):
        identifier, note = self.supplement
        if type(frame.get("id")) is not int or frame["id"] != identifier:
            return
        self.settle_note(note, frame)
        self.supplement = None

    def settle_note(self, note, frame):
        result = frame.get("result")
        reason = result.get("stopReason") if isinstance(result, dict) else None
        if isinstance(frame.get("error"), dict):
            state = "rejected"
        elif reason in ("end_turn", "max_tokens", "max_turn_requests", "refusal"):
            state = "submitted"
        else:
            state = "unknown"
        self.steering.settle(note, state)

    def permission_outcome(self, identifier, option):
        outcome = {"outcome": "selected", "optionId": option} if option else {"outcome": "cancelled"}
        self.write({"id": identifier, "result": {"outcome": outcome}})

    def dispatch_permission(self, identifier, option):
        # The stop marker and dispatch use the same lock on this turn.
        with self.support["chat_lock"](self.approvals.lock):
            stopped = self.support["stop_requested"](self.reply.directory)
            self.permission_outcome(identifier, None if stopped else option)
        return stopped

    def withdraw_permission(self, receipt):
        request, _, _ = self.permissions.pop(receipt)
        self.approvals.settle(receipt, "closed")
        self.permission_outcome(request, None)

    def remember_tool(self, tool_id, update, *, exact_frame=True):
        if tool_id in self.auto_reads:
            return None
        previous = self.tool_details.get(tool_id, {})
        if previous is None or (tool_id not in self.tool_details and len(self.tool_details) >= 32):
            return None
        fields = ("title", "name", "kind", "status", "rawInput", "locations")
        current = {**previous, **{key: update[key] for key in fields if key in update}}
        # A v1 permission can refer to its earlier tool_call by ID alone. Preserve any
        # ambiguity across updates so a later partial frame cannot make it auto-eligible.
        opaque = (not exact_frame or set(update) - {*fields, "sessionUpdate", "toolCallId", "_meta", "content", "rawOutput"} or
                  update.get("_meta") not in (None, {}) or update.get("content") not in (None, []) or
                  update.get("rawOutput") is not None or
                  (not previous and update.get("sessionUpdate") == "tool_call_update") or
                  any(key in previous and key in update and previous[key] != update[key] for key in fields[1:]))
        if opaque:
            current["opaque"] = True
        if len(json.dumps(current, ensure_ascii=True)) > 16384:
            current = None
        if previous != current:
            for receipt, (_, _, source) in tuple(self.permissions.items()):
                if source == tool_id:
                    self.withdraw_permission(receipt)
        self.tool_details[tool_id] = current
        return current

    def permission(self, identifier, params, *, exact_frame=False):
        valid = self.support["valid_id"]
        tool = params.get("toolCall") if isinstance(params, dict) else None
        tool_id = tool.get("toolCallId") if isinstance(tool, dict) else None
        known = (valid(tool_id) and self.tool_requests.get(tool_id) == identifier and
                 any(request == identifier for request, _, _ in self.permissions.values()))
        if identifier in self.permission_ids and not known:
            return
        if len(self.permission_ids) >= MAX_PERMISSION_REQUESTS and not known:
            self.permission_outcome(identifier, None)
            return
        self.permission_ids.add(identifier)
        if not self.submitted or self.cancel_deadline is not None or (
                not isinstance(params, dict) or params.get("sessionId") != self.session):
            self.permission_outcome(identifier, None)
            return
        offered = params.get("options")
        if not isinstance(offered, list) or len(offered) > 16:
            offered = []
        pairs = [(item.get("kind"), item["optionId"]) for item in offered
                 if isinstance(item, dict) and valid(item.get("optionId"))]
        options = {decision: next((value for kind, value in pairs if kind == option and
                                  sum(o == value for _, o in pairs) == 1), None)
                   for decision, option in (("allow", "allow_once"), ("deny", "reject_once"))}
        if self.approvals is None:
            # The stage's registered servers are the only MCP namespace in this sandbox.
            name = tool.get("name") if isinstance(tool, dict) and tool.get("kind") == "other" else None
            allowed = valid(tool_id) and valid(name) and any(
                name.startswith(prefix) and len(name) > len(prefix) for prefix in self.mcp_prefixes)
            stopped = self.support["stop_requested"](self.reply.directory)
            option = None
            if allowed and options["allow"] and not stopped:
                prior = self.tool_requests.get(tool_id)
                if prior == identifier:
                    return
                if prior is None and len(self.tool_requests) < 128:
                    self.tool_requests[tool_id] = identifier
                    option = options["allow"]
            self.permission_outcome(identifier, option)
            return
        if valid(tool_id) and tool_id in self.auto_reads:
            self.permission_outcome(identifier, None)
            return
        if known:
            self.remember_tool(tool_id, tool)
        elif not valid(tool_id) or tool_id in self.tool_requests or len(self.tool_requests) >= self.support["MAX_APPROVALS"]:
            self.permission_outcome(identifier, None)
            return
        if known:
            for receipt, (request, previous, _) in tuple(self.permissions.items()):
                if request == identifier and previous != options:
                    self.withdraw_permission(receipt)
            return
        if not offered:
            self.permission_outcome(identifier, None)
            return
        operation = self.remember_tool(tool_id, tool)
        single_allow = sum(isinstance(item, dict) and item.get("kind") == "allow_once" for item in offered) == 1
        if (exact_frame and self.read_only_workspace is not None and operation is not None and options["allow"] and
                len(self.auto_reads) < MAX_AUTO_READS and single_allow and not self.supplement_sent and
                params.get("_meta") in (None, {}) and not (params.keys() - {"sessionId", "toolCall", "options", "_meta"}) and
                ordinary_workspace_read(operation, self.read_only_workspace)):
            self.auto_reads.add(tool_id)
            self.tool_details.pop(tool_id, None)
            self.dispatch_permission(identifier, options["allow"])
            return
        title, detail, kind, described = self.support["approval_display"](operation or {})
        receipt = self.approvals.add(title, detail, kind, bool(options["allow"] and described))
        if receipt is None:
            self.permission_outcome(identifier, None)
            return
        self.tool_requests[tool_id] = identifier
        self.permissions[receipt] = identifier, options, tool_id
        self.reply.set_steer_ready(False)
        if self.reply.dirty:
            self.reply.publish("running", self.workbench_session)

    def incoming(self, frame):
        method = frame.get("method")
        if "id" in frame:
            # This client delegates neither file system access nor terminal execution.
            identifier = frame["id"]
            if type(identifier) is not int and not self.support["valid_id"](identifier):
                raise ValueError("invalid Antigravity ACP callback")
            if method == "session/request_permission":
                self.permission(identifier, frame.get("params"),
                                exact_frame=frame.keys() == {"jsonrpc", "id", "method", "params"})
            else:
                self.write({"id": identifier, "error": {"code": -32601, "message": "Method not available"}})
            return
        params = frame.get("params")
        if (method != "session/update" or not self.submitted or not isinstance(params, dict) or
                params.get("sessionId") != self.session):
            return
        update = params.get("update")
        if isinstance(update, dict) and self.approvals is not None and self.cancel_deadline is None:
            event = update.get("sessionUpdate")
            if not self.permissions and event in ("agent_message_chunk", "agent_thought_chunk", "plan"):
                self.reply.set_steer_ready(True)
            tool_id = update.get("toolCallId")
            if event in ("tool_call", "tool_call_update") and self.support["valid_id"](tool_id):
                self.remember_tool(tool_id, update, exact_frame=(
                    frame.keys() == {"jsonrpc", "method", "params"} and params.keys() == {"sessionId", "update"}))
        if isinstance(update, dict) and update.get("sessionUpdate") == "usage_update" and type(update.get("size")) is int:
            self.reply.observe_usage({"last": {"totalTokens": update.get("used")}, "modelContextWindow": update["size"]})
        if isinstance(update, dict) and update.get("sessionUpdate") == "agent_message_chunk":
            content = update.get("content")
            if isinstance(content, dict) and content.get("type") == "text" and isinstance(content.get("text"), str):
                text = content["text"]
                if self.supplement_sent and not self.design:
                    # Keep the newest output visible even when the first part filled the local reply limit.
                    limit = self.reply.maximum
                    prefix = "…\n\n"
                    previous = self.reply.items.get("antigravity", "")
                    combined = previous + text[-limit:]
                    encoded = combined.encode("utf-16-le", "replace")
                    if len(encoded) > limit * 2 or len(text) > limit:
                        suffix_bytes = max(0, limit - len(prefix)) * 2
                        combined = prefix + encoded[len(encoded) - suffix_bytes:].decode("utf-16-le", "ignore")
                    self.reply.update("antigravity", combined, replace=True)
                else:
                    self.reply.update("antigravity", text, replace=False)

    def open(self, previous, mcp_servers=()):
        info = self.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        if type(info.get("protocolVersion")) is not int or info["protocolVersion"] != 1:
            raise AcpRejected("agy_acp")
        # In ACP v1, stdio is the default transport and has no wire discriminator.
        self.mcp_prefixes = tuple(f"mcp_{server['name']}_" for server in mcp_servers)
        parameters = {"cwd": "/workspace", "mcpServers": [
            {key: server[key] for key in ("name", "command", "args", "env")} for server in mcp_servers]}
        if previous is None:
            session = self.request("session/new", parameters)
            self.session = conversation_id(session.get("sessionId"))
            return session
        capabilities = info.get("agentCapabilities")
        if not isinstance(capabilities, dict) or capabilities.get("loadSession") is not True:
            raise AcpRejected("agy_acp")
        self.session = previous
        return self.request("session/load", {"sessionId": previous, **parameters})

    def configure(self, info, category, requested):
        if requested is None:
            return info
        option = acp_option(info, category)
        identifier = option.get("id")
        if not self.support["valid_id"](identifier):
            raise AcpRejected("agy_options")
        selected = next((choice["value"] for choice in acp_choices(option)
                         if (choice["value"].lower() if category == "thought_level" else choice["value"]) == requested), None)
        if not self.support["valid_id"](selected):
            raise AcpRejected("agy_options")
        if option.get("currentValue") != selected:
            info = self.request("session/set_config_option", {"sessionId": self.session, "configId": identifier,
                                                            "value": selected})
            if acp_option(info, category).get("currentValue") != selected:
                raise AcpRejected("agy_options")
        return info

    def allow_workflow_edits(self, info):
        modes = info.get("modes", {})
        available = modes.get("availableModes") if isinstance(modes, dict) else None
        if not isinstance(available, list) or not any(isinstance(item, dict) and item.get("id") == "accept-edits"
                                                      for item in available):
            raise AcpRejected("agy_workflow_mode")
        if modes.get("currentModeId") != "accept-edits":
            self.request("session/set_mode", {"sessionId": self.session, "modeId": "accept-edits"})


def consume_acp(process, support, reply, previous, workbench_session, prompt, effort, model=None, workflow=False,
                mcp_servers=(), interactive=False, *, read_only_workspace=None, design=False):
    turn = AcpTurn(process, support, reply, workbench_session,
                   read_only_workspace=read_only_workspace if interactive and not workflow else None, design=design)
    try:
        if interactive and not workflow:
            turn.enable_controls()
        info = turn.open(previous, mcp_servers)
        if workflow:
            # The workflow sandbox already grants only the output mount for writes.
            turn.allow_workflow_edits(info)
        info = turn.configure(info, "model", model)
        info = turn.configure(info, "thought_level", effort)
        active_model = acp_option(info, "model").get("currentValue")
        if active_model is not None and not valid_model(active_model, support):
            raise AcpRejected("agy_options")
        reply.observe_options(active_model, acp_option(info, "thought_level").get("currentValue"))
        outcome = turn.request("session/prompt", turn.prompt_params(prompt), timeout=TURN_TIMEOUT - 75)
        reason = outcome.get("stopReason")
        if reason == "cancelled":
            return "stopped", turn.session, None
        if reason == "end_turn" and reply.items.get("antigravity"):
            if design and reply.clipped_items:
                return "failed", None, "agy_limit"
            return "complete", turn.session, None
        if reason == "end_turn" and turn.approvals is not None and any(
                row["state"] == "submitted" and row["decision"] == "deny" for row in turn.approvals.read() or []):
            return "stopped", turn.session, None
        if reason in ("max_tokens", "max_turn_requests"):
            return "failed", None, "agy_limit"
        return "failed", None, "agy_rejected"
    except AcpStopped:
        return "stopped", None, None
    except AcpRejected as error:
        return "failed", None, error.reason
    except (OSError, ValueError, EOFError, subprocess.SubprocessError):
        return ("unknown", None, None) if turn.submitted else ("failed", None, "agy_acp")
    finally:
        with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
            turn.close_controls()


def profile_paths(environment, isolation, support, workspace):
    home = Path(environment["HOME"]).resolve(strict=True)
    root = home / ".dsh-antigravity"
    profile = root / "home"
    for directory in (root, profile):
        support["require_private"](directory.lstat(), stat.S_ISDIR)
    isolation["check_workspace"](str(profile))
    hosts = allowed_hosts(support["read_private_json"](root / "hosts.json", 4096))
    path = shutil.which("agy", path=environment.get("PATH")) or str(home / ".local/bin/agy")
    executable, work, _ = isolation["validate_paths"](path, workspace, environment, provider="agy")
    for utility in ("/usr/bin/bwrap", "/usr/bin/python3"):
        if not os.access(utility, os.X_OK):
            raise ValueError("missing isolation utility")
    return root, profile, hosts, executable, work


@contextlib.contextmanager
def profile_lock(root, support):
    fd = os.open(root / "profile.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        support["require_private"](os.fstat(lock.fileno()), stat.S_ISREG)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield lock


def route_ready(privacy, config, environment, hosts, checks):
    expected4 = privacy["address"](config["expectedIpv4"], 4)
    expected6 = privacy["address"](config["expectedIpv6"], 6) if config["expectedIpv6"] else None
    with contextlib.redirect_stdout(checks):
        return privacy["preflight"](expected4, expected6, environment, service_hosts=hosts)


def catalog(config, privacy, isolation, support):
    """Read account-specific ACP options without sending a model prompt."""
    if set(config) != {"workspace", "expectedIpv4", "expectedIpv6"}:
        raise ValueError("invalid Antigravity catalog request")
    environment = privacy["clean_environment"](os.environ)
    root, profile, hosts, executable, _ = profile_paths(environment, isolation, support, config["workspace"])
    if not route_ready(privacy, config, environment, hosts, io.StringIO()):
        raise ValueError("Antigravity egress unavailable")
    with profile_lock(root, support) as lock, tempfile.TemporaryDirectory(prefix="antigravity-catalog-") as directory:
        work, gate = (Path(directory) / name for name in ("work", "gate"))
        work.mkdir(mode=0o700)
        gate.mkdir(mode=0o700)
        with isolation["Gateway"](str(gate / "proxy.sock"), isolation["global_connection"], hosts):
            command = sandbox_command(isolation, executable, str(work), profile, str(gate), None, acp=True)
            command[1:1] = ["--sync-fd", str(lock.fileno())]
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       env=SANDBOX_ENV, pass_fds=(lock.fileno(),))
            try:
                info = AcpTurn(process, support, None, None).open(None)
            except AcpRejected:
                raise ValueError("Antigravity catalog unavailable") from None
            finally:
                support["close_server"](process)
    option = acp_option(info, "model")
    models = {}
    for choice in acp_choices(option):
        model, name = choice["value"], choice.get("name")
        if (not valid_model(model, support) or not isinstance(name, str) or not name.strip() or
                len(name) > 80 or not name.isprintable() or len(name.encode("utf-16-le")) > 160):
            continue
        models[model] = {"id": model, "displayName": name.strip(), "isDefault": model == option.get("currentValue"),
                         "efforts": [], "defaultEffort": None}
        if len(models) == 64:
            break
    if not models:
        raise ValueError("Antigravity catalog has no available models")
    return list(models.values())


def run(privacy, isolation, support, config, reply, workflow=None, extensions=None):
    environment = privacy["clean_environment"](os.environ)
    session, expected = config["sessionId"], config["threadId"]
    stopped = support["stop_requested"]
    launched = False
    reason = "agy_setup"
    try:
        if "workflowFiles" in config and workflow is None:
            return "failed", None, reason
        if stopped(reply.directory):
            return "stopped", expected, None
        root, profile, hosts, executable, work = profile_paths(environment, isolation, support, config["workspace"])
        checks = io.StringIO()
        ready = route_ready(privacy, config, environment, hosts, checks)
        reply.checks = [line[:320] for line in checks.getvalue().splitlines()
                        if line.startswith(("IPv4 出口：", "IPv6：", "服务域名", "隐私检查未通过"))][:4]
        if stopped(reply.directory):
            return "stopped", expected, None
        if not ready:
            return "failed", None, "egress"

        threads = isolation["chat_directory"](root, "threads", True)
        binding = threads / (session + ".json")
        with profile_lock(root, support) as lock:
            reason = "agy_session"
            saved = support["read_private_json"](binding, 4096)
            previous = previous_conversation(saved, expected, session, work)
            acp = saved is None or saved.get("protocol") == "acp"
            if config.get("design") and not acp:
                return "failed", None, "agy_acp"
            effort = config.get("advanced", {}).get("reasoningEffort")
            model = config.get("model")
            with tempfile.TemporaryDirectory(prefix="antigravity-gate-") as gate, contextlib.ExitStack() as lifetime:
                reason = "agy_setup"
                credentials, mounts = (), None
                mcp_servers = []
                sandbox_work = work
                if workflow:
                    if extensions and config["extensions"]["mcpServers"]:
                        reason = "mcp_setup"
                        mcp_servers = extensions["prepare"](gate, environment["HOME"],
                                                            config["extensions"]["mcpServers"], acp=True)
                        reason = "agy_setup"
                    manifest = support["read_private_json"](root / "workflow-credentials.json", 4096)
                    credentials = credential_files(workflow, manifest, profile, lifetime)
                    temporary = lifetime.enter_context(tempfile.TemporaryDirectory(prefix="workflow-inputs-"))
                    mounts = workflow["prepare"](config["workflowFiles"], config["workspace"], environment["HOME"],
                                                 config["taskId"], temporary, isolated=config.get("workspaceAccess") == "isolated")
                elif config.get("workspaceAccess") == "isolated":
                    sandbox_work = lifetime.enter_context(tempfile.TemporaryDirectory(prefix="antigravity-empty-"))
                with isolation["Gateway"](os.path.join(gate, "proxy.sock"), isolation["global_connection"], hosts):
                    read_binding = None
                    if acp and not workflow:
                        info = os.stat(sandbox_work, follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            read_binding = sandbox_work, workspace_identity(info)
                    command = sandbox_command(isolation, executable, sandbox_work, profile, gate, previous,
                                              effort, mounts, credentials, acp=acp, model=model)
                    command[1:1] = ["--sync-fd", str(lock.fileno())]
                    if stopped(reply.directory):
                        return "stopped", expected, None
                    reply.publish("running", expected)
                    prompt = config["prompt"]
                    if config.get("memoryText"):
                        prompt += "\n\n--- Begin Workbench reference data ---\n" + config["memoryText"]
                        prompt += "\n--- End Workbench reference data ---"
                    incoming = subprocess.PIPE
                    if not acp:
                        # Existing headless conversations keep their original input format.
                        message = {"event": "user", "message": {"content": prompt}}
                        data = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                        incoming = lifetime.enter_context(os.fdopen(os.memfd_create("dsh-agy-input", os.MFD_CLOEXEC), "w+b"))
                        incoming.write(data)
                        incoming.seek(0)
                    options = dict(stdin=incoming, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=SANDBOX_ENV, pass_fds=(lock.fileno(), *(fd for fd, _ in credentials)))
                    process = (lifetime.enter_context(workflow["output_process"](command, mounts[2], **options))
                               if workflow else subprocess.Popen(command, **options))
                    launched = True
                    try:
                        if acp:
                            state, native, reason = consume_acp(
                                process, support, reply, previous, session, prompt, effort, model,
                                workflow=bool(workflow), mcp_servers=mcp_servers, interactive=not workflow,
                                read_only_workspace=read_binding, design=config.get("design") is True)
                        else:
                            state, native, text = consume(process, support, reply, previous)
                            reason = "agy_rejected" if state == "failed" else None
                            if state == "complete":
                                reply.update("antigravity", text, replace=True)
                    finally:
                        support["close_server"](process)
                    if native is not None and state in ("complete", "stopped"):
                        if previous is None:
                            mapping = {"conversation": native, "workspace": work}
                            if acp:
                                mapping["protocol"] = "acp"
                            support["write_private_json"](binding, mapping, durable=True)
                        return state, session, None
                    return state, expected if state == "stopped" else None, reason
    except (OSError, ValueError, KeyError, TypeError, EOFError, subprocess.SubprocessError):
        return ("unknown", None, None) if launched else ("failed", None, reason)


def load_support(encoded):
    limit = 56 * 1024  # Match MaxStreamHelper in CodexStream.cs.
    packed = base64.b64decode(encoded, validate=True)
    decoder = zlib.decompressobj()
    code = decoder.decompress(packed, limit + 1)
    if len(code) > limit or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError("invalid Antigravity helper")
    scope = {"__name__": "remote_dsh_chat_support"}
    exec(compile(code, "<remote-dsh-chat-support>", "exec"), scope)
    return scope


def main():
    limit = 1280 * 1024
    payload = sys.stdin.buffer.read(limit + 1)
    if len(payload) > limit:
        raise ValueError("Antigravity request too large")
    config = json.loads(payload)
    required = {
            "sessionId", "taskId", "threadId", "workspace", "expectedIpv4", "expectedIpv6",
            "prompt", "design", "designContext", "support"
    }
    options = {"extensions", "extensionsHelper", "memoryIsolation", "advanced", "model", "workspaceAccess", "workflowFiles",
               "workflowHelper", "privacyHelper"}
    if (not isinstance(config, dict) or not required <= config.keys() or config.keys() - required - options or
            type(config["design"]) is not bool or ("workflowFiles" in config and config["design"])):
        raise ValueError("invalid Antigravity request")
    code = config.pop("support")
    if not isinstance(code, str) or not 0 < len(code) <= 20 * 1024:
        raise ValueError("invalid Antigravity support")
    support = load_support(code)
    if "model" in config and not valid_model(config["model"], support):
        raise ValueError("invalid Antigravity model")
    if config.get("workspaceAccess") not in (None, "read-only", "isolated"):
        raise ValueError("invalid Antigravity workspace access")
    support["advanced_options"](config, "antigravity")
    workflow = support["workflow_helper"](config)
    extensions = support["project_memory"](config, expanded=True, allow_mcp=workflow is not None)
    privacy = support["load_helper"](config.pop("privacyHelper") if sys.argv[2] == "-" else sys.argv[2], "antigravity_privacy")
    isolation = support["load_helper"](sys.argv[3], "antigravity_isolation")
    task = support["uuid_text"](config["taskId"])
    session = support["uuid_text"](config["sessionId"])
    if config["threadId"] is not None and config["threadId"] != session:
        raise ValueError("invalid Antigravity history")
    prompt = config["prompt"]
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8192 or "\0" in prompt:
        raise ValueError("invalid Antigravity message")
    parts = support["design_inputs"](config)
    if config["design"]:
        if any(part["type"] != "text" for part in parts):
            raise ValueError("Antigravity design supports text references only")
        config["prompt"] = "\n\n".join([support["DESIGN_INSTRUCTIONS"], *(part["text"] for part in parts)])
        config.pop("memoryText", None)  # Already included by design_inputs.
    directory = Path.home() / ".local/state/remote-ssh/tasks" / task
    reply = support["Reply"](directory, task, support["MAX_DESIGN_REPLY" if config["design"] else "MAX_REPLY"])
    state, thread, reason = run(privacy, isolation, support, config, reply, workflow, extensions)
    reply.publish(state, thread, reason)
    return 0 if state in ("complete", "stopped") else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, IndexError, TypeError, zlib.error):
        raise SystemExit(2)
