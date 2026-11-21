import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("task_status", Path(__file__).resolve().parents[1] / "RemoteTaskStatus.py")
task_status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(task_status)


class RemoteStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote-status-test-")
        self.work = Path(self.temp.name)
        self.key = self.work / "key"
        self.known = self.work / "known hosts"
        self.key.write_text("fixture only")
        self.known.write_text("fixture only")
        self.identifier = str(uuid.uuid4())

    def tearDown(self):
        self.temp.cleanup()

    def test_command_is_strict_read_only_status_and_preserves_stdin(self):
        command = task_status.build_command("example.test", 22, "alice", str(self.key), str(self.known),
                                            self.identifier, "/tmp/state path")
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("BatchMode=yes", command)
        self.assertIn("IdentityAgent=none", command)
        self.assertIn("IdentityFile=none", command)
        self.assertIn("-T", command)
        self.assertNotIn("-n", command)
        self.assertTrue(command[-1].startswith("python3 -B - status --id "))
        self.assertNotIn(" start ", command[-1])
        self.assertNotIn("/tmp/state path", command[-1])

    def test_invalid_host_path_and_uuid_are_rejected(self):
        for host in ("-oProxyCommand=bad", "a..b", "a b", "127.0.0.1;bad"):
            with self.assertRaises(ValueError):
                task_status.build_command(host, 22, "alice", str(self.key), str(self.known), self.identifier)
        with self.assertRaises(ValueError):
            task_status.build_command("example.test", 22, "alice", str(self.key), str(self.known), "not-a-uuid")
        with self.assertRaises(ValueError):
            task_status.build_command("example.test", 22, "alice", str(self.key), str(self.known), self.identifier, "relative")

    def test_relay_acknowledgment_precedes_request_bytes(self):
        acknowledgement = task_status.RELAY_READY
        for header, expected_code in ((acknowledgement, 0), (b"wrong peer\n", None)):
            observed = self.work / "observed"
            observed.unlink(missing_ok=True)
            script = (
                "import sys; from pathlib import Path; "
                f"sys.stdout.buffer.write({header!r}); sys.stdout.buffer.flush(); "
                f"Path({str(observed)!r}).write_bytes(sys.stdin.buffer.read()); "
                "sys.stdout.buffer.write(b'remote response')"
            )
            command = [sys.executable, "-c", script]
            with patch.object(task_status, "relay_command", return_value=(command, True)):
                code, data = task_status.run_ssh(command, b"fixture secret", timeout=4)
            self.assertEqual(code, expected_code)
            if expected_code == 0:
                self.assertEqual(data, b"remote response")
                self.assertEqual(observed.read_bytes(), b"fixture secret")
            else:
                self.assertEqual(data, b"")
                self.assertFalse(observed.exists() and observed.read_bytes())

    def test_status_retry_repeats_only_the_same_read_only_query(self):
        calls = []
        valid = json.dumps({"task_id": self.identifier, "state": "running"}).encode()

        def runner(command, payload):
            calls.append((command, payload))
            return (255, b"") if len(calls) == 1 else (0, valid)

        command = ["ssh", "python3 -B - status --id " + self.identifier]
        value, code = task_status.query(command, b"fixture", self.identifier, attempts=3, interval=0, runner=runner)
        self.assertEqual(code, 0)
        self.assertEqual(value["state"], "running")
        self.assertEqual(calls, [(command, b"fixture"), (command, b"fixture")])

    def test_unreachable_does_not_claim_remote_state(self):
        calls = []

        def runner(command, payload):
            calls.append(command)
            return None, b""

        value, code = task_status.query(["status-only"], b"fixture", self.identifier, attempts=3, interval=0, runner=runner)
        self.assertEqual(code, 2)
        self.assertEqual(value["state"], "unknown")
        self.assertEqual(value["reason"], "ssh_status_unavailable")
        self.assertEqual(len(calls), 3)

    def test_remote_helper_error_is_unknown_without_retries(self):
        calls = []

        def runner(command, payload):
            calls.append(command)
            return 2, json.dumps({"task_id": self.identifier, "state": "unknown", "reason": "local_error"}).encode()

        value, code = task_status.query(["status-only"], b"fixture", self.identifier, attempts=3, interval=0, runner=runner)
        self.assertEqual(code, 2)
        self.assertEqual(value["reason"], "local_error")
        self.assertEqual(len(calls), 1)

    def test_invalid_remote_response_is_unknown_without_retry(self):
        calls = []

        def runner(command, payload):
            calls.append(command)
            return 0, b'not valid json'

        value, code = task_status.query(["status-only"], b"fixture", self.identifier, attempts=3, interval=0, runner=runner)
        self.assertEqual(code, 2)
        self.assertEqual(value["state"], "unknown")
        self.assertEqual(value["reason"], "invalid_status_response")
        self.assertEqual(len(calls), 1)

    def test_parse_requires_matching_id_and_finished_exit_code(self):
        bad_id = json.dumps({"task_id": str(uuid.uuid4()), "state": "running"}).encode()
        bad_exit = json.dumps({"task_id": self.identifier, "state": "finished", "exit_code": True}).encode()
        self.assertIsNone(task_status.parse_status(bad_id, self.identifier))
        self.assertIsNone(task_status.parse_status(bad_exit, self.identifier))

    def test_ssh_io_is_bounded_and_sends_eof(self):
        command = [sys.executable, "-c", "import sys; data=sys.stdin.buffer.read(); print(len(data))"]
        code, output = task_status.run_ssh(command, b"abcdef", timeout=5)
        self.assertEqual(code, 0)
        self.assertEqual(output.strip(), b"6")
        overflow = [sys.executable, "-c", "import sys; sys.stdout.write('X'*20000)"]
        code, _ = task_status.run_ssh(overflow, b"", timeout=5)
        self.assertIsNone(code)
        code, output = task_status.run_ssh(overflow, b"", timeout=5, stdout_limit=30000)
        self.assertEqual(code, 0)
        self.assertEqual(len(output), 20000)
        delayed = [sys.executable, "-c", "import time; time.sleep(5)"]
        code, _ = task_status.run_ssh(delayed, b"", timeout=0.3)
        self.assertIsNone(code)

    def test_receipt_reuses_id_and_rejects_changes_or_invalid_content(self):
        receipt = self.work / "receipt.json"
        first = task_status.receipt_id(str(receipt), "example.test", 22, "alice", None, create=True)
        self.assertEqual(task_status.receipt_id(str(receipt), "example.test", 22, "alice", None, create=True), first)
        self.assertEqual(task_status.receipt_id(str(receipt), "example.test", 22, "alice", None), first)
        with self.assertRaises(ValueError):
            task_status.receipt_id(str(receipt), "other.test", 22, "alice", None)
        with self.assertRaises(ValueError):
            task_status.receipt_id(str(receipt), "example.test", 22, "alice", None, proposed=str(uuid.uuid4()), create=True)
        receipt.write_text("not json")
        with self.assertRaises(ValueError):
            task_status.receipt_id(str(receipt), "example.test", 22, "alice", None)


if __name__ == "__main__":
    unittest.main()
