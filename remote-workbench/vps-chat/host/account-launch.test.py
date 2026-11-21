import contextlib
import errno
import os
from pathlib import Path
import pty
import runpy
import select
import signal
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


source = runpy.run_path(str(Path(__file__).with_name("RemoteClaudeAccount.py")))
fixture_key = "sk-ant-api03-" + "synthetic-test-only-" * 3


class AccountLaunchTest(unittest.TestCase):
    def test_unencrypted_home_allows_only_web_actions(self):
        root = Path("/fixture/browser")
        choose = source["account_browser_root"]
        with patch.dict(choose.__globals__, {
            "encrypted_browser_root": lambda _: None,
            "runtime_browser_root": lambda *_: root,
        }):
            for action in source["BROWSER_URLS"]:
                self.assertEqual(choose(Path("/fixture/home"), Path("/fixture/run"), action, {}), root)
            for action in source["TERMINAL_ACTIONS"]:
                with self.assertRaisesRegex(source["AccountStartupError"], "account_encrypted_home_required"):
                    choose(Path("/fixture/home"), Path("/fixture/run"), action, {})
        with patch.dict(choose.__globals__, {"encrypted_browser_root": lambda _: root}):
            self.assertEqual(choose(Path("/fixture/home"), Path("/fixture/run"), "claude-api-key", {}), root)

    def test_website_runtime_requires_private_tmpfs(self):
        check = source["runtime_browser_root"]
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            with patch.dict(check.__globals__, {"run_output": lambda *_: b"ext4 rw"}):
                with self.assertRaisesRegex(RuntimeError, "not on tmpfs"):
                    check(runtime, {})
            with patch.dict(check.__globals__, {"run_output": lambda *_: b"tmpfs rw,noswap"}):
                browser = check(runtime, {})
                self.assertEqual(browser, runtime / "snap.firefox")
                browser.chmod(0o755)
                with self.assertRaisesRegex(RuntimeError, "not private"):
                    check(runtime, {})

    def test_terminal_launch_keeps_each_official_profile(self):
        with tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as resources:
            home = Path(temporary)
            with patch("os.access", return_value=True), patch("shutil.which", side_effect=lambda name, **_: "/fixture/" + name):
                plan = source["terminal_plan"]
                codex, codex_env = plan("codex-login", home, home, {"HOME": str(home)}, resources)
                claude, claude_env = plan("claude-login", home, home, {"HOME": str(home)}, resources)
                agy, agy_env = plan("antigravity-login", home, home, {"HOME": str(home)}, resources)
                key, _ = plan("claude-api-key", home, home, {"HOME": str(home)}, resources)
            self.assertEqual(codex, ["/fixture/codex", "-c", 'cli_auth_credentials_store="file"', "login"])
            self.assertEqual(claude, ["/fixture/claude", "auth", "login"])
            self.assertEqual(agy, ["/fixture/agy"])
            self.assertEqual(codex_env["CODEX_HOME"], str(home / ".codex"))
            self.assertEqual(claude_env["CLAUDE_CONFIG_DIR"], str(home / ".claude"))
            self.assertEqual(agy_env["HOME"], str(home / ".dsh-antigravity/home"))
            self.assertEqual(key[-1], str(home / ".config/remote-ssh"))
            self.assertNotIn("ANTHROPIC_API_KEY", claude_env)
            self.assertNotIn("SSH_CONNECTION", agy_env)

    def run_writer(self, root, confirmation, before_confirm=lambda: None):
        pid, fd = pty.fork()
        if not pid:
            os.execv(sys.executable, [sys.executable, "-I", "-c", source["KEY_WRITER"], str(root)])
        output = b""
        deadline = time.monotonic() + 4

        def read_until(marker):
            nonlocal output
            while marker not in output:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                    self.fail("VPS key writer prompt timed out")
                output += os.read(fd, 4096)

        try:
            read_until(b"(hidden):")
            os.write(fd, (fixture_key + "\n").encode("ascii"))
            read_until(b"Type SAVE")
            before_confirm()
            os.write(fd, (confirmation + "\n").encode("ascii"))
            while select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
                try:
                    chunk = os.read(fd, 4096)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output += chunk
            self.assertNotIn(fixture_key.encode("ascii"), output)
        finally:
            os.close(fd)
            done, _ = os.waitpid(pid, os.WNOHANG)
            if not done:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
        return output

    def test_private_atomic_key_write_and_conflict_preservation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            key = root / "anthropic-api-key"
            self.assertIn(b"Cancelled", self.run_writer(root, "CANCEL"))
            self.assertFalse(key.exists())
            self.assertIn(b"API key saved", self.run_writer(root, "SAVE"))
            self.assertEqual(key.read_text(encoding="ascii").strip(), fixture_key)
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
            self.assertEqual(key.stat().st_nlink, 1)
            output = self.run_writer(root, "SAVE", lambda: key.write_text("changed elsewhere", encoding="ascii"))
            self.assertIn(b"key changed", output)
            self.assertEqual(key.read_text(encoding="ascii"), "changed elsewhere")
            self.assertEqual(list(root.glob(".account-key-*")), [])


if __name__ == "__main__":
    unittest.main()
