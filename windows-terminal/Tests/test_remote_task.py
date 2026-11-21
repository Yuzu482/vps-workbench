import json
import importlib.util
import base64
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
from concurrent.futures import ThreadPoolExecutor

HELPER = Path(__file__).resolve().parents[1] / "RemoteTask.py"
MAX_OUTPUT = 262144
spec = importlib.util.spec_from_file_location("remote_task", HELPER)
remote_task = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote_task)


@unittest.skipUnless(sys.platform == "linux", "the remote helper requires Linux")
class RemoteTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote-task-test-")
        self.work = Path(self.temp.name)
        self.root = self.work / "state"
        self.identifier = str(uuid.uuid4())
        self.cleanup_identities = []

    def tearDown(self):
        for identity in self.cleanup_identities:
            if remote_task.same_process(identity):
                try:
                    os.kill(identity["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + 3
                while remote_task.same_process(identity) and time.monotonic() < deadline:
                    time.sleep(0.02)
                if remote_task.same_process(identity):
                    raise RuntimeError("test worker did not exit")
        self.temp.cleanup()

    def call(self, action, *args, identifier=None):
        return subprocess.run([sys.executable, str(HELPER), action, "--id", identifier or self.identifier,
                               "--state-dir", str(self.root), *args], capture_output=True, timeout=10, check=False)

    def start(self, program, *options):
        return self.call("start", "--cwd", str(self.work), *options, "--", sys.executable, "-c", program)

    def status(self):
        result = self.call("status")
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout)

    def wait_state(self, expected, timeout=8):
        deadline = time.monotonic() + timeout
        observed = None
        while time.monotonic() < deadline:
            observed = self.status()
            if observed["state"] == expected:
                return observed
            time.sleep(0.05)
        self.fail(f"Expected {expected}, last state was {observed}")

    def test_missing_status_does_not_create_state(self):
        self.assertEqual(self.status()["state"], "not_found")
        self.assertFalse(self.root.exists())

    def test_task_worker_does_not_inherit_ssh_variables(self):
        program = ("import os,json; print(json.dumps({" 
                   "'ssh': any(k.upper().startswith('SSH_') for k in os.environ), "
                   "'normal': os.environ.get('PRIVACY_TEST_MARKER')}))")
        with patch.dict(os.environ, {"SSH_CONNECTION": "private-test-value", "ssh_client": "private-test-value", "PRIVACY_TEST_MARKER": "preserved"}):
            self.assertEqual(self.start(program, "--capture-output").returncode, 0)
        self.assertEqual(self.wait_state("finished")["exit_code"], 0)
        self.assertEqual(json.loads(self.call("output").stdout), {"ssh": False, "normal": "preserved"})

    def test_argument_and_total_payload_remain_bounded(self):
        remote_task.validate_command(["/bin/echo", "x" * 12288], str(self.work))
        with self.assertRaises(ValueError):
            remote_task.validate_command(["/bin/echo", "x" * 12289], str(self.work))
        with self.assertRaises(ValueError):
            remote_task.validate_command(["/bin/echo", "x" * 12288, "x" * 12288, "x" * 12288], str(self.work))

    def test_duplicate_id_does_not_execute_twice(self):
        marker = self.work / "counter"
        program = f"from pathlib import Path; import time; p=Path({str(marker)!r}); p.open('a').write('once\\n'); time.sleep(1)"
        first = self.start(program)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(json.loads(first.stdout)["outcome"], "accepted")
        self.wait_state("running")
        duplicate = self.start(f"from pathlib import Path; Path({str(marker)!r}).open('a').write('must-not-run')")
        self.assertEqual(duplicate.returncode, 3)
        self.assertEqual(json.loads(duplicate.stdout)["outcome"], "already_exists")
        final = self.wait_state("finished")
        self.assertEqual(final["exit_code"], 0)
        self.assertEqual(marker.read_text(), "once\n")
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode) & 0o077, 0)

    def test_concurrent_duplicate_starts_allocate_once(self):
        marker = self.work / "counter"
        program = f"from pathlib import Path; import time; Path({str(marker)!r}).open('a').write('x'); time.sleep(0.5)"
        with ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(lambda _: self.start(program), range(6)))
        self.assertEqual(sorted(result.returncode for result in results), [0, 3, 3, 3, 3, 3])
        self.assertEqual(self.wait_state("finished")["exit_code"], 0)
        self.assertEqual(marker.read_text(), "x")

    def test_failure_and_optional_bounded_output(self):
        program = f"import sys; sys.stdout.write('X'*{MAX_OUTPUT + 500}); sys.stdout.flush(); sys.stderr.write('ERR'); sys.exit(7)"
        self.assertEqual(self.start(program, "--capture-output").returncode, 0)
        final = self.wait_state("finished")
        self.assertEqual(final["exit_code"], 7)
        self.assertTrue(final["output_captured"])
        self.assertTrue(final["output_truncated"])
        self.assertTrue(final["stdout_truncated"])
        self.assertFalse(final["stderr_truncated"])
        output = self.call("output")
        self.assertEqual(output.returncode, 0)
        self.assertEqual(output.stdout, b"X" * MAX_OUTPUT)
        self.assertEqual(self.call("output", "--stream", "stderr").stdout, b"ERR")
        self.assertEqual(stat.S_IMODE((self.root / self.identifier / "stdout.bin").stat().st_mode) & 0o077, 0)
        self.assertEqual(self.start("raise RuntimeError('must not run')").returncode, 3)

    def test_both_large_streams_are_drained_and_bounded(self):
        program = (f"import sys; sys.stdout.write('O'*{MAX_OUTPUT + 100}); sys.stdout.flush(); "
                   f"sys.stderr.write('E'*{MAX_OUTPUT + 100}); sys.stderr.flush()")
        self.assertEqual(self.start(program, "--capture-output").returncode, 0)
        final = self.wait_state("finished")
        self.assertEqual(final["exit_code"], 0)
        self.assertTrue(final["stdout_truncated"])
        self.assertTrue(final["stderr_truncated"])
        self.assertEqual(self.call("output").stdout, b"O" * MAX_OUTPUT)
        self.assertEqual(self.call("output", "--stream", "stderr").stdout, b"E" * MAX_OUTPUT)

    def test_default_output_is_not_saved(self):
        self.assertEqual(self.start("print('not persisted')").returncode, 0)
        final = self.wait_state("finished")
        self.assertFalse(final["output_captured"])
        self.assertFalse((self.root / self.identifier / "stdout.bin").exists())
        self.assertFalse((self.root / self.identifier / "stderr.bin").exists())

    def test_captured_output_can_be_read_before_task_finishes(self):
        program = "import sys,time; print('early-output',flush=True); time.sleep(2); print('late-output',flush=True)"
        self.assertEqual(self.start(program, "--capture-output").returncode, 0)
        self.wait_state("running")
        deadline = time.monotonic() + 1.5
        early = b""
        while time.monotonic() < deadline:
            early = self.call("output").stdout
            if b"early-output" in early:
                break
            time.sleep(0.03)
        self.assertIn(b"early-output", early)
        self.assertNotIn(b"late-output", early)
        self.assertEqual(self.wait_state("finished")["exit_code"], 0)
        self.assertIn(b"late-output", self.call("output").stdout)

    def test_failed_exec_keeps_the_id_reserved(self):
        result = self.call("start", "--cwd", str(self.work), "--", "/no-such-remote-task-executable")
        self.assertEqual(result.returncode, 0)
        self.wait_state("launch_failed")
        duplicate = self.start("raise RuntimeError('must not run')")
        self.assertEqual(duplicate.returncode, 3)
        self.assertEqual(json.loads(duplicate.stdout)["status"]["state"], "launch_failed")

    def test_streamed_helper_accepts_payload_and_detaches(self):
        encoded = base64.b64encode(HELPER.read_bytes()).decode("ascii")
        program = f'import base64;exec(base64.b64decode("{encoded}"))'
        root = base64.urlsafe_b64encode(str(self.root).encode()).decode().rstrip("=")
        payload = json.dumps({"command": [sys.executable, "-c", "print('streamed')"],
                              "cwd": str(self.work), "capture": True}).encode()
        result = subprocess.run([sys.executable, "-B", "-c", program, "start", "--id", self.identifier,
                                 "--state-dir-b64", root, "--payload-stdin"], input=payload,
                                capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["outcome"], "accepted")
        self.assertEqual(self.wait_state("finished")["exit_code"], 0)
        self.assertEqual(self.call("output").stdout.strip(), b"streamed")

    def test_reserved_missing_record_is_unknown_and_never_restarted(self):
        self.root.mkdir(mode=0o700)
        (self.root / self.identifier).mkdir(mode=0o700)
        self.assertEqual(self.status()["state"], "unknown")
        duplicate = self.start("raise RuntimeError('must not run')")
        self.assertEqual(duplicate.returncode, 3)
        self.assertEqual(json.loads(duplicate.stdout)["status"]["state"], "unknown")

    def test_stale_identity_is_unknown(self):
        self.root.mkdir(mode=0o700)
        job = self.root / self.identifier
        job.mkdir(mode=0o700)
        identity = {"pid": os.getpid(), "start_ticks": -1, "boot_id": "not-current"}
        (job / "state.json").write_text(json.dumps({"version": 1, "task_id": self.identifier, "phase": "running",
                                                   "supervisor": identity, "worker": identity}))
        self.assertEqual(self.status()["state"], "unknown")

    def test_lost_supervisor_stays_unknown_and_duplicate_is_rejected(self):
        self.assertEqual(self.start("import time; time.sleep(20)").returncode, 0)
        self.wait_state("running")
        record = json.loads((self.root / self.identifier / "state.json").read_text())
        supervisor = record["supervisor"]["pid"]
        self.cleanup_identities.append(record["worker"])
        os.kill(supervisor, signal.SIGKILL)
        self.wait_state("unknown")
        duplicate = self.start("raise RuntimeError('must not run')")
        self.assertEqual(duplicate.returncode, 3)
        self.assertEqual(json.loads(duplicate.stdout)["status"]["state"], "unknown")

    def test_unsafe_root_and_symlink_task_are_not_followed(self):
        self.root.mkdir(mode=0o755)
        self.root.chmod(0o755)
        self.assertEqual(self.status()["state"], "unknown")
        self.root.chmod(0o700)
        (self.root / self.identifier).symlink_to(self.work, target_is_directory=True)
        self.assertEqual(self.status()["state"], "unknown")
        self.assertEqual(self.start("print('must not run')").returncode, 3)


if __name__ == "__main__":
    unittest.main()
