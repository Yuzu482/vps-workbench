import contextlib
import errno
import json
import os
from pathlib import Path
import pty
import runpy
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch


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
            self.assertEqual(claude_env["BROWSER"], str(home / "xdg-open"))
            self.assertEqual(claude_env["PATH"].split(":")[0], str(home))
            self.assertNotIn("ANTHROPIC_API_KEY", claude_env)
            self.assertNotIn("SSH_CONNECTION", agy_env)

    def test_oauth_opener_targets_only_the_active_profile_and_allowed_https_route(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            profile = directory / "fresh-profile"
            result = directory / "invocation"
            browser = directory / "firefox"
            browser.write_text(
                "#!/usr/bin/python3 -I\nimport json, os, sys\nfrom pathlib import Path\n"
                f"Path({str(result)!r}).write_text(json.dumps([sys.argv[1:], os.environ.get('DISPLAY'), os.environ.get('DBUS_SESSION_BUS_ADDRESS'), os.environ.get('SSH_CONNECTION')]))\n",
                encoding="utf-8",
            )
            browser.chmod(0o700)
            make_opener = source["oauth_opener"]
            with patch.dict(make_opener.__globals__, {"FIREFOX": str(browser)}):
                opener = directory / "xdg-open"
                opener.write_text(make_opener("claude-login", directory, profile), encoding="utf-8")
            opener.chmod(0o700)
            allowed = "https://claude.com/cai/oauth/authorize?state=synthetic%26fixture"
            process = subprocess.run([opener, allowed], env={"DISPLAY": ":907", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/fixture/bus", "SSH_CONNECTION": "ignored"}, capture_output=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(result.read_text(encoding="utf-8")),
                             [["--profile", str(profile), "--new-tab", allowed], ":907", "unix:path=/fixture/bus", None])
            result.unlink()
            for invalid in (
                "http://claude.ai/oauth/authorize?state=synthetic",
                "https://claude.ai@invalid.example/oauth/authorize?state=synthetic",
                "https://claude.ai.invalid.example/oauth/authorize?state=synthetic",
                "https://claude.ai:443/oauth/authorize?state=synthetic",
                "https://claude.ai/settings/account?state=synthetic",
                "https://claude.ai/oauth/authorize",
                "https://auth.openai.com/oauth/authorize?state=synthetic",
                "https://claude.ai/oauth/authorize?state=fixture\n",
                "https://claude.ai/oauth/authorize?" + "x" * 8192,
            ):
                with self.subTest(invalid=invalid[:100]):
                    process = subprocess.run([opener, invalid], capture_output=True)
                    self.assertNotEqual(process.returncode, 0)
                    self.assertFalse(result.exists())
                    self.assertNotIn(invalid.encode("ascii"), process.stderr)

    def test_display_keeps_clipboard_and_browser_remoting_scoped_to_oauth(self):
        launch = source["open_browser"]
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            for action, enabled in (("claude-login", True), ("claude-api-key", False), ("claude-account", False)):
                with self.subTest(action=action), tempfile.TemporaryDirectory(dir=home) as session:
                    directory = Path(session)
                    with patch.dict(launch.__globals__, {
                        "run_output": lambda *_: None,
                        "terminal_plan": lambda *_: (["/fixture/tool"], {"HOME": str(home)}),
                        "wait_for_display": lambda *_: None,
                        "wait_for_window": lambda *_: None,
                        "stop_process": lambda *_: None,
                        "relay": lambda *_: None,
                    }), patch("subprocess.Popen") as start, patch("socket.socket", return_value=MagicMock()), \
                            patch("shutil.which", return_value="/fixture/tigervncconfig"):
                        launch(directory, home, {"PATH": "/usr/bin"}, False, action)
                    server, browser, *others = start.call_args_list
                    server_args = server.args[0]
                    self.assertIn(f"-AcceptCutText={int(enabled)}", server_args)
                    self.assertIn(f"-SendCutText={int(enabled)}", server_args)
                    self.assertIn("-SendPrimary=0", server_args)
                    self.assertIn("-SetPrimary=0", server_args)
                    self.assertIn("-rfbunixpath", server_args)
                    port = server_args.index("-rfbport")
                    self.assertEqual(server_args[port + 1], "-1")
                    self.assertEqual(browser.args[0][1], "--new-instance" if enabled else "--no-remote")
                    self.assertEqual(browser.args[0][3], str(directory / "profile"))
                    self.assertEqual(any(call.args[0][0] == "/fixture/tigervncconfig" for call in others), enabled)
                    if action != "claude-account":
                        terminal = others[-1]
                        self.assertEqual(terminal.kwargs["env"]["DISPLAY"], browser.kwargs["env"]["DISPLAY"])
                        self.assertEqual(terminal.kwargs["env"]["XAUTHORITY"], browser.kwargs["env"]["XAUTHORITY"])

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
