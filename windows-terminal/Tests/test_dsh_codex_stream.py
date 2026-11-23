import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid
import zlib


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform == "linux", "VPS launcher imports Linux file controls")
class SubscriptionLimitTests(unittest.TestCase):
    def test_weekly_only_and_sparse_limits(self):
        base = Path(__file__).resolve().parents[1]
        stream = load("chat_stream_limits", base / "DshChatBridge/RemoteDshCodexStream.py")
        reply = object.__new__(stream.Reply)
        reply.subscription_limits = {}
        reply.observe_codex_limits({"primary": {
            "windowDurationMins": 10080, "usedPercent": 100, "resetsAt": 2000000000,
        }})
        reply.observe_codex_limits({"limitId": "other", "primary": {
            "windowDurationMins": 300, "usedPercent": 20, "resetsAt": 2000000000,
        }})
        self.assertEqual(reply.subscription_limits, {"weekly": {"usedPercent": 100, "resetsAt": 2000000000}})
        reply.observe_codex_limits({"primary": {
            "windowDurationMins": 300, "usedPercent": 15, "resetsAt": 2000000000,
        }})
        reply.observe_subscription_limit("weekly", float("nan"), 2000000000)
        self.assertEqual(reply.subscription_limits["fiveHour"]["usedPercent"], 15)
        self.assertEqual(reply.subscription_limits["weekly"]["usedPercent"], 100)


@unittest.skipUnless(sys.platform == "linux", "VPS launcher imports Linux file controls")
class AdvancedOptionTests(unittest.TestCase):
    def test_remote_options_are_typed_and_provider_specific(self):
        stream = load("chat_stream", Path(__file__).resolve().parents[1] / "DshChatBridge/RemoteDshCodexStream.py")
        for provider, options in (
                ("codex", {"verbosity": "low"}),
                ("claude-sdk", {"maxOutputTokens": 1024, "reasoningEffort": "medium"}),
                ("claude-sdk", {"maxOutputTokens": 65536}),
                ("antigravity", {"reasoningEffort": "high"})):
            with self.subTest(provider=provider, options=options):
                self.assertEqual(stream.advanced_options({"advanced": options}, provider), options)
                self.assertEqual(stream.advanced_options({}, provider), {})
                with self.assertRaises(ValueError):
                    stream.advanced_options({"advanced": options, "memoryExtraction": True}, provider)
                with self.assertRaises(ValueError):
                    stream.advanced_options({"advanced": options}, provider, expanded=False)
        for provider, options in (
                ("codex", None), ("codex", {}), ("codex", {"verbosity": "max"}),
                ("codex", {"reasoningEffort": "high"}), ("codex", {"verbosity": "low", "temperature": 1}),
                ("claude-sdk", {"reasoningEffort": ["low"]}), ("claude-sdk", {"maxOutputTokens": True}),
                ("claude-sdk", {"maxOutputTokens": 1024.0}), ("claude-sdk", {"maxOutputTokens": "1024"}),
                ("claude-sdk", {"maxOutputTokens": 1023}), ("claude-sdk", {"maxOutputTokens": 65537}),
                ("antigravity", {"reasoningEffort": "xhigh"}), ("antigravity", {"maxOutputTokens": 1024})):
            with self.subTest(provider=provider, options=options), self.assertRaises(ValueError):
                stream.advanced_options({"advanced": options}, provider)


