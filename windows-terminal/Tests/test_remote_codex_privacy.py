import contextlib
import base64
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import socket
import subprocess
import unittest
import zlib
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / "RemoteCodexPrivacy.py"
spec = importlib.util.spec_from_file_location("privacy", path)
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)
V4 = ipaddress.ip_address("203.0.113.4")
V6 = ipaddress.ip_address("2001:db8::4")


class PrivacyTests(unittest.TestCase):
    def test_design_frame_accepts_bounded_unicode_context_and_ordinary_input_keeps_its_limit(self):
        prompt, frozen = "brief", "参" * 24000
        for design, field in ((True, "design"), (False, "memory")):
            data = json.dumps({"prompt": prompt, field: frozen}, ensure_ascii=False).encode()
            with patch.object(privacy.sys, "stdin", io.TextIOWrapper(io.BytesIO(data))):
                if design:
                    frame = json.loads(privacy.api_chat_input(True))
                    self.assertEqual([item["text"] for item in frame["message"]["content"]], [prompt, frozen])
                else:
                    with self.assertRaises(ValueError):
                        privacy.api_chat_input(False)

    def test_removes_case_insensitive_ssh_names_only(self):
        self.assertEqual(privacy.clean_environment({"SSH_CONNECTION": "secret", "ssh_client": "secret2", "PATH": "ok"}), {"PATH": "ok"})

    def test_expected_ssh_source_matches_only_well_formed_current_connection(self):
        self.assertTrue(privacy.matches_ssh_source("203.0.113.4", {"SSH_CONNECTION": "203.0.113.4 2345 192.0.2.8 22"}))
        for source in ("", "203.0.113.5 2345 192.0.2.8 22", "203.0.113.4 invalid 192.0.2.8 22", "203.0.113.4 2345 192.0.2.8 0"):
            self.assertFalse(privacy.matches_ssh_source("203.0.113.4", {"SSH_CONNECTION": source}))

    def test_mismatched_source_blocks_before_network_or_exec(self):
        out = io.StringIO()
        with patch.dict(os.environ, {"SSH_CONNECTION": "203.0.113.5 1234 192.0.2.8 22"}, clear=True), \
             patch.object(privacy, "preflight") as preflight, patch.object(privacy.os, "execve") as execute, \
             contextlib.redirect_stderr(out):
            self.assertEqual(privacy.main(["--expected-ipv4", str(V4), "--expected-ssh-source", "203.0.113.4"]), 1)
        preflight.assert_not_called(); execute.assert_not_called()
        self.assertNotIn("203.0.113.5", out.getvalue())

    def test_proxy_and_override_block_without_printing_values_or_probing(self):
        for variable in ("HTTPS_PROXY", "all_proxy", "OPENAI_BASE_URL"):
            out = io.StringIO()
            with self.subTest(variable=variable), contextlib.redirect_stdout(out), patch.object(privacy, "samples") as samples:
                self.assertFalse(privacy.preflight(V4, None, {variable: "secret-value"}))
                samples.assert_not_called()
                self.assertNotIn("secret-value", out.getvalue())
                self.assertIn(variable, out.getvalue())

    def test_subscription_routes_and_provider_mismatch_are_fail_closed(self):
        with patch.object(privacy, "samples", return_value={4: [V4] * 4, 6: [None] * 4}), \
             patch.object(privacy, "route_checks", return_value={4: "found", 6: "no_route_observed"}) as routes, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(privacy.preflight(V4, None, {}, "claude-subscription"))
            self.assertEqual(routes.call_args.args[1], ("api.anthropic.com", "platform.claude.com"))
        common = ["--expected-ipv4", str(V4), "--isolation-code", "eA==", "--isolation-workspace", "/tmp/project"]
        cases = [("claude", ["claude", "-p", "--chat-auth", "subscription"]),
                 ("claude-subscription", ["claude", "-p"]),
                 ("claude-subscription", ["codex", "exec", "--chat-auth", "subscription"])]
        for provider, command in cases:
            with self.subTest(provider=provider), patch.object(privacy, "preflight") as check, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(privacy.main(common + ["--provider", provider, "--", *command]), 2)
                check.assert_not_called()

    def preflight(self, v4, v6, route6="no_route_observed", expected6=None, route4="found"):
        with patch.object(privacy, "samples", return_value={4: v4, 6: v6}), \
             patch.object(privacy, "route_checks", return_value={4: route4, 6: route6}), \
             contextlib.redirect_stdout(io.StringIO()):
            return privacy.preflight(V4, expected6, {})

    def test_ipv4_mismatch_incomplete_or_unknown_route_blocks(self):
        self.assertTrue(self.preflight([V4]*4, [None]*4))
        self.assertFalse(self.preflight([V4]*3 + [None], [None]*4))
        self.assertFalse(self.preflight([V4]*3 + [ipaddress.ip_address("203.0.113.5")], [None]*4))
        self.assertFalse(self.preflight([V4]*4, [None]*4, route4="unknown"))

    def test_ipv6_requires_expected_and_complete_samples_when_seen_or_uncertain(self):
        self.assertFalse(self.preflight([V4]*4, [None]*4, route6="found"))
        self.assertFalse(self.preflight([V4]*4, [None]*4, route6="unknown"))
        self.assertFalse(self.preflight([V4]*4, [None]*4, expected6=V6))
        self.assertFalse(self.preflight([V4]*4, [V6]*4, route6="unknown", expected6=V6))
        self.assertFalse(self.preflight([V4]*4, [V6]*3 + [None], route6="found", expected6=V6))
        self.assertTrue(self.preflight([V4]*4, [V6]*4, route6="found", expected6=V6))
        self.assertFalse(self.preflight([V4]*4, [V6]*4))

    def test_main_executes_with_cleaned_environment_and_original_arguments(self):
        class Executed(Exception): pass
        with patch.dict(os.environ, {"PATH": "/bin", "SSH_CONNECTION": "secret", "ssh_client": "secret2", "NORMAL": "kept"}, clear=True), \
             patch.object(privacy, "preflight", return_value=True), patch.object(privacy.shutil, "which", return_value="/bin/codex"), \
             patch.object(privacy.os, "execve", side_effect=Executed) as execute:
            with self.assertRaises(Executed):
                privacy.main(["--expected-ipv4", str(V4), "--", "codex", "exec", "hello"])
        program, args, environment = execute.call_args.args
        self.assertEqual(program, "/bin/codex")
        self.assertEqual(args, ["codex", "exec", "hello"])
        self.assertEqual(environment, {"PATH": "/bin", "NORMAL": "kept"})

    def test_codex_home_bin_fallback_when_ssh_path_omits_it(self):
        class Executed(Exception): pass
        with patch.dict(os.environ, {"HOME": "/home/test", "PATH": "/usr/bin", "SSH_CONNECTION": "private"}, clear=True), \
             patch.object(privacy, "preflight", return_value=True), patch.object(privacy.shutil, "which", return_value=None), \
             patch.object(privacy.os.path, "isfile", return_value=True), patch.object(privacy.os, "access", return_value=True), \
             patch.object(privacy.os, "execve", side_effect=Executed) as execute:
            with self.assertRaises(Executed):
                privacy.main(["--expected-ipv4", str(V4)])
        self.assertEqual(execute.call_args.args[0], os.path.join("/home/test", ".local", "bin", "codex"))
        self.assertNotIn("SSH_CONNECTION", execute.call_args.args[2])

    def test_isolation_invokes_only_the_isolated_runner_with_clean_environment(self):
        source = b"def run(program, command, workspace, environment):\n assert program == '/fixture/codex'\n assert workspace == '/tmp/project'\n assert 'SSH_CONNECTION' not in environment\n return 23\n"
        payload = base64.b64encode(zlib.compress(source)).decode("ascii")
        with patch.dict(os.environ, {"PATH": "/bin", "SSH_CONNECTION": "private"}, clear=True), \
             patch.object(privacy, "preflight", return_value=True), patch.object(privacy.shutil, "which", return_value="/fixture/codex"), \
             patch.object(privacy.os, "execve") as execute:
            result = privacy.main(["--expected-ipv4", str(V4), "--isolation-code", payload,
                                   "--isolation-workspace", "/tmp/project", "--", "codex", "exec", "test"])
        self.assertEqual(result, 23)
        execute.assert_not_called()

    def test_invalid_isolation_parameters_never_run_a_network_check_or_codex(self):
        cases = [["--isolation-code", "missing-workspace"],
                 ["--isolation-workspace", "/tmp/project"],
                 ["--isolation-code", "x" * 12289, "--isolation-workspace", "/tmp/project"]]
        for extra in cases:
            with self.subTest(extra=extra[:1]), patch.object(privacy, "preflight") as preflight, \
                 patch.object(privacy.os, "execve") as execute, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(privacy.main(["--expected-ipv4", str(V4), *extra, "--", "codex", "exec"]), 2)
                preflight.assert_not_called(); execute.assert_not_called()

    def test_resolver_program_and_route_results_are_checked(self):
        def fake(command, **kwargs):
            if command[1:3] == ["-I", "-c"]:
                values = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (str(V4), 443)),
                          (socket.AF_INET6, socket.SOCK_STREAM, 0, "", (str(V6), 443, 0, 0))]
                output = io.StringIO()
                with patch.object(socket, "getaddrinfo", return_value=values), contextlib.redirect_stdout(output):
                    exec(command[3], {})
                return subprocess.CompletedProcess(command, 0, output.getvalue().encode(), b"")
            if command[1:4] == ["-6", "route", "show"]:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if command[1] == "-6":
                return subprocess.CompletedProcess(command, 2, b"", b"Network is unreachable")
            return subprocess.CompletedProcess(command, 0, b"route", b"")
        with patch.object(privacy.subprocess, "run", side_effect=fake):
            self.assertEqual(privacy.route_checks({}), {4: "found", 6: "no_route_observed"})

    def test_unknown_route_error_is_not_reported_as_unreachable(self):
        result = {host: [str(V4), str(V6)] for host in privacy.HOSTS}
        def fake(command, **kwargs):
            if command[1:3] == ["-I", "-c"]:
                return subprocess.CompletedProcess(command, 0, json.dumps(result).encode(), b"")
            if command[1:4] == ["-6", "route", "show"]:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if command[1] == "-6":
                return subprocess.CompletedProcess(command, 1, b"", b"unexpected error")
            return subprocess.CompletedProcess(command, 0, b"route", b"")
        with patch.object(privacy.subprocess, "run", side_effect=fake):
            self.assertEqual(privacy.route_checks({})[6], "unknown")


if __name__ == "__main__":
    unittest.main()
