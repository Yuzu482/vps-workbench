import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from contextlib import redirect_stdout
from unittest.mock import patch

directory = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(directory))
try:
    spec = importlib.util.spec_from_file_location("task_start", directory / "RemoteTaskStart.py")
    task_start = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(task_start)
finally:
    sys.path.pop(0)


class RemoteStartTests(unittest.TestCase):
    def setUp(self):
        self.identifier = str(uuid.uuid4())
        self.temp = tempfile.TemporaryDirectory(prefix="remote-start-test-")
        self.work = Path(self.temp.name)
        self.key = self.work / "key"
        self.known = self.work / "known"
        self.receipt = self.work / "receipt.json"
        self.key.write_text("fixture only")
        self.known.write_text("fixture only")

    def tearDown(self):
        self.temp.cleanup()

    def test_start_uses_fixed_helper_and_payload_stdin(self):
        base = ["ssh", "original status command"]
        command = task_start.build_start(base, b"print('fixture')", self.identifier, "/tmp/state path")
        self.assertEqual(command[0], "ssh")
        self.assertIn(" start --id " + self.identifier, command[-1])
        self.assertIn("--payload-stdin", command[-1])
        self.assertNotIn("/tmp/state path", command[-1])

    def test_uncertain_start_is_never_retried(self):
        calls = []

        def runner(command, payload):
            calls.append((command, payload))
            return None, b""

        result, code = task_start.submit_once(["start-once"], b"task payload", self.identifier, runner=runner)
        self.assertEqual(code, 2)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["task_id"], self.identifier)
        self.assertEqual(result["next"], "query_status_with_same_id")
        self.assertEqual(len(calls), 1)

    def test_duplicate_reservation_is_not_reported_as_new_start(self):
        response = json.dumps({"task_id": self.identifier, "outcome": "already_exists",
                               "status": {"task_id": self.identifier, "state": "unknown"}}).encode()
        result, code = task_start.submit_once(["start-once"], b"payload", self.identifier,
                                              runner=lambda *_: (3, response))
        self.assertEqual(code, 3)
        self.assertEqual(result["outcome"], "already_exists")

    def test_invalid_acknowledgement_stays_unknown(self):
        response = json.dumps({"task_id": str(uuid.uuid4()), "outcome": "accepted"}).encode()
        result, code = task_start.submit_once(["start-once"], b"payload", self.identifier,
                                              runner=lambda *_: (0, response))
        self.assertEqual(code, 2)
        self.assertEqual(result["outcome"], "unknown")

    def test_receipt_is_saved_before_send_and_reused_without_recording_command(self):
        calls = []

        def submit(command, payload, identifier):
            record = json.loads(self.receipt.read_text())
            self.assertEqual(record["task_id"], identifier)
            self.assertNotIn("private-command-marker", self.receipt.read_text())
            calls.append(identifier)
            return {"task_id": identifier, "outcome": "accepted"}, 0

        args = ["--host", "example.test", "--user", "alice", "--identity", str(self.key),
                "--known-hosts", str(self.known), "--receipt", str(self.receipt),
                "--", "program", "private-command-marker"]
        with patch.object(task_start, "submit_once", side_effect=submit), redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(args), 0)
            self.assertEqual(task_start.main(args), 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])

    def test_receipt_target_mismatch_blocks_submission(self):
        task_start.status.receipt_id(str(self.receipt), "example.test", 22, "alice", None,
                                     proposed=self.identifier, create=True)
        args = ["--host", "other.test", "--user", "alice", "--identity", str(self.key),
                "--known-hosts", str(self.known), "--receipt", str(self.receipt), "--", "program"]
        with patch.object(task_start, "submit_once") as submit, redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(args), 2)
        submit.assert_not_called()

    def test_stdin_request_keeps_command_out_of_cli_and_preserves_arguments(self):
        request = {"command": ["program", "中文 ; $()", "another argument"],
                   "cwd": "/tmp/work path", "capture": True}
        encoded = json.dumps(request, ensure_ascii=False).encode("utf-8")
        arguments = ["--host", "example.test", "--user", "alice", "--identity", str(self.key),
                     "--known-hosts", str(self.known), "--receipt", str(self.receipt),
                     "--id", self.identifier, "--request-stdin"]
        calls = []

        def submit(command, payload, identifier):
            self.assertTrue(self.receipt.exists())
            self.assertEqual(json.loads(payload), request)
            self.assertEqual(identifier, self.identifier)
            calls.append(command)
            return {"task_id": identifier, "outcome": "accepted"}, 0

        stdin = io.TextIOWrapper(io.BytesIO(encoded), encoding="utf-8")
        with patch.object(task_start.sys, "stdin", stdin), patch.object(task_start, "submit_once", side_effect=submit), redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(arguments), 0)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("中文 ; $()", " ".join(arguments))
        self.assertNotIn("中文 ; $()", self.receipt.read_text())

    def test_stdin_request_rejects_invalid_or_oversized_content(self):
        for data in (b"{", b"x" * (task_start.MAX_PAYLOAD + 1),
                     b'{"command":[1],"cwd":null,"capture":false}',
                     b'{"command":["x"],"cwd":null,"capture":1}',
                     b'{"command":["x"],"cwd":null,"capture":false,"extra":0}'):
            with self.subTest(data=data[:60]), self.assertRaises((ValueError, UnicodeError)):
                task_start.read_local_request(io.BytesIO(data))

    def test_larger_requests_are_specific_to_the_chat_stream(self):
        request = {
            "command": ["program"], "cwd": "/tmp/project", "capture": True,
            "chatInput": {"fixture": "a" * (task_start.MAX_PAYLOAD + 1)},
        }
        data = json.dumps(request).encode("utf-8")
        self.assertEqual(task_start.read_local_request(io.BytesIO(data), True), request)
        with self.assertRaises(ValueError):
            task_start.read_local_request(io.BytesIO(data))
        del request["chatInput"]
        with self.assertRaises(ValueError):
            task_start.read_local_request(io.BytesIO(json.dumps(request).encode() + b" " * len(data)), True)

    def test_stdin_request_cannot_be_mixed_with_command_or_flags(self):
        arguments = ["--host", "example.test", "--user", "alice", "--identity", str(self.key),
                     "--known-hosts", str(self.known), "--receipt", str(self.receipt),
                     "--request-stdin", "--capture-output"]
        with patch.object(task_start, "submit_once") as submit, redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(arguments), 2)
        submit.assert_not_called()
        self.assertFalse(self.receipt.exists())

    def test_outer_only_requires_isolation_and_rejects_policy_conflicts(self):
        base = ["--host", "example.test", "--user", "alice", "--identity", str(self.key),
                "--known-hosts", str(self.known), "--receipt", str(self.receipt),
                "--privacy-ipv4", "203.0.113.4", "--outer-only"]
        with patch.object(task_start, "submit_once") as submit, redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(base + ["--", "codex", "exec", "prompt"]), 2)
            self.assertEqual(task_start.main(base + ["--isolate-workspace", "/tmp/project", "--", "codex", "exec", "--sandbox", "read-only", "prompt"]), 2)
            self.assertEqual(task_start.main(base + ["--isolate-workspace", "/tmp/project", "--", "codex", "exec", "--config=sandbox_mode=read-only", "prompt"]), 2)
            self.assertEqual(task_start.main(base + ["--isolate-workspace", "/tmp/project", "--", "codex", "exec", "--yolo", "prompt"]), 2)
            submit.assert_not_called()
            self.assertFalse(self.receipt.exists())

    def test_outer_only_adds_explicit_inner_mode_inside_outer_isolation(self):
        args = ["--host", "example.test", "--user", "alice", "--identity", str(self.key),
                "--known-hosts", str(self.known), "--receipt", str(self.receipt),
                "--privacy-ipv4", "203.0.113.4", "--outer-only", "--isolate-workspace", "/tmp/project",
                "--", "codex", "exec", "--json", "prompt"]
        with patch.object(task_start, "submit_once", return_value=({"outcome": "accepted"}, 0)) as submit, redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(args), 0)
        command = json.loads(submit.call_args.args[1])["command"]
        self.assertIn("--isolation-code", command)
        self.assertEqual(command[-6:], ["codex", "exec", "--sandbox", "danger-full-access", "--json", "prompt"])

    def test_direct_codex_needs_privacy_and_wraps_without_replay(self):
        args = ["--host", "example.test", "--user", "alice", "--identity", str(self.key),
                "--known-hosts", str(self.known), "--receipt", str(self.receipt)]
        with patch.object(task_start, "submit_once") as submit, redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(args + ["--", "/home/alice/.local/bin/codex", "exec", "hello"]), 2)
            submit.assert_not_called()
            self.assertFalse(self.receipt.exists())
            submit.return_value = ({"outcome": "accepted"}, 0)
            self.assertEqual(task_start.main(args + ["--privacy-ipv4", "203.0.113.4", "--", "/home/alice/.local/bin/codex", "exec", "hello"]), 0)
            self.assertEqual(submit.call_count, 1)
            request = json.loads(submit.call_args.args[1])
            self.assertEqual(request["command"][0], "python3")
            self.assertLessEqual(len(request["command"][3]), 6000)
            self.assertEqual(request["command"][-3:], ["/home/alice/.local/bin/codex", "exec", "hello"])

    def test_isolated_cli_requires_codex_exec_matching_workspace_and_wraps_once(self):
        args = ["--host", "example.test", "--user", "alice", "--identity", str(self.key),
                "--known-hosts", str(self.known), "--receipt", str(self.receipt), "--privacy-ipv4", "203.0.113.4",
                "--isolate-workspace", "/tmp/project"]
        with patch.object(task_start, "submit_once") as submit, redirect_stdout(io.StringIO()):
            self.assertEqual(task_start.main(args + ["--cwd", "/tmp/other", "--", "codex", "exec"]), 2)
            self.assertEqual(task_start.main(args + ["--", "codex", "login"]), 2)
            submit.assert_not_called()
            self.assertFalse(self.receipt.exists())
            submit.return_value = ({"outcome": "accepted"}, 0)
            self.assertEqual(task_start.main(args + ["--", "/home/alice/.local/bin/codex", "exec", "hello"]), 0)
            self.assertEqual(submit.call_count, 1)
            request = json.loads(submit.call_args.args[1])
            self.assertEqual(request["cwd"], "/tmp/project")
            self.assertIn("--isolation-code", request["command"])
            self.assertIn("--isolation-workspace", request["command"])
            self.assertEqual(request["command"][-3:], ["/home/alice/.local/bin/codex", "exec", "hello"])


if __name__ == "__main__":
    unittest.main()