@unittest.skipUnless(sys.platform == "linux", "VPS control uses Linux process and file semantics")
class StreamControlTests(unittest.TestCase):
    def setUp(self):
        base = Path(__file__).resolve().parents[1]
        self.stream = load("chat_stream", base / "DshChatBridge/RemoteDshCodexStream.py")
        self.task = load("chat_task", base / "RemoteTask.py")
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.task.DEFAULT_ROOT = Path(temp)
        self.identifier = str(uuid.uuid4())
        self.directory = self.task.DEFAULT_ROOT / self.identifier
        self.directory.mkdir(mode=0o700)
        self.thread = str(uuid.uuid4())
        self.turn = str(uuid.uuid4())

    def control(self, action, identifier=None, request=None):
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(self.stream.sys, "stdout", output):
            self.assertEqual(self.stream.remote_control(vars(self.task), action, identifier or self.identifier, request), 0)
        return json.loads(output.buffer.getvalue())

    def reserve(self, directory, supported, phase="reserved"):
        self.task.write_record(directory, {"version": 1, "task_id": directory.name, "phase": phase,
                                           "chat_stream": supported, "exit_code": 0})

    def test_stop_is_idempotent_and_scoped_to_new_task(self):
        self.reserve(self.directory, True)
        another = self.task.DEFAULT_ROOT / str(uuid.uuid4())
        another.mkdir(mode=0o700)
        self.reserve(another, False)
        self.assertEqual(self.control("stop")["outcome"], "requested")
        marker = self.directory / "chat-stop"
        first = marker.stat()
        self.assertEqual(self.control("stop")["outcome"], "requested")
        self.assertEqual(first.st_ino, marker.stat().st_ino)
        self.assertEqual(self.control("snapshot")["state"], "pending")
        self.assertTrue(self.control("snapshot")["stop_requested"])
        self.assertNotIn("outcome", self.control("stop", another.name))
        self.assertFalse((another / "chat-stop").exists())

    def conversation(self):
        return self.stream.Conversation(self.stream.Reply(self.directory, self.identifier),
                                        {"threadId": None, "prompt": "test prompt"})

    def handshake(self):
        yield {"id": 1, "result": {}}
        yield {"id": 2, "result": {"thread": {"id": self.thread}}}
        yield {"id": 3, "result": {"turn": {"id": self.turn}}}

    def test_stop_before_dispatch_never_starts_turn(self):
        def frames(_):
            yield {"id": 1, "result": {}}
            (self.directory / "chat-stop").touch(mode=0o600)
            yield {"id": 2, "result": {"thread": {"id": self.thread}}}

        driver = self.conversation()
        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
            self.assertEqual(driver.drive(object()), "stopped")
        self.assertFalse(driver.dispatched)
        self.assertNotIn("turn/start", [call.args[1] for call in writes.call_args_list])

    def test_interrupt_ack_without_terminal_proves_no_stop(self):
        def frames(_):
            yield from self.handshake()
            (self.directory / "chat-stop").touch(mode=0o600)
            yield {"id": 4, "result": {}}
            raise EOFError()

        driver = self.conversation()
        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
            with self.assertRaises(EOFError):
                driver.drive(object())
        interrupts = [call.args[2] for call in writes.call_args_list if call.args[1] == "turn/interrupt"]
        self.assertEqual(interrupts, [{"threadId": self.thread, "turnId": self.turn}])

    def test_matching_completion_wins_late_stop(self):
        def frames(_):
            yield from self.handshake()
            (self.directory / "chat-stop").touch(mode=0o600)
            yield {"method": "turn/completed", "params": {"threadId": self.thread,
                   "turn": {"id": self.turn, "status": "completed"}}}

        driver = self.conversation()
        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
            self.assertEqual(driver.drive(object()), "complete")
        self.assertNotIn("turn/interrupt", [call.args[1] for call in writes.call_args_list])

    def test_design_configures_native_thread_without_mutating_user_text(self):
        def completed(_):
            yield from self.handshake()
            yield {"method": "turn/completed", "params": {"threadId": self.thread,
                   "turn": {"id": self.turn, "status": "completed"}}}

        delivery = '画板交付 · 限定图层修订\n<meta name="dsh-layer-revision" content=\'{}\'>'
        reply = self.stream.Reply(self.directory, self.identifier, design=True)
        driver = self.stream.Conversation(reply, {
            "threadId": None, "prompt": "test prompt", "design": True,
            "designContext": {"text": delivery, "images": []},
        })
        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", completed):
            self.assertEqual(driver.drive(object()), "complete")
        thread = next(call.args[2] for call in writes.call_args_list if call.args[1] == "thread/start")
        self.assertEqual(thread["sandbox"], "read-only")
        self.assertEqual(thread["approvalPolicy"], "never")
        self.assertEqual(thread["developerInstructions"], self.stream.DESIGN_INSTRUCTIONS)
        for rule in ("all original artboards", "single-artboard revision", "exactly two complete", "in its <head>",
                     "Copy base and layer exactly", "closed html fence", "14,000 characters", "390 px"):
            self.assertIn(rule, " ".join(thread["developerInstructions"].split()))
        turn = next(call.args[2] for call in writes.call_args_list if call.args[1] == "turn/start")
        self.assertEqual(turn["input"][0]["text"], "test prompt")
        self.assertTrue(turn["input"][1]["text"].endswith(delivery))

    def test_complete_fenced_reply_at_utf16_limit_stays_intact(self):
        maximum = self.stream.MAX_REPLY
        self.assertEqual(maximum, 8192)
        opening = "```vps-workflow\n"
        draft = {"name": "示例😀", "stages": [{"name": "写作", "provider": "codex", "model": "", "instruction": "写作。"}]}
        closing = json.dumps(draft, ensure_ascii=False, separators=(",", ":")) + "\n```"
        padding = " " * (maximum - len(opening) - len(closing) - 1)
        answer = opening + padding + closing
        reply = self.stream.Reply(self.directory, self.identifier)
        reply.update("answer", opening + padding, replace=False)
        reply.update("answer", closing, replace=False)
        reply.publish("complete", self.thread)
        self.assertEqual(len(answer.encode("utf-16-le")) // 2, maximum)
        self.assertEqual(self.stream.read_snapshot(self.directory)["reply"], answer)

    def test_reply_stops_at_emoji_boundary_until_authoritative_replacement(self):
        prefix = "中" * (self.stream.MAX_REPLY - 1)
        reply = self.stream.Reply(self.directory, self.identifier)
        reply.update("answer", prefix, replace=False)
        reply.update("answer", "😀", replace=False)
        reply.update("answer", "x", replace=False)
        reply.update("later", "later item", replace=False)
        reply.publish("running", self.thread)
        self.assertEqual(self.stream.read_snapshot(self.directory)["reply"], prefix)
        reply.update("answer", prefix + "✓", replace=True)
        reply.publish("complete", self.thread)
        self.assertEqual(self.stream.read_snapshot(self.directory)["reply"], prefix + "✓")

    def test_snapshot_bounds_entire_reply_across_message_items(self):
        reply = self.stream.Reply(self.directory, self.identifier)
        prefix = "中" * (self.stream.MAX_REPLY - 3)
        reply.update("first", prefix, replace=True)
        reply.update("second", "😀 text", replace=True)
        reply.publish("complete", self.thread)
        self.assertEqual(self.stream.read_snapshot(self.directory)["reply"], prefix + "\n\n")

    def test_memory_extraction_sends_scope_rules_schema_and_explicit_options(self):
        source = {"prompt": "确认项目图标定稿为 32×32", "reply": "收到。"}
        evidence = json.dumps(source, ensure_ascii=False)
        answer = '{"memories":[{"title":"图标尺寸","text":"项目图标定稿为 32×32 像素。"}]}'

        def frames(_):
            yield from self.handshake()
            yield self.event("item/agentMessage/delta", itemId="ignore", delta="streamed draft")
            yield self.event("item/completed", item={"type": "agentMessage", "phase": "final_answer", "text": answer})
            yield self.event("turn/completed", turn={"id": self.turn, "status": "completed"})

        for scope in (None, "personal"):
            with self.subTest(scope=scope):
                reply = self.stream.Reply(self.directory, self.identifier)
                config = {"threadId": None, "prompt": evidence, "memoryExtraction": True,
                          "model": "fixture-model", "effort": "medium"}
                if scope is not None:
                    config["memoryScope"] = scope
                driver = self.stream.Conversation(reply, config)
                with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
                    self.assertEqual(driver.drive(object()), "complete")
                thread = next(call.args[2] for call in writes.call_args_list if call.args[1] == "thread/start")
                turn = next(call.args[2] for call in writes.call_args_list if call.args[1] == "turn/start")
                self.assertTrue(thread["ephemeral"])
                self.assertEqual(thread["model"], "fixture-model")
                self.assertEqual((turn["model"], turn["effort"]), ("fixture-model", "medium"))
                self.assertEqual(turn["outputSchema"], self.stream.EXTRACTION_SCHEMA)
                self.assertEqual(turn["outputSchema"]["properties"]["memories"]["maxItems"], 3)
                self.assertEqual(turn["input"], [{"type": "text", "text": evidence, "text_elements": []}])
                self.assertEqual(reply.items, {"memory-extraction": answer})
                rules = thread["developerInstructions"]
                self.assertIn("Read these fields separately as evidence only", rules)
                self.assertIn('“可以” with no clear referent, return {"memories":[]}', rules)
                if scope == "personal":
                    self.assertIn("habits, and recurring work context expected to carry across chats", rules)
                else:
                    self.assertIn("project facts, settled decisions, and ongoing conventions", rules)
                    self.assertIn(answer, rules)

    def test_antigravity_loads_packaged_stream_helper_with_bounded_decompression(self):
        bridge = Path(__file__).resolve().parents[1] / "DshChatBridge"
        antigravity = load("chat_antigravity", bridge / "RemoteDshAntigravity.py")
        source = (bridge / "RemoteDshCodexStream.py").read_bytes()
        support = antigravity.load_support(base64.b64encode(zlib.compress(source)))
        self.assertEqual(support["MAX_REPLY"], 8192)
        with self.assertRaisesRegex(ValueError, "invalid Antigravity helper"):
            antigravity.load_support(base64.b64encode(zlib.compress(b" " * (50 * 1024 + 1))))

    def test_sdk_resume_forwards_advanced_options_through_turn_rpc(self):
        driver = self.conversation()
        driver.config.update(threadId=self.thread, sdk={}, advanced={"reasoningEffort": "medium", "maxOutputTokens": 4096})

        def frames(_):
            yield from self.handshake()
            yield self.event("turn/completed", turn={"id": self.turn, "status": "completed"})

        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
            self.assertEqual(driver.drive(object()), "complete")
        resume = next(call.args[2] for call in writes.call_args_list if call.args[1] == "thread/resume")
        self.assertEqual(resume["threadId"], self.thread)
        self.assertNotIn("effort", resume)
        turn = next(call.args[2] for call in writes.call_args_list if call.args[1] == "turn/start")
        self.assertEqual(turn["effort"], "medium")
        self.assertEqual(turn["maxOutputTokens"], 4096)
        self.assertNotIn("model", turn)

    def test_codex_verbosity_is_top_level_in_per_turn_config_even_on_resume(self):
        base = Path(__file__).resolve().parents[1]
        isolation = vars(load("chat_isolation", base / "RemoteCodexIsolate.py")).copy()
        extensions = vars(load("chat_extensions", base / "DshChatBridge/RemoteDshExtensions.py"))
        registry = self.directory / ".config/vps-workbench/mcp"
        registry.mkdir(mode=0o700, parents=True)
        tool = registry / "fixture.py"
        tool.write_text("pass\n", encoding="utf-8")
        tool.chmod(0o600)
        home = str(self.directory / "codex-home")
        config = {"sessionId": self.thread, "prompt": "test", "workspace": str(self.directory),
                  "expectedIpv4": "192.0.2.1", "expectedIpv6": None, "memoryIsolation": True}
        privacy = {"clean_environment": lambda _: {"PATH": "/usr/bin", "HOME": str(self.directory)},
                   "address": lambda value, _: value, "preflight": lambda *_: True}
        isolation.update(validate_paths=lambda *_: ("/fixture/codex", str(self.directory), "/auth.json"),
                         chat_paths=lambda *_: (self.directory, home, None),
                         Gateway=lambda *_: contextlib.nullcontext())

        for thread, level, mcp in ((None, "low", False), (self.thread, "high", True), (self.thread, None, False)):
            with self.subTest(thread=thread, level=level):
                payload = dict(config, threadId=thread)
                if level is not None:
                    payload["advanced"] = {"verbosity": level}
                if mcp:
                    payload["extensions"] = {"mcpServers": ["fixture"]}
                gates = []

                def launch(command, **_):
                    target = command.index("/home/codex/.codex/config.toml")
                    self.assertEqual(command[target - 2], "--ro-bind")
                    config_path = Path(command[target - 1])
                    observed = tomllib.loads(config_path.read_text(encoding="utf-8"))
                    self.assertEqual(observed.get("model_verbosity"), level)
                    self.assertEqual(observed["features"], {"memories": False})
                    self.assertEqual(observed["memories"], {"use_memories": False, "generate_memories": False})
                    if mcp:
                        self.assertTrue(observed["mcp_servers"]["fixture"]["required"])
                    else:
                        self.assertNotIn("mcp_servers", observed)
                    gates.append(config_path.parent)
                    return object()

                reply = self.stream.Reply(self.directory, self.identifier)
                with (
                    patch.object(self.stream.subprocess, "Popen", side_effect=launch),
                    patch.object(self.stream.Conversation, "drive", return_value="complete"),
                    patch.object(self.stream, "close_server"),
                ):
                    self.assertEqual(self.stream.run(privacy, isolation, payload, reply, extensions if mcp else None),
                                     ("complete", None, None))
                self.assertEqual(len(gates), 1)
                self.assertFalse(gates[0].exists())

    def test_antigravity_effort_keeps_existing_conversation_and_sandbox(self):
        base = Path(__file__).resolve().parents[1]
        antigravity = load("chat_antigravity", base / "DshChatBridge/RemoteDshAntigravity.py")
        launch = Mock()
        isolation = {"RUNNER": "input_data=None\n", "sandbox_command": launch}
        antigravity.sandbox_command(isolation, "/opt/agy", "/project", "/profile", "/gate", "saved-conversation", "medium")
        args = launch.call_args.args[4]
        self.assertIn("--sandbox", args)
        self.assertEqual(args[-4:], ["--conversation", "saved-conversation", "--effort", "medium"])
        self.assertTrue(launch.call_args.kwargs["read_only_workspace"])

    def test_antigravity_acp_streams_and_cancels_without_granting_client_access(self):
        base = Path(__file__).resolve().parents[1]
        antigravity = load("chat_antigravity", base / "DshChatBridge/RemoteDshAntigravity.py")
        reply = self.stream.Reply(self.directory, self.identifier)
        process = SimpleNamespace(stdin=io.BytesIO())
        stopping = False
        now = 1000.0

        def frames(_):
            nonlocal stopping, now
            yield {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}}
            yield {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": self.thread}}
            yield {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": self.thread,
                   "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "first"}}}}
            now += 0.25
            yield {"jsonrpc": "2.0", "id": "permission", "method": "session/request_permission"}
            yield {"jsonrpc": "2.0", "id": "file", "method": "fs/read_text_file"}
            self.assertEqual(self.stream.read_snapshot(self.directory)["reply"], "first")
            self.assertEqual(self.stream.read_snapshot(self.directory)["thread_id"], self.identifier)
            stopping = True
            yield None
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "cancelled"}}

        support = dict(vars(self.stream), read_frames=frames, stop_requested=lambda _: stopping)
        with patch.object(antigravity.time, "monotonic", side_effect=lambda: now):
            self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "test", None),
                             ("stopped", self.thread, None))
        requests = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertEqual(requests[0]["params"]["clientCapabilities"], {})
        self.assertEqual(requests[1]["params"], {"cwd": "/workspace", "mcpServers": []})
        self.assertEqual(requests[2]["params"]["prompt"], [{"type": "text", "text": "test"}])
        self.assertEqual(requests[3]["result"]["outcome"], {"outcome": "cancelled"})
        self.assertEqual(requests[4]["error"]["code"], -32601)
        self.assertEqual(requests[5]["method"], "session/cancel")

    def test_antigravity_acp_restores_history_and_checks_effort_before_prompt(self):
        base = Path(__file__).resolve().parents[1]
        antigravity = load("chat_antigravity", base / "DshChatBridge/RemoteDshAntigravity.py")
        reply = self.stream.Reply(self.directory, self.identifier)
        process = SimpleNamespace(stdin=io.BytesIO())
        option = {"id": "thinking", "category": "thought_level", "type": "select", "currentValue": "Low",
                  "options": [{"value": "Low"}, {"value": "High"}]}
        model = {"id": "model", "category": "model", "type": "select", "currentValue": "gemini-first",
                 "options": [{"name": "Gemini", "options": [{"value": "gemini-first"}, {"value": "gemini-second"}]}]}
        selected = dict(model, currentValue="gemini-second")

        def update(text):
            return {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": self.thread,
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}}

        frames = [
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}},
            update("history"),
            {"jsonrpc": "2.0", "id": 2, "result": {"configOptions": [model, option]}},
            {"jsonrpc": "2.0", "id": 3, "result": {"configOptions": [selected, option]}},
            {"jsonrpc": "2.0", "id": 4, "result": {"configOptions": [selected, dict(option, currentValue="High")]}},
            update("new answer"),
            {"jsonrpc": "2.0", "id": 5, "result": {"stopReason": "end_turn"}},
        ]
        support = dict(vars(self.stream), read_frames=lambda _: iter(frames))
        self.assertEqual(
            antigravity.consume_acp(process, support, reply, self.thread, self.identifier, "test", "high", "gemini-second"),
            ("complete", self.thread, None))
        requests = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertEqual(requests[1]["method"], "session/load")
        self.assertEqual(requests[2]["params"]["value"], "gemini-second")
        self.assertEqual(requests[3]["params"]["value"], "High")
        self.assertEqual(reply.items, {"antigravity": "new answer"})

    def test_antigravity_acp_auth_rejection_precedes_model_submission(self):
        base = Path(__file__).resolve().parents[1]
        antigravity = load("chat_antigravity", base / "DshChatBridge/RemoteDshAntigravity.py")
        reply = self.stream.Reply(self.directory, self.identifier)
        process = SimpleNamespace(stdin=io.BytesIO())
        support = dict(vars(self.stream), read_frames=lambda _: iter([
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
            {"jsonrpc": "2.0", "id": 2, "error": {"code": -32000, "message": "Authentication required"}},
        ]))
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, None, "test", None),
                         ("failed", None, "agy_auth"))
        self.assertNotIn(b"session/prompt", process.stdin.getvalue())

    def test_antigravity_acp_only_settles_terminal_responses(self):
        base = Path(__file__).resolve().parents[1]
        antigravity = load("chat_antigravity", base / "DshChatBridge/RemoteDshAntigravity.py")
        for stop_reason, expected in (("end_turn", ("complete", self.thread, None)),
                                      ("max_tokens", ("failed", None, "agy_limit")),
                                      (None, ("unknown", None, None))):
            with self.subTest(stop_reason=stop_reason):
                process = SimpleNamespace(stdin=io.BytesIO())
                reply = self.stream.Reply(self.directory, self.identifier)
                stopping = False

                def frames(_):
                    nonlocal stopping
                    yield {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}}
                    yield {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": self.thread}}
                    yield {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": self.thread,
                           "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "part"}}}}
                    stopping = True
                    if stop_reason is None:
                        yield None
                        raise EOFError()
                    yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": stop_reason}}

                support = dict(vars(self.stream), read_frames=frames, stop_requested=lambda _: stopping)
                self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "test", None),
                                 expected)
                self.assertEqual(b"session/cancel" in process.stdin.getvalue(), stop_reason is None)

    def acp_fixture(self):
        base = Path(__file__).resolve().parents[1]
        antigravity = load("chat_antigravity", base / "DshChatBridge/RemoteDshAntigravity.py")
        process = SimpleNamespace(stdin=io.BytesIO())
        reply = self.stream.Reply(self.directory, self.identifier)
        self.reserve(self.directory, True, "running")
        self.enterContext(patch.object(self.task, "inspect", return_value={"state": "running"}))
        return antigravity, process, reply

    def acp_update(self, **update):
        return {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": self.thread, "update": update}}

    def acp_handshake(self, info=None):
        yield {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}}
        yield {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": self.thread, **(info or {})}}

    def acp_answer(self, text="part"):
        return self.acp_update(sessionUpdate="agent_message_chunk", content={"type": "text", "text": text})

    def acp_permission(self, rpc_id, tool, options=None, session=None):
        return {"jsonrpc": "2.0", "id": rpc_id, "method": "session/request_permission",
                "params": {"sessionId": session or self.thread, "toolCall": tool, "options": options or [
                    {"optionId": "internal-allow", "kind": "allow_once"},
                    {"optionId": "internal-deny", "kind": "reject_once"},
                    {"optionId": "internal-always", "kind": "allow_always"},
                ]}}

    def test_antigravity_supplement_stays_in_turn_and_never_overrides_original_terminal(self):
        antigravity, process, reply = self.acp_fixture()
        first, second = str(uuid.uuid4()), str(uuid.uuid4())

        def frames(_):
            yield from self.acp_handshake()
            yield self.acp_answer("original")
            self.assertTrue(self.control("snapshot")["stream"]["steer_ready"])
            self.assertEqual(self.control("steer", request={"id": first, "prompt": "first note"})["outcome"], "queued")
            yield None
            yield {"jsonrpc": "2.0", "id": 4, "result": {"stopReason": "end_turn"}}
            self.assertEqual(self.control("steer", request={"id": second, "prompt": "second note"})["outcome"], "queued")
            yield self.acp_answer(" and revised")
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}
            yield self.acp_answer("revised response")
            yield {"jsonrpc": "2.0", "id": 5, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 interactive=True), ("complete", self.thread, None))
        requests = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertEqual([(req["id"], req["params"]["sessionId"], req["params"]["prompt"][0]["text"])
                          for req in requests if req["method"] == "session/prompt"],
                         [(3, self.thread, "first"), (4, self.thread, "first note"), (5, self.thread, "second note")])
        self.assertFalse(self.control("snapshot")["stream"]["steer_ready"])
        self.assertEqual(self.control("snapshot")["steering"], [
            {"id": first, "state": "submitted"}, {"id": second, "state": "submitted"}])
        self.assertEqual(reply.items, {"antigravity": "revised response"})

    def test_antigravity_retains_uncertain_supplement_after_superseded_response(self):
        antigravity, process, reply = self.acp_fixture()
        note = str(uuid.uuid4())

        def frames(_):
            yield from self.acp_handshake()
            yield self.acp_answer("original")
            self.assertEqual(self.control("steer", request={"id": note, "prompt": "last note"})["outcome"], "queued")
            yield None
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}
            self.assertFalse(self.control("snapshot")["stream"]["steer_ready"])
            yield {"jsonrpc": "2.0", "id": 99, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                  interactive=True), ("unknown", None, None))
        self.assertEqual(self.control("snapshot")["steering"], [{"id": note, "state": "unknown"}])

    def test_antigravity_keeps_revised_text_when_original_fills_reply_limit(self):
        antigravity, process, reply = self.acp_fixture()
        reply.maximum = 32
        note = str(uuid.uuid4())

        def frames(_):
            yield from self.acp_handshake()
            yield self.acp_answer("😀" * (reply.maximum // 2))
            self.assertEqual(self.control("steer", request={"id": note, "prompt": "replace"})["outcome"], "queued")
            yield None
            yield self.acp_answer("\n\nreplacement!")
            yield {"jsonrpc": "2.0", "id": 4, "result": {"stopReason": "end_turn"}}
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 interactive=True), ("complete", self.thread, None))
        self.assertEqual(reply.items["antigravity"], "…\n\n" + "😀" * 7 + "\n\nreplacement!")

    def test_antigravity_approval_is_scoped_once_with_private_sanitized_receipts(self):
        antigravity, process, reply = self.acp_fixture()
        call = {"toolCallId": "tool-a", "kind": "execute", "title": "Run formatter",
                "rawInput": {"CommandLine": "python3 format.py", "Cwd": "/workspace",
                             "secretUnused": "not-in-the-approval"}}
        deny_call = {"toolCallId": "tool-b", "kind": "edit", "title": "Edit sample",
                     "locations": [{"path": "/workspace/demo.txt"}]}

        def frames(_):
            yield from self.acp_handshake()
            yield self.acp_update(sessionUpdate="agent_thought_chunk")
            self.assertTrue(self.control("snapshot")["stream"]["steer_ready"])
            yield self.acp_update(sessionUpdate="tool_call", **call)
            callback = self.acp_permission("rpc-allow", {"toolCallId": "tool-a"})
            yield callback
            yield callback
            self.assertFalse(self.control("snapshot")["stream"]["steer_ready"])
            self.assertEqual(self.control("steer", request={"id": str(uuid.uuid4()), "prompt": "fixture"})["outcome"],
                             "rejected")
            row, = self.control("snapshot")["approvals"]
            self.assertEqual(set(row), {"id", "title", "detail", "kind", "canAllow", "state", "decision"})
            self.assertEqual(row["detail"], "python3 format.py | /workspace")
            self.assertTrue(row["canAllow"])
            request = {"id": row["id"], "decision": "allow"}
            self.assertEqual(self.control("approval", request=request),
                             {"task_id": self.identifier, "approval_id": row["id"], "outcome": "queued"})
            self.assertEqual(self.control("approval", request={**request, "decision": "deny"})["outcome"], "rejected")
            self.assertEqual(self.control("approval", request={**request, "id": 4})["state"], "unknown")
            self.assertEqual(self.control("approval", str(uuid.uuid4()), request).get("state"), "unknown")
            yield None
            self.assertEqual(self.control("approval", request=request)["outcome"], "submitted")
            yield callback
            yield self.acp_permission("rpc-foreign", deny_call, session=str(uuid.uuid4()))
            yield self.acp_permission("rpc-deny", deny_call)
            rows = self.control("snapshot")["approvals"]
            self.assertEqual(rows[1]["detail"], "/workspace/demo.txt")
            request = {"id": rows[1]["id"], "decision": "deny"}
            self.assertEqual(self.control("approval", request=request)["outcome"], "queued")
            yield None
            yield self.acp_answer()
            self.assertTrue(reply.steer_ready)
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 interactive=True), ("complete", self.thread, None))
        responses = [packet for line in process.stdin.getvalue().splitlines()
                     if "result" in (packet := json.loads(line))]
        self.assertEqual([(packet["id"], packet["result"]["outcome"]) for packet in responses], [
            ("rpc-allow", {"outcome": "selected", "optionId": "internal-allow"}),
            ("rpc-foreign", {"outcome": "cancelled"}),
            ("rpc-deny", {"outcome": "selected", "optionId": "internal-deny"})])
        receipt = self.directory / "chat-approvals.json"
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        evidence = receipt.read_text()
        for private in ("rpc-allow", "internal-allow", "tool-a", "not-in-the-approval"):
            self.assertNotIn(private, evidence)
        self.assertEqual([row["state"] for row in self.control("snapshot")["approvals"]], ["submitted", "submitted"])

    def test_antigravity_ordinary_reads_allow_once_without_using_manual_slots(self):
        antigravity, process, reply = self.acp_fixture()
        workspace = self.directory / "mounted-work"
        workspace.mkdir()
        (workspace / "说明.md").write_text("ordinary fixture", encoding="utf-8")
        path = "/workspace/说明.md"
        reads = self.stream.MAX_APPROVALS + 1

        def frames(_):
            yield from self.acp_handshake()
            for number in range(reads):
                tool_id = f"file-{number}"
                yield self.acp_update(sessionUpdate="tool_call", toolCallId=tool_id, name="view_file",
                                      kind="read", title="Read notes", status="pending",
                                      rawInput={"AbsolutePath": path, "StartLine": 1, "EndLine": 3},
                                      locations=[{"path": path, "line": 1}])
                callback = self.acp_permission(f"read-{number}", {"toolCallId": tool_id})
                yield callback
                yield callback
            yield self.acp_permission("list", {"toolCallId": "list-root", "name": "list_dir", "kind": "search",
                                               "rawInput": {"DirectoryPath": "/workspace"}})
            self.assertEqual(self.control("snapshot")["approvals"], [])
            yield self.acp_permission("reuse", {"toolCallId": "file-0"})
            yield self.acp_permission("read-0", {"toolCallId": "different-tool", "name": "list_dir", "kind": "read",
                                                 "rawInput": {"DirectoryPath": "/workspace"}})
            yield self.acp_permission("shell", {"toolCallId": "command", "name": "run_command", "kind": "execute",
                                                "title": "Local command", "rawInput": {"CommandLine": "pwd", "Cwd": "/workspace"}})
            row, = self.control("snapshot")["approvals"]
            self.assertEqual((row["kind"], row["state"], row["canAllow"]), ("execute", "pending", True))
            self.assertEqual(self.control("approval", request={"id": row["id"], "decision": "deny"})["outcome"], "queued")
            yield None
            yield self.acp_answer("result")
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 interactive=True, read_only_workspace=(workspace, antigravity.workspace_identity(workspace.stat()))),
                         ("complete", self.thread, None))
        outcomes = [(value["id"], value["result"]["outcome"]) for value in
                    map(json.loads, process.stdin.getvalue().splitlines()) if "result" in value]
        allowed = {"outcome": "selected", "optionId": "internal-allow"}
        self.assertEqual(outcomes, [(f"read-{number}", allowed) for number in range(reads)] + [
            ("list", allowed), ("reuse", {"outcome": "cancelled"}),
            ("shell", {"outcome": "selected", "optionId": "internal-deny"}),
        ])

    def test_antigravity_workspace_read_requires_a_known_tool_and_an_ordinary_mount_target(self):
        antigravity, _, _ = self.acp_fixture()
        workspace = self.directory / "mounted-work"
        workspace.mkdir()
        ordinary = workspace / "notes.txt"
        ordinary.write_text("fixture", encoding="utf-8")
        (workspace / ".env").write_text("fixture", encoding="utf-8")
        (workspace / "auth.json").write_text("fixture", encoding="utf-8")
        outside = self.directory / "other.txt"
        outside.write_text("fixture", encoding="utf-8")
        (workspace / "link.txt").symlink_to(outside)
        (workspace / "linked-dir").symlink_to(self.directory, target_is_directory=True)
        os.link(outside, workspace / "linked-copy.txt")
        path = "/workspace/notes.txt"
        call = {"name": "view_file", "kind": "read", "rawInput": {"AbsolutePath": path}}
        binding = workspace, antigravity.workspace_identity(workspace.stat())
        self.assertTrue(antigravity.ordinary_workspace_read(call, binding))
        for target in ("/home/codex/notes.txt", "/workspace-other/notes.txt", "/workspace/missing",
                       "/workspace/../other.txt", "/workspace//notes.txt", "/workspace/notes.txt\n",
                       "/workspace/.env", "/workspace/auth.json", "/workspace/link.txt",
                       "/workspace/linked-dir/other.txt", "/workspace/linked-copy.txt"):
            with self.subTest(target=target):
                self.assertFalse(antigravity.ordinary_workspace_read({**call, "rawInput": {"AbsolutePath": target}}, binding))
        for unknown in (
            {**call, "name": "mcp_docs_view_file"}, {**call, "name": "ask_permission"},
            {**call, "kind": "execute"}, {**call, "kind": "edit"}, {**call, "status": "in_progress"},
            {**call, "_meta": {"scope": "external"}}, {**call, "locations": [{"path": "/workspace/another"}]},
            {**call, "rawInput": {"AbsolutePath": path, "IsSkillFile": True}},
            {**call, "rawInput": {"AbsolutePath": path, "CommandLine": "pwd"}},
            {**call, "rawInput": {"AbsolutePath": path, "StartLine": 5, "EndLine": 4}},
            {**call, "rawInput": {"AbsolutePath": path, "StartLine": True}},
            {"name": "list_dir", "kind": "read", "rawInput": {"DirectoryPath": path}},
        ):
            with self.subTest(tool=unknown):
                self.assertFalse(antigravity.ordinary_workspace_read(unknown, binding))
        workspace.rename(self.directory / "original-work")
        workspace.mkdir()
        (workspace / "notes.txt").write_text("replacement", encoding="utf-8")
        self.assertFalse(antigravity.ordinary_workspace_read(call, binding))

    def test_antigravity_auto_read_checks_option_ambiguity_updates_and_active_stop(self):
        antigravity, process, reply = self.acp_fixture()
        workspace = self.directory / "mounted-work"
        workspace.mkdir()
        for name in ("old.txt", "new.txt"):
            (workspace / name).write_text("fixture", encoding="utf-8")
        support = dict(vars(self.stream), read_frames=lambda _: iter(()))
        binding = workspace, antigravity.workspace_identity(workspace.stat())
        turn = antigravity.AcpTurn(process, support, reply, self.identifier, read_only_workspace=binding)
        turn.session = self.thread
        turn.submitted = True
        turn.enable_controls()
        tool = {"name": "view_file", "kind": "read", "title": "Read file",
                "rawInput": {"AbsolutePath": "/workspace/new.txt"}}

        turn.incoming(self.acp_permission("always", {**tool, "toolCallId": "always"}, [
            {"optionId": "always", "kind": "allow_always"}, {"optionId": "deny", "kind": "reject_once"},
        ]))
        turn.incoming(self.acp_permission("ambiguous", {**tool, "toolCallId": "ambiguous"}, [
            {"optionId": "first", "kind": "allow_once"}, {"optionId": "second", "kind": "allow_once"},
        ]))
        turn.incoming(self.acp_update(sessionUpdate="tool_call", toolCallId="changed", **{
            **tool, "rawInput": {"AbsolutePath": "/workspace/old.txt"},
        }))
        turn.incoming(self.acp_permission("changed", {**tool, "toolCallId": "changed"}))
        turn.incoming(self.acp_permission("out-of-scope", {**tool, "toolCallId": "out-of-scope",
                     "rawInput": {"AbsolutePath": "/home/codex/auth.json"}}))
        turn.incoming(self.acp_update(sessionUpdate="tool_call", toolCallId="opaque", approvedResources=[], **tool))
        turn.incoming(self.acp_permission("opaque", {"toolCallId": "opaque"}))
        turn.incoming(self.acp_update(sessionUpdate="tool_call", toolCallId="terminal", status="completed", **tool))
        turn.incoming(self.acp_permission("terminal", {**tool, "toolCallId": "terminal", "status": "pending"}))
        turn.supplement_sent = True
        turn.incoming(self.acp_permission("steered", {**tool, "toolCallId": "steered"}))
        turn.supplement_sent = False
        rows = turn.approvals.read()
        self.assertEqual(len(rows), 7)
        self.assertTrue(all(row["state"] == "pending" for row in rows))
        self.assertFalse(rows[0]["canAllow"])
        self.assertEqual(rows[3]["detail"], "/home/codex/auth.json")
        self.assertEqual(process.stdin.getvalue(), b"")

        invalid_tool = {**tool, "toolCallId": "initially-invalid"}
        turn.incoming(self.acp_permission("initially-invalid", invalid_tool, session="different-session"))
        turn.incoming(self.acp_permission("initially-invalid", invalid_tool))
        support["stop_requested"] = lambda _: True
        stopped = self.acp_permission("stopped", {**tool, "toolCallId": "stopped"})
        turn.incoming(stopped)
        support["stop_requested"] = lambda _: False
        turn.incoming(stopped)
        outcomes = [(row["id"], row["result"]["outcome"]) for row in
                    map(json.loads, process.stdin.getvalue().splitlines())]
        self.assertEqual(outcomes, [(identifier, {"outcome": "cancelled"})
                                    for identifier in ("initially-invalid", "stopped")])
        self.assertEqual(len(turn.approvals.read()), 7)

    def test_antigravity_approval_never_grants_persistent_or_obscured_permissions(self):
        antigravity, process, reply = self.acp_fixture()
        private = "example-test-value"

        def frames(_):
            yield from self.acp_handshake()
            call = {"toolCallId": "tool-a", "kind": "execute", "title": "😀" * 240,
                    "rawInput": {"command": f"API_KEY={private} python3 format.py\nsecond"}}
            yield self.acp_permission("rpc-only-always", call, [{"optionId": "always", "kind": "allow_always"}])
            row, = self.control("snapshot")["approvals"]
            self.assertFalse(row["canAllow"])
            self.assertLessEqual(len(row["title"].encode("utf-16-le")), 480)
            self.assertNotIn(private, row["detail"])
            self.assertNotIn("\n", row["detail"])
            self.assertEqual(self.control("approval", request={"id": row["id"], "decision": "allow"})["outcome"], "rejected")
            self.assertEqual(self.control("approval", request={"id": row["id"], "decision": "deny"})["outcome"], "queued")
            yield None
            call["toolCallId"] = "tool-b"
            yield self.acp_permission("rpc-redacted", call)
            second = self.control("snapshot")["approvals"][-1]
            self.assertFalse(second["canAllow"])
            self.assertEqual(self.control("approval", request={"id": second["id"], "decision": "allow"})["outcome"], "rejected")
            self.control("stop")
            self.assertEqual(self.control("approval", request={"id": second["id"], "decision": "deny"})["outcome"], "rejected")
            yield None
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "cancelled"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 interactive=True), ("stopped", self.thread, None))
        packets = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertIn({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": self.thread}}, packets)
        self.assertEqual([packet["result"]["outcome"] for packet in packets if "result" in packet],
                         [{"outcome": "cancelled"}, {"outcome": "cancelled"}])
        self.assertEqual([row["state"] for row in self.control("snapshot")["approvals"]], ["submitted", "closed"])

    def test_antigravity_approval_dispatch_disconnect_remains_unknown(self):
        antigravity, process, reply = self.acp_fixture()
        original = antigravity.AcpTurn.write

        def frames(_):
            yield from self.acp_handshake()
            yield self.acp_permission("rpc-permission", {"toolCallId": "tool-a", "title": "Read",
                                      "kind": "read", "locations": [{"path": "/workspace/README.md"}]})
            row, = self.control("snapshot")["approvals"]
            self.assertEqual(self.control("approval", request={"id": row["id"], "decision": "allow"})["outcome"], "queued")
            yield None

        def fail_approval(turn, packet):
            if packet.get("id") == "rpc-permission":
                raise BrokenPipeError()
            original(turn, packet)

        support = dict(vars(self.stream), read_frames=frames)
        with patch.object(antigravity.AcpTurn, "write", fail_approval):
            self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                     interactive=True), ("unknown", None, None))
        row, = self.control("snapshot")["approvals"]
        self.assertEqual(row["state"], "unknown")
        self.assertEqual(self.control("approval", request={"id": row["id"], "decision": "allow"})["outcome"], "unknown")

    def test_antigravity_withdraws_approval_when_pending_tool_changes(self):
        antigravity, process, reply = self.acp_fixture()

        def frames(_):
            yield from self.acp_handshake()
            call = {"toolCallId": "tool-edit", "kind": "edit", "title": "Move test data",
                    "locations": [{"path": "/workspace/fixture.txt"}],
                    "rawInput": {"destination": "/output/result.txt"}}
            yield self.acp_permission("rpc-edit", call)
            row, = self.control("snapshot")["approvals"]
            self.assertIn("/output/result.txt", row["detail"])
            self.assertEqual(self.control("approval", request={"id": row["id"], "decision": "allow"})["outcome"], "queued")
            yield self.acp_update(sessionUpdate="tool_call_update", toolCallId="tool-edit",
                                  rawInput={"destination": "/output/changed.txt"})
            self.assertEqual(self.control("snapshot")["approvals"][0]["state"], "closed")
            yield self.acp_answer("cancelled operation")
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 interactive=True), ("complete", self.thread, None))
        responses = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertEqual([row["result"] for row in responses if row.get("id") == "rpc-edit"],
                         [{"outcome": {"outcome": "cancelled"}}])
        self.assertNotIn(b"internal-allow", process.stdin.getvalue())

    def test_antigravity_workflow_selected_stdio_mcp_and_noninteractive_permissions(self):
        antigravity, process, reply = self.acp_fixture()
        base = Path(__file__).resolve().parents[1]
        extensions = load("chat_extensions", base / "DshChatBridge/RemoteDshExtensions.py")
        home = self.directory / "home"
        registry = home / ".config/vps-workbench/mcp"
        registry.mkdir(mode=0o700, parents=True)
        for name in ("selected.py", "unselected.py"):
            target = registry / name
            target.write_text("print('test MCP tool')\n", encoding="utf-8")
            target.chmod(0o600)
        gate = self.directory / "gate"
        gate.mkdir(mode=0o700)
        servers = extensions.prepare(gate, home, ["selected"], acp=True)
        self.assertEqual(servers, [{"type": "stdio", "name": "selected", "command": "/usr/bin/python3",
                                    "args": ["-I", "-B", "/run/gate/mcp-selected.py"], "env": []}])
        self.assertEqual([path.name for path in gate.iterdir()], ["mcp-selected.py"])
        self.assertEqual((gate / "mcp-selected.py").stat().st_mode & 0o777, 0o600)
        (registry / "unselected.py").chmod(0o644)
        with self.assertRaises(ValueError):
            extensions.prepare(gate, home, ["unselected"], acp=True)

        def frames(_):
            yield from self.acp_handshake({"modes": {"availableModes": [{"id": "accept-edits"}],
                                                     "currentModeId": "accept-edits"}})
            selected = {"toolCallId": "tool-a", "kind": "other", "name": "mcp_selected_status"}
            yield self.acp_permission("rpc-mcp", selected)
            yield self.acp_permission("rpc-mcp", selected)
            yield self.acp_permission("rpc-mcp-other", {"toolCallId": "tool-b", "kind": "other",
                                                       "name": "mcp_unselected_status", "title": "Run mcp_selected_status"})
            yield self.acp_answer()
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 workflow=True, mcp_servers=servers, interactive=True),
                         ("complete", self.thread, None))
        packets = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertEqual(packets[0]["params"]["clientCapabilities"], {})
        self.assertEqual(packets[1]["params"]["mcpServers"], [
            {key: value for key, value in servers[0].items() if key != "type"}])
        self.assertEqual([packet["result"]["outcome"] for packet in packets if "result" in packet],
                         [{"outcome": "selected", "optionId": "internal-allow"}, {"outcome": "cancelled"}])
        self.assertNotIn("approvals", self.control("snapshot"))

    def test_antigravity_can_resume_when_denial_ends_the_turn_without_text(self):
        antigravity, process, reply = self.acp_fixture()

        def frames(_):
            yield from self.acp_handshake()
            yield self.acp_permission("rpc-read", {"toolCallId": "tool-read", "title": "Read fixture",
                                                  "kind": "read", "locations": [{"path": "/fixture.txt"}]})
            row, = self.control("snapshot")["approvals"]
            self.assertEqual(self.control("approval", request={"id": row["id"], "decision": "deny"})["outcome"], "queued")
            yield None
            yield {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}

        support = dict(vars(self.stream), read_frames=frames)
        self.assertEqual(antigravity.consume_acp(process, support, reply, None, self.identifier, "first", None,
                                                 interactive=True), ("stopped", self.thread, None))

    def test_claude_api_effort_and_settings_survive_runner_argument_wrapping(self):
        base = Path(__file__).resolve().parents[1]
        isolation = load("chat_isolation", base / "RemoteCodexIsolate.py")
        settings = json.dumps({"autoMemoryEnabled": False, "env": {
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192"}})
        args = ["claude", "-p", "--settings", settings, "--effort", "low",
                "--chat-session", self.thread, "--chat-prompt", "fixture", "--resume", self.thread]
        command, session, _, prompt, images, subscription, _ = isolation.chat_args(args)
        self.assertEqual(session, self.thread)
        sandbox = isolation.sandbox_command("/fixture/claude", str(self.directory), "/fixture/credential",
                                            str(self.directory), command[1:], provider="claude",
                                            prompt=prompt, images=images, subscription=subscription)
        data = json.loads(base64.b64decode(sandbox[-1]))
        self.assertEqual(data["argv"], ["-p", "--settings", settings, "--effort", "low", "--resume", self.thread])
        self.assertEqual(data["prompt"], "fixture")
        self.assertFalse(data["subscription"])

    def test_workspace_mounts_preserve_legacy_and_validate_before_isolation(self):
        base = Path(__file__).resolve().parents[1]
        isolation = vars(load("chat_isolation", base / "RemoteCodexIsolate.py")).copy()
        work = self.directory / "project"
        work.mkdir()
        (work / "source.txt").write_text("project file", encoding="utf-8")
        auth = str(self.directory / "auth.json")
        home = str(self.directory / "codex-home")
        config = {"sessionId": self.thread, "threadId": None, "prompt": "test prompt", "workspace": str(work),
                  "expectedIpv4": "192.0.2.1", "expectedIpv6": None}
        privacy = {"clean_environment": lambda _: {"PATH": "/usr/bin", "HOME": str(self.directory)},
                   "address": lambda value, _: value, "preflight": lambda *_: True}
        for access, mount in ((None, "--bind"), ("read-only", "--ro-bind"), ("isolated", "--ro-bind")):
            with self.subTest(access=access):
                payload = config if access is None else dict(config, workspaceAccess=access)
                validate = Mock(return_value=("/fixture/codex", str(work), auth))
                isolation.update(validate_paths=validate, chat_paths=lambda *_: (self.directory, home, None),
                                 Gateway=lambda *_: contextlib.nullcontext())
                mounted = []

                def inspect(command, **kwargs):
                    index = command.index("/workspace")
                    self.assertEqual(command[index + 1], mount)
                    self.assertEqual(command[index + 3], "/workspace")
                    source = Path(command[index + 2])
                    mounted.append(source)
                    if access == "isolated":
                        self.assertNotIn(str(work), command)
                        self.assertEqual(list(source.iterdir()), [])
                        self.assertEqual(source.stat().st_mode & 0o777, 0o700)
                    else:
                        self.assertEqual(source, work)
                    self.assertIn(auth, command)
                    self.assertIn(home, command)
                    return object()

                reply = self.stream.Reply(self.directory, self.identifier)
                with patch.object(self.stream.subprocess, "Popen", side_effect=inspect) as launch, \
                     patch.object(self.stream.shutil, "which", return_value=None), \
                     patch.object(self.stream.Conversation, "drive", return_value="complete"), \
                     patch.object(self.stream, "close_server"):
                    self.assertEqual(self.stream.run(privacy, isolation, payload, reply), ("complete", None, None))
                validate.assert_called_once_with(str(self.directory / ".local/bin/codex"), str(work),
                                                 {"PATH": "/usr/bin", "HOME": str(self.directory)})
                launch.assert_called_once()
                if access == "isolated":
                    self.assertFalse(mounted[0].exists())

    def test_workspace_access_rejects_unsupported_values_and_sdk_before_dispatch(self):
        for config in ({"workspaceAccess": None}, {"workspaceAccess": "workspace-write"},
                       {"workspaceAccess": []}, {"workspaceAccess": "Read-only"},
                       {"workspaceAccess": "isolated", "sdk": {}}):
            with self.subTest(config=config), patch.object(self.stream, "load_helper"), \
                 patch.object(self.stream.sys, "argv", ["python3", "stream", "privacy", "isolation"]), \
                 patch.object(self.stream.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(config).encode()))), \
                 patch.object(self.stream, "run") as run:
                with self.assertRaisesRegex(ValueError, "invalid workspace access"):
                    self.stream.main()
                run.assert_not_called()

    def test_design_context_keeps_inline_image_separate_and_rejects_remote_urls(self):
        config = {
            "design": True, "prompt": "original prompt",
            "designContext": {"text": "画板编辑", "images": [{"name": "fixture.png", "dataUrl": "data:image/png;base64,iVBORw0KGgo="}]},
        }
        fields = self.stream.design_inputs(config)
        self.assertEqual(fields[0]["text"], "original prompt")
        self.assertIn("画板编辑", fields[1]["text"])
        self.assertEqual(fields[-1], {"type": "image", "url": config["designContext"]["images"][0]["dataUrl"]})
        with self.assertRaises(ValueError):
            self.stream.design_inputs({**config, "design": False})
        config["designContext"]["images"][0]["dataUrl"] = "https://external.invalid/reference.png"
        with self.assertRaises(ValueError):
            self.stream.design_inputs(config)

    def steer_conversation(self):
        reply = self.stream.Reply(self.directory, self.identifier, self.stream.MAX_DESIGN_REPLY, design=True)
        driver = self.stream.Conversation(reply, {"threadId": None, "prompt": "first brief", "design": True})
        return driver, reply

    def event(self, method, **fields):
        return {"method": method, "params": {"threadId": self.thread, "turnId": self.turn, **fields}}

    def test_steer_uses_same_active_turn_and_replaces_obsolete_design_items(self):
        driver, reply = self.steer_conversation()
        note = {"id": str(uuid.uuid4()), "prompt": "补充：请用紫色；保持标题"}

        def frames(_):
            yield from self.handshake()
            yield self.event("item/agentMessage/delta", itemId="old", delta="obsolete first draft")
            reply.publish("running", self.thread)
            self.assertEqual(driver.steering.queue(note), "queued")
            self.assertEqual(driver.steering.queue(note), "queued")
            yield None
            yield {"id": 100, "result": {"turnId": self.turn}}
            yield self.event("item/started", item={"type": "userMessage", "clientId": note["id"]})
            yield self.event("item/agentMessage/delta", itemId="old", delta="obsolete suffix")
            yield self.event("item/completed", item={"type": "agentMessage", "id": "new", "text": "updated design"})
            yield self.event("turn/completed", turn={"id": self.turn, "status": "completed"})

        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
            self.assertEqual(driver.drive(object()), "complete")
        calls = [call.args[2] for call in writes.call_args_list if call.args[1] == "turn/steer"]
        self.assertEqual(calls, [{
            "threadId": self.thread, "expectedTurnId": self.turn, "clientUserMessageId": note["id"],
            "input": [{"type": "text", "text": note["prompt"], "text_elements": []}],
        }])
        self.assertEqual(driver.steering.observations(), [{"id": note["id"], "state": "delivered"}])
        self.assertEqual(reply.items, {"new": "updated design"})

    def test_steer_before_start_or_after_terminal_is_rejected_and_pending_receipts_are_distinct(self):
        driver, reply = self.steer_conversation()
        first = {"id": str(uuid.uuid4()), "prompt": "first"}
        second = {"id": str(uuid.uuid4()), "prompt": "second"}
        self.assertEqual(driver.steering.queue(first), "rejected")
        reply.set_steer_ready(True)
        reply.publish("running", self.thread)
        self.assertEqual(driver.steering.queue(first), "queued")
        self.assertEqual(driver.steering.claim()["id"], first["id"])
        self.assertEqual(driver.steering.queue(second), "queued")
        self.assertEqual(driver.steering.queue({**first, "prompt": "different"}), "rejected")
        reply.set_steer_ready(False)
        reply.publish("stopped", self.thread)
        driver.steering.close()
        self.assertEqual(driver.steering.observations(),
                         [{"id": first["id"], "state": "unknown"}, {"id": second["id"], "state": "rejected"}])
        self.assertEqual(driver.steering.queue({"id": str(uuid.uuid4()), "prompt": "too late"}), "rejected")

    def test_stop_marker_blocks_steering_dispatch(self):
        driver, reply = self.steer_conversation()
        note = {"id": str(uuid.uuid4()), "prompt": "pending change"}

        def frames(_):
            yield from self.handshake()
            yield None
            reply.publish("running", self.thread)
            self.assertEqual(driver.steering.queue(note), "queued")
            (self.directory / "chat-stop").touch(mode=0o600)
            yield None
            yield self.event("turn/completed", turn={"id": self.turn, "status": "interrupted"})

        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
            self.assertEqual(driver.drive(object()), "stopped")
        methods = [call.args[1] for call in writes.call_args_list]
        self.assertIn("turn/interrupt", methods)
        self.assertNotIn("turn/steer", methods)

    def test_reported_model_and_context_belong_to_the_same_native_turn(self):
        reply = self.stream.Reply(self.directory, self.identifier)
        driver = self.stream.Conversation(reply, {
            "threadId": self.thread, "prompt": "continue the same conversation", "model": "fixture-model", "effort": "low",
        })

        def frames(_):
            yield {"id": 1, "result": {}}
            yield {"id": 2, "result": {"thread": {"id": self.thread}, "model": "fixture-model", "reasoningEffort": "medium"}}
            yield {"id": 3, "result": {"turn": {"id": self.turn}}}
            yield self.event("thread/tokenUsage/updated", tokenUsage={
                "last": {"totalTokens": 1234}, "total": {"totalTokens": 4321}, "modelContextWindow": 10000,
            })
            old = self.event("thread/tokenUsage/updated", tokenUsage={
                "last": {"totalTokens": 9000}, "modelContextWindow": 10000,
            })
            old["params"]["turnId"] = "previous-turn"
            yield old
            yield self.event("turn/completed", turn={"id": self.turn, "status": "completed"})

        with patch.object(self.stream, "send") as writes, patch.object(self.stream, "read_frames", frames):
            self.assertEqual(driver.drive(object()), "complete")
        resumed = next(call.args[2] for call in writes.call_args_list if call.args[1] == "thread/resume")
        started = next(call.args[2] for call in writes.call_args_list if call.args[1] == "turn/start")
        self.assertEqual(resumed["threadId"], self.thread)
        self.assertEqual(started["threadId"], self.thread)
        self.assertEqual(started["model"], "fixture-model")
        self.assertEqual(started["effort"], "low")
        reply.publish("complete", driver.thread)
        observed = self.stream.read_snapshot(self.directory)
        self.assertEqual(observed["model"], "fixture-model")
        self.assertEqual(observed["effort"], "low")
        self.assertEqual(observed["context_usage"], {"usedTokens": 1234, "contextWindow": 10000})


if __name__ == "__main__":
    unittest.main()
