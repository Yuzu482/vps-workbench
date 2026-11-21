"""Local synthetic isolation checks. No real credentials, VPS, or internet."""
import importlib.util
import base64
import errno
import fcntl
import hashlib
import json
import io
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import uuid
import zlib
from unittest.mock import patch


HELPER = Path(__file__).resolve().parents[1] / "RemoteCodexIsolate.py"
spec = importlib.util.spec_from_file_location("codex_isolate", HELPER)
isolated = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolated)
native = types.ModuleType("native_session")
exec(compile(HELPER.read_bytes() + b"\n" + (HELPER.parent / "RemoteNativeSafety.py").read_bytes() + b"\n" + (HELPER.parent / "RemoteNativeSession.py").read_bytes(), "<native-fixture>", "exec"), native.__dict__)
chat_spec = importlib.util.spec_from_file_location("chat_files", HELPER.parent / "RemoteChatFiles.py")
chat_files = importlib.util.module_from_spec(chat_spec)
chat_spec.loader.exec_module(chat_files)
auth_spec = importlib.util.spec_from_file_location("claude_auth", HELPER.parent / "RemoteClaudeAuth.py")
claude_auth = importlib.util.module_from_spec(auth_spec)
auth_spec.loader.exec_module(claude_auth)
claude_auth.native_directory_safe = native.native_directory_safe
shared_spec = importlib.util.spec_from_file_location("claude_shared", HELPER.parent / "RemoteClaudeShared.py")
claude_shared = importlib.util.module_from_spec(shared_spec)
shared_spec.loader.exec_module(claude_shared)
for shared_name in ("shared_root", "shared_lock", "shared_verify", "shared_overlays"):
    setattr(isolated, shared_name, getattr(claude_shared, shared_name))
for shared_name in ("shared_id", "shared_root", "shared_lock", "shared_verify", "shared_overlays"):
    setattr(claude_auth, shared_name, getattr(claude_shared, shared_name))


def recv_header(connection):
    data = b""
    while b"\r\n\r\n" not in data and len(data) < 8192:
        part = connection.recv(1024)
        if not part:
            break
        data += part
    return data


class EncryptedCredentialStorageTests(unittest.TestCase):
    def test_requires_private_file_on_luks2_home(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            key = home / ".config" / "remote-ssh" / "anthropic-api-key"
            key.parent.mkdir(parents=True)
            key.write_text("fixture-not-a-key", encoding="utf-8")
            key.chmod(0o600)

            def device_id(value):
                return patch.object(isolated.Path, "open", return_value=io.StringIO(value))

            device = "CRYPT-LUKS2-" + "b" * 32 + "-fixture-user"
            with device_id(device) as read_identifier:
                self.assertTrue(isolated.dsh_api_storage_ready(str(home)))
                path = read_identifier.call_args
                self.assertEqual(path.kwargs["encoding"], "ascii")
            with device_id("CRYPT-LUKS1-" + "b" * 32 + "-fixture-user"):
                self.assertFalse(isolated.dsh_api_storage_ready(str(home)))
            with patch.object(isolated.Path, "open", side_effect=FileNotFoundError):
                self.assertFalse(isolated.dsh_api_storage_ready(str(home)))
            with device_id(device):
                key.chmod(0o644)
                self.assertFalse(isolated.dsh_api_storage_ready(str(home)))
            key.chmod(0o600)
            redirected = home / "another-key"
            key.rename(redirected)
            key.symlink_to(redirected)
            with device_id(device):
                self.assertFalse(isolated.dsh_api_storage_ready(str(home)))

    def test_encrypted_dsh_turn_stops_before_start_on_unverified_home(self):
        with patch.object(isolated, "dsh_api_storage_ready", return_value=False), \
                patch.object(isolated, "validate_paths") as startup, patch("sys.stderr", io.StringIO()) as errors:
            self.assertEqual(isolated.run("claude", ["claude", "-p", "--dsh-encrypted-credentials"],
                                          "/fixture", {"HOME": "/fixture-home"}), 2)
            self.assertIn("LUKS2", errors.getvalue())
            startup.assert_not_called()


@unittest.skipUnless(sys.platform == "linux" and os.getuid() != 0, "requires an unprivileged Linux user")
class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codex-isolate-test-")
        self.root = Path(self.temp.name)
        self.home = self.root / "host-home"
        self.home.mkdir()
        (self.home / ".codex").mkdir()
        self.auth = self.home / ".codex" / "auth.json"
        self.auth.write_text('{"fake":"test-only"}')
        self.auth.chmod(0o600)
        self.work = self.root / "project"
        self.work.mkdir()
        self.environment = {"HOME": str(self.home), "SSH_CONNECTION": "203.0.113.93 23456 192.0.2.8 22",
                            "CLIENT_SOURCE_MARKER": "203.0.113.93", "HTTP_PROXY": "untrusted-proxy-value"}

    def tearDown(self):
        self.temp.cleanup()

    def test_rejects_home_sensitive_paths_and_insecure_auth(self):
        executable = os.path.realpath(sys.executable)
        isolated.validate_paths(executable, str(self.work), self.environment)
        for path in (self.home, self.home / ".codex", self.root):
            with self.subTest(path=path), self.assertRaises(ValueError):
                isolated.validate_paths(executable, str(path), self.environment)
        self.auth.chmod(0o644)
        with self.assertRaises(ValueError):
            isolated.validate_paths(executable, str(self.work), self.environment)

    def test_subscription_profile_and_native_status_are_private_and_filtered(self):
        session = str(uuid.uuid4())
        root, native, config = claude_auth.prepare(session, self.environment)
        self.assertEqual(root.stat().st_mode & 0o777, 0o700)
        self.assertEqual(native.stat().st_mode & 0o777, 0o700)
        self.assertEqual(config.stat().st_mode & 0o777, 0o700)
        self.assertNotEqual(claude_auth.prepare(str(uuid.uuid4()), self.environment)[2], config)
        result = {"loggedIn": True, "authMethod": "claude.ai", "email": "fixture-private@example.test", "token": "fixture-secret"}
        def fake_run(argv, **kwargs):
            self.assertIn("--unshare-net", argv)
            self.assertIn("--clearenv", argv)
            self.assertIn("--ro-bind", argv)
            self.assertNotIn("SSH_CONNECTION", kwargs["env"])
            kwargs["stdout"].write(json.dumps(result).encode())
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(claude_auth, "native_executable", return_value=sys.executable), patch.object(claude_auth.subprocess, "run", side_effect=fake_run):
            self.assertEqual(claude_auth.status(session, self.environment), "ready")
            result["authMethod"] = "api_key"
            self.assertEqual(claude_auth.status(session, self.environment), "wrong_auth")
            result["authMethod"] = "claude.ai"; result["configDirectory"] = "/different-profile"
            self.assertEqual(claude_auth.status(session, self.environment), "wrong_profile")
            result["configDirectory"] = "/home/codex/.claude"
            self.assertEqual(claude_auth.status(session, self.environment), "ready")
            with (root / "session.lock").open("r+b") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(claude_auth.status(session, self.environment), "busy")
        self.assertEqual(claude_auth.status(str(uuid.uuid4()), {"HOME": str(self.home), "PATH": "/empty-fixture"}), "cli_missing")
        cli = self.home / ".local" / "bin" / "claude"; cli.parent.mkdir(parents=True)
        cli.write_text("#!/bin/sh\nexit 0\n"); cli.chmod(0o700)
        self.assertEqual(claude_auth.status(str(uuid.uuid4()), {"HOME": str(self.home), "PATH": "/empty-fixture"}), "cli_unsupported")
        config.chmod(0o755)
        with self.assertRaises(ValueError): claude_auth.prepare(session, self.environment)

    def test_native_status_uses_one_remote_account_and_respects_session_lock(self):
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        root1, home1, config1, account1 = claude_auth.prepare_native(first, self.environment)
        root2, home2, config2, account2 = claude_auth.prepare_native(second, self.environment)
        self.assertNotEqual(root1, root2)
        self.assertEqual((home1, config1, account1), (home2, config2, account2))
        self.assertEqual(config1, self.home / ".claude")
        def fake_run(argv, **kwargs):
            self.assertIn("--unshare-net", argv); self.assertIn(str(config1), argv)
            self.assertNotIn("SSH_CONNECTION", kwargs["env"])
            kwargs["stdout"].write(b'{"loggedIn":true,"authMethod":"claude.ai","email":"fixture-private"}')
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(claude_auth, "native_executable", return_value=sys.executable), patch.object(claude_auth.subprocess, "run", side_effect=fake_run):
            self.assertEqual(claude_auth.status(first, self.environment, use_native=True), "ready")
            self.assertEqual(claude_auth.status(second, self.environment, use_native=True), "ready")
            with native.native_lock(root1):
                self.assertEqual(claude_auth.status(first, self.environment, use_native=True), "busy")
                self.assertEqual(claude_auth.status(second, self.environment, use_native=True), "ready")

    def test_native_profiles_share_login_and_keep_distinct_session_ids(self):
        runtime = self.root / "runtime-native"; runtime.mkdir()
        for name in ("codex", "claude"): shutil.copy2(os.path.realpath(sys.executable), runtime / name)
        claude = self.home / ".claude"; claude.mkdir(mode=0o700)
        credential = claude / ".credentials.json"; credential.write_text('{"fixture":"claude"}'); credential.chmod(0o600)
        probe = r'''
import json,os,pathlib,sys
provider,session,roundno=sys.argv[1:]; profile=pathlib.Path('/home/codex/.'+provider)
assert not any(k.upper().startswith('SSH_') for k in os.environ)
assert 'CLIENT_SOURCE_MARKER' not in os.environ and not pathlib.Path('/var/log').exists()
assert not pathlib.Path('/home/codex/.ssh').exists()
if provider=='claude':
 assert json.loads(sys.stdin.read())['message']['content'][0]['text']=='fixture message'
 assert 'ANTHROPIC_API_KEY' not in os.environ
 assert json.loads((profile/'.credentials.json').read_text())['fixture']=='claude'
else:
 assert json.loads((profile/'auth.json').read_text())['fake']=='test-only'
h=profile/'sessions'; h.mkdir(exist_ok=True); p=h/session
if roundno=='2': assert p.read_text()=='first\n'
else: assert not p.exists()
with p.open('a') as out: out.write('first\n' if roundno=='1' else 'second\n')
'''
        for provider in ("codex", "claude"):
            first, second = str(uuid.uuid4()), str(uuid.uuid4())
            for session, roundno in ((first, "1"), (second, "1"), (first, "2"), (second, "2")):
                if provider == "codex": command = ["codex", "exec", "--chat-session", session]
                else: command = ["claude", "-p", "--chat-auth", "subscription", "--chat-session", session, "--chat-prompt", "fixture message"]
                session_root = self.home / ".remote-ssh-chat" / session
                if session_root.exists():
                    for _ in range(60):
                        try:
                            with native.native_lock(session_root): break
                        except BlockingIOError: time.sleep(.05)
                    else: self.fail("native session lease remained after sandbox exit")
                self.assertEqual(native.run(str(runtime / provider), command, str(self.work), self.environment,
                                            _argv_override=["-I", "-c", probe, provider, session, roundno]), 0)
            for session in (first, second):
                self.assertEqual((self.home / ("." + provider) / "sessions" / session).read_text(), "first\nsecond\n")
            for _ in range(60):
                try:
                    with native.native_lock(session_root): break
                except BlockingIOError: time.sleep(.05)
            else: self.fail("native session lease remained after sandbox exit")
            with native.native_lock(session_root):
                self.assertEqual(native.run(str(runtime / provider), command, str(self.work), self.environment,
                                            _argv_override=["-I", "-c", "raise AssertionError('must not start')"]), 2)
        self.assertFalse((self.home / ".remote-ssh-chat" / "native-claude" / "home" / ".claude" / ".credentials.json").exists())

    def test_native_distinct_sessions_can_run_concurrently(self):
        runtime = self.root / "runtime-parallel"; runtime.mkdir()
        shutil.copy2(os.path.realpath(sys.executable), runtime / "codex")
        sessions = [str(uuid.uuid4()), str(uuid.uuid4())]
        probe = r'''
import pathlib,sys,time
path=pathlib.Path('/workspace')
(path/('started-'+sys.argv[1])).write_text('fixture')
for _ in range(100):
 if all((path/('started-'+x)).exists() for x in ('0','1')): break
 time.sleep(.05)
else: raise RuntimeError('sessions did not overlap')
'''
        results = [None, None]
        def run(index):
            command = ["codex", "exec", "--chat-session", sessions[index]]
            results[index] = native.run(str(runtime / "codex"), command, str(self.work), self.environment,
                                        _argv_override=["-I", "-c", probe, str(index)])
        workers = [threading.Thread(target=run, args=(index,)) for index in range(2)]
        for worker in workers: worker.start()
        for worker in workers: worker.join(15)
        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(results, [0, 0])

    def test_native_profile_rejects_unsafe_or_missing_accounts_without_fallback(self):
        runtime = self.root / "runtime-native-bad"; runtime.mkdir()
        for name in ("codex", "claude"): shutil.copy2(os.path.realpath(sys.executable), runtime / name)
        codex = ["codex", "exec", "--chat-session", str(uuid.uuid4())]
        claude = ["claude", "-p", "--chat-auth", "subscription", "--chat-session", str(uuid.uuid4()), "--chat-prompt", "fixture"]
        (self.home / ".codex").chmod(0o777)
        with patch.object(native.subprocess, "run") as execute:
            self.assertEqual(native.run(str(runtime / "codex"), codex, str(self.work), self.environment), 2)
            execute.assert_not_called()
        (self.home / ".claude").symlink_to(self.work, target_is_directory=True)
        with patch.object(native.subprocess, "run") as execute:
            self.assertEqual(native.run(str(runtime / "claude"), claude, str(self.work), self.environment), 2)
            execute.assert_not_called()

    def test_native_private_primary_group_is_allowed_only_when_unshared_and_without_acl(self):
        profile = self.home / ".codex"; profile.chmod(0o775); info = profile.lstat()
        me = types.SimpleNamespace(pw_name="fixture", pw_gid=info.st_gid, pw_uid=os.getuid())
        group = types.SimpleNamespace(gr_name="fixture", gr_mem=[])
        local_sources = "passwd: files systemd\ngroup: files systemd\n"
        no_acl = OSError(errno.ENODATA, "no ACL")
        with patch.object(native, "open", side_effect=lambda *args, **kwargs: io.StringIO(local_sources), create=True), \
             patch.object(native.pwd, "getpwuid", return_value=me), patch.object(native.pwd, "getpwall", return_value=[me]), \
             patch.object(native.grp, "getgrgid", return_value=group), patch.object(native.os, "getxattr", side_effect=no_acl):
            self.assertTrue(native.native_directory_safe(profile, info))
            group.gr_mem = ["other"]
            self.assertFalse(native.native_directory_safe(profile, info))
            group.gr_mem = []
            with patch.object(native.pwd, "getpwall", return_value=[me, types.SimpleNamespace(pw_gid=info.st_gid, pw_uid=os.getuid()+1)]):
                self.assertFalse(native.native_directory_safe(profile, info))
            with patch.object(native.os, "getxattr", return_value=b"named ACL"):
                self.assertFalse(native.native_directory_safe(profile, info))
            with patch.object(native.os, "getxattr", side_effect=OSError(errno.EACCES, "unknown")):
                self.assertFalse(native.native_directory_safe(profile, info))
            with patch.object(native, "open", return_value=io.StringIO("passwd: files sss\ngroup: files sss\n"), create=True):
                self.assertFalse(native.native_directory_safe(profile, info))
            with patch.object(native, "open", return_value=io.StringIO(local_sources + "initgroups: files sss\n"), create=True):
                self.assertFalse(native.native_directory_safe(profile, info))
            profile.chmod(0o777)
            self.assertFalse(native.native_directory_safe(profile, profile.lstat()))

    def test_shared_profile_guards_history_and_refuses_unexpected_entries(self):
        source, child = str(uuid.uuid4()), str(uuid.uuid4())
        source_root, _, source_config = claude_auth.prepare(source, self.environment)
        _, _, child_config = claude_auth.prepare(child, self.environment)
        credential = source_config / ".credentials.json"; credential.write_text('{"fixture":1}'); credential.chmod(0o600)
        (source_config / "projects").mkdir(mode=0o700)
        (source_config / "projects" / "source-private").write_text("fixture-source")
        (source_config / "settings.json").write_text('{"fixture":"source"}')
        (source_config / "settings.json").chmod(0o600)
        with claude_shared.shared_lock(source_root):
            with self.assertRaises(BlockingIOError): claude_shared.shared_lock(source_root)
            config, entries = claude_shared.shared_verify(source_root, source, create=True)
            overlays = claude_shared.shared_overlays(config, entries, child_config)
            self.assertEqual({Path(target).name for _, target in overlays}, {"projects", "settings.json"})
            self.assertFalse((child_config / "projects" / "source-private").exists())
            self.assertEqual((child_config / "settings.json").read_text(), "")
            self.assertFalse((child_config / ".credentials.json").exists())
            self.assertEqual(claude_shared.shared_verify(source_root, source)[1], entries)
            (source_config / "unexpected-new-file").write_text("fixture")
            with self.assertRaises(claude_shared.SharedProfileError): claude_shared.shared_verify(source_root, source)
        self.assertEqual(credential.read_text(), '{"fixture":1}')

    def test_shared_profile_rejects_symlinks_and_existing_child_credentials(self):
        source, child = str(uuid.uuid4()), str(uuid.uuid4())
        source_root, _, source_config = claude_auth.prepare(source, self.environment)
        _, _, child_config = claude_auth.prepare(child, self.environment)
        credential = source_config / ".credentials.json"; credential.write_text("fixture"); credential.chmod(0o600)
        (source_config / "unsafe").symlink_to(self.work, target_is_directory=True)
        with self.assertRaises(claude_shared.SharedProfileError): claude_shared.shared_verify(source_root, source, create=True)
        (source_config / "unsafe").unlink()
        config, entries = claude_shared.shared_verify(source_root, source, create=True)
        (child_config / ".credentials.json").write_text("fixture-child")
        with self.assertRaises(claude_shared.SharedProfileError): claude_shared.shared_overlays(config, entries, child_config)

    def test_shared_status_initializes_policy_and_never_returns_account_metadata(self):
        source, child = str(uuid.uuid4()), str(uuid.uuid4())
        source_root, _, config = claude_auth.prepare(source, self.environment)
        credential = config / ".credentials.json"; credential.write_text("fixture-only"); credential.chmod(0o600)
        (config / "projects").mkdir(mode=0o700); (config / "projects" / "source-private").write_text("fixture")
        def fake_run(argv, **kwargs):
            self.assertIn("--unshare-net", argv)
            self.assertIn(str(config), argv)
            self.assertTrue(any(".remote-ssh-chat/" + child + "/claude-home/projects" in part for part in argv))
            kwargs["stdout"].write(json.dumps({"loggedIn":True,"authMethod":"claude.ai","email":"fixture-private"}).encode())
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(claude_auth, "native_executable", return_value=sys.executable), patch.object(claude_auth.subprocess, "run", side_effect=fake_run):
            self.assertEqual(claude_auth.status(child, self.environment, source), "ready")
            self.assertTrue((source_root / claude_shared.SHARED_POLICY).is_file())
            with claude_shared.shared_lock(source_root):
                self.assertEqual(claude_auth.status(child, self.environment, source), "busy")
            (config / "unexpected").write_text("fixture")
            self.assertEqual(claude_auth.status(child, self.environment, source), "shared_profile_changed")
            self.assertEqual(claude_auth.status(source, self.environment), "shared_profile_changed")

    def test_shared_subscription_runs_isolated_conversations_and_serializes_refresh(self):
        runtime = self.root / "runtime-shared"; runtime.mkdir()
        shutil.copy2(os.path.realpath(sys.executable), runtime / "claude")
        source, first, second = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        source_root, _, config = claude_auth.prepare(source, self.environment)
        credential = config / ".credentials.json"; credential.write_text('{"generation":1}'); credential.chmod(0o600)
        (config / "projects").mkdir(mode=0o700); (config / "projects" / "source-private").write_text("fixture-source")
        (config / ".claude.json").write_text('{"fixture":"source-private"}'); (config / ".claude.json").chmod(0o600)
        with claude_shared.shared_lock(source_root): claude_shared.shared_verify(source_root, source, create=True)
        probe = r'''
import json,os,pathlib,sys
value=json.loads(sys.stdin.read()); marker=value['message']['content'][0]['text']
p=pathlib.Path('/home/codex/.claude')
assert not (p/'projects'/'source-private').exists()
assert not (p/'projects'/('first' if marker=='second' else 'second')).exists()
assert 'source-private' not in (p/'.claude.json').read_text()
assert not any(key.upper().startswith('SSH_') for key in os.environ)
assert 'ANTHROPIC_API_KEY' not in os.environ
(p/'projects'/marker).write_text('fixture-'+marker)
cred=p/'.credentials.json'; old=json.loads(cred.read_text()); temp=p/'.credential-refresh-tmp'
temp.write_text(json.dumps({'generation':old['generation']+1})); temp.chmod(0o600); os.replace(temp,cred)
'''
        def command(session, message):
            return ["claude", "-p", "--chat-auth", "subscription", "--chat-auth-source", source,
                    "--chat-session", session, "--chat-prompt", message]
        native_run = subprocess.run
        def checked_run(argv, **kwargs):
            lease = int(argv[argv.index("--sync-fd") + 1])
            self.assertEqual(kwargs["pass_fds"], (lease,))
            with self.assertRaises(BlockingIOError): claude_shared.shared_lock(source_root)
            return native_run(argv, **kwargs)
        def wait_for_lease():
            for _ in range(60):
                try:
                    with claude_shared.shared_lock(source_root): return
                except BlockingIOError:
                    time.sleep(.05)
            self.fail("sandbox retained account lease after exit")
        for session, message in ((first, "first"), (second, "second")):
            wait_for_lease()
            with patch.object(isolated.subprocess, "run", side_effect=checked_run):
                self.assertEqual(isolated.run(str(runtime / "claude"), command(session, message), str(self.work), self.environment,
                                              _argv_override=["-I", "-c", probe]), 0)
        wait_for_lease()
        source_command = ["claude", "-p", "--chat-auth", "subscription", "--chat-session", source, "--chat-prompt", "source"]
        with patch.object(isolated.subprocess, "run", side_effect=checked_run):
            self.assertEqual(isolated.run(str(runtime / "claude"), source_command, str(self.work), self.environment,
                                          _argv_override=["-I", "-c", "pass"]), 0)
        wait_for_lease()
        self.assertEqual(json.loads(credential.read_text()), {"generation": 3})
        self.assertEqual((config / "projects" / "source-private").read_text(), "fixture-source")
        for session, marker, other in ((first, "first", "second"), (second, "second", "first")):
            own = self.home / ".remote-ssh-chat" / session / "claude-home" / "projects"
            self.assertTrue((own / marker).is_file()); self.assertFalse((own / other).exists())
            self.assertFalse((own.parent / ".credentials.json").exists())
        with claude_shared.shared_lock(source_root):
            self.assertEqual(isolated.run(str(runtime / "claude"), command(first, "first"), str(self.work), self.environment,
                                          _argv_override=["-I", "-c", probe]), 2)
        bad = "import pathlib; pathlib.Path('/home/codex/.claude/unexpected-sidecar').write_text('fixture-private')"
        error = io.StringIO()
        with patch.object(isolated.sys, "stderr", error):
            self.assertEqual(isolated.run(str(runtime / "claude"), command(first, "first"), str(self.work), self.environment,
                                          _argv_override=["-I", "-c", bad]), 2)
        self.assertTrue((config / "unexpected-sidecar").is_file())
        self.assertIn("任务可能已执行", error.getvalue())
        self.assertEqual(isolated.run(str(runtime / "claude"), source_command, str(self.work), self.environment,
                                      _argv_override=["-I", "-c", "raise AssertionError('must not execute')"]), 2)

    def test_subscription_isolated_cli_uses_persistent_native_profile_without_api_key(self):
        runtime = self.root / "runtime-subscription"; runtime.mkdir()
        shutil.copy2(os.path.realpath(sys.executable), runtime / "claude")
        session = str(uuid.uuid4())
        _, native, config = claude_auth.prepare(session, self.environment)
        credential = config / ".credentials.json"
        credential.write_text('{"fake":"first"}'); credential.chmod(0o600)
        probe = r'''
import json,os,pathlib,sys
message=json.loads(sys.stdin.read())
assert message['message']['content'][0]['text']=='fixture message'
assert not any(k.upper().startswith('SSH_') for k in os.environ)
assert 'ANTHROPIC_API_KEY' not in os.environ and 'CLAUDE_CODE_OAUTH_TOKEN' not in os.environ
assert not pathlib.Path('/run/anthropic-key').exists()
assert not pathlib.Path('/home/codex/.codex/auth.json').exists()
assert os.environ['ENABLE_CLAUDEAI_MCP_SERVERS']=='false'
p=pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])/'.credentials.json'
v=json.loads(p.read_text()); tmp=p.with_suffix('.new'); tmp.write_text(json.dumps({'fake':v['fake']+'x'})); os.replace(tmp,p)
h=pathlib.Path(os.environ['HOME'])/'.claude.json'; h.write_text((h.read_text() if h.exists() else '')+'round\n')
'''
        command = ["claude", "-p", "--chat-auth", "subscription", "--chat-session", session, "--chat-prompt", "fixture message"]
        for _ in range(2):
            self.assertEqual(isolated.run(str(runtime / "claude"), command, str(self.work), self.environment,
                                          _argv_override=["-I", "-c", probe]), 0)
        self.assertEqual(json.loads(credential.read_text()), {"fake": "firstxx"})
        self.assertEqual((native / ".claude.json").read_text(), "round\nround\n")
        self.assertIn("platform.claude.com", isolated.CLAUDE_SUBSCRIPTION_HOSTS)
        self.assertNotIn("platform.claude.com", isolated.CLAUDE_HOSTS)
        for bad in (["codex", "exec", "--chat-auth", "subscription", "--chat-session", session],
                    ["claude", "-p", "--chat-auth", "subscription", "--chat-auth", "subscription", "--chat-session", session, "--chat-prompt", "hello"]):
            self.assertEqual(isolated.run(str(runtime / "claude"), bad, str(self.work), self.environment), 2)

    def test_rejects_scripts_as_the_executable(self):
        program = self.root / "codex"
        program.write_text("#!/bin/sh\nexit 0\n")
        program.chmod(0o700)
        with self.assertRaises(ValueError):
            isolated.validate_paths(str(program), str(self.work), self.environment)

    def test_workspace_socket_is_rejected(self):
        path = self.work / "host-agent.sock"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as agent:
            agent.bind(str(path))
            with self.assertRaises(ValueError):
                isolated.validate_paths(sys.executable, str(self.work), self.environment)

    def test_workspace_nested_mount_is_rejected(self):
        nested = str(self.work / "mounted").replace(" ", "\\040")
        entry = "42 1 0:42 / " + nested + " rw - tmpfs tmpfs rw\n"
        with patch("builtins.open", return_value=io.StringIO(entry)):
            with self.assertRaises(ValueError):
                isolated.check_workspace(str(self.work))

    def test_runtime_helper_cannot_escape_installation_directory(self):
        runtime = self.root / "runtime"
        runtime.mkdir()
        (runtime / "codex-code-mode-host").symlink_to("/usr/bin/true")
        with self.assertRaises(ValueError):
            isolated.runtime_companions(str(runtime / "codex"))

    def test_missing_isolation_dependency_never_falls_back(self):
        with patch.object(isolated.os.path, "isfile", return_value=False), \
             patch.object(isolated.subprocess, "run") as execute:
            self.assertEqual(isolated.run(sys.executable, ["codex", "exec"], str(self.work), self.environment), 2)
            execute.assert_not_called()

    def test_chat_attachments_are_bounded_atomic_and_private(self):
        session, turn = str(uuid.uuid4()), str(uuid.uuid4())
        local = self.home / ".local"; local.mkdir(mode=0o775); local.chmod(0o775)
        state = local / "state"; state.mkdir(mode=0o775); state.chmod(0o775)
        data = b"attachment contents"
        header = json.dumps({"files": [{"name": "f1.txt", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]}).encode()
        packet = len(header).to_bytes(4, "big") + header + data
        result = chat_files.stage(session, turn, io.BytesIO(packet), self.environment)
        self.assertEqual(result["outcome"], "staged")
        target = self.home / ".remote-ssh-chat" / session / "uploads" / turn
        self.assertEqual((target / "f1.txt").read_bytes(), data)
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        self.assertEqual((target / "f1.txt").stat().st_mode & 0o777, 0o600)
        self.assertEqual(local.stat().st_mode & 0o777, 0o775)
        self.assertEqual(state.stat().st_mode & 0o777, 0o775)
        with self.assertRaises(FileExistsError):
            chat_files.stage(session, turn, io.BytesIO(packet), self.environment)
        bad_turn = str(uuid.uuid4())
        with self.assertRaises(ValueError):
            chat_files.stage(session, bad_turn, io.BytesIO(packet[:-1]), self.environment)
        self.assertFalse((target.parent / bad_turn / "ready.json").exists())
        with self.assertRaises((ValueError, OSError)):
            isolated.chat_paths(str(self.home), session, bad_turn)
        (target / "f1.txt").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            isolated.chat_paths(str(self.home), session, turn)

    def test_chat_rejects_writable_home_or_symlinked_root(self):
        session = str(uuid.uuid4()); self.home.chmod(0o770)
        with self.assertRaises(ValueError): isolated.chat_paths(str(self.home), session, None)
        self.home.chmod(0o750)
        target = self.root / "other"; target.mkdir()
        (self.home / ".remote-ssh-chat").symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError): isolated.chat_paths(str(self.home), session, None)

    def test_chat_session_persists_inside_isolation_and_serializes_turns(self):
        runtime = self.root / "runtime-chat"; runtime.mkdir()
        shutil.copy2(os.path.realpath(sys.executable), runtime / "codex")
        session, turn = str(uuid.uuid4()), str(uuid.uuid4())
        data = b"safe attachment"
        header = json.dumps({"files": [{"name": "f1.txt", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]}).encode()
        chat_files.stage(session, turn, io.BytesIO(len(header).to_bytes(4, "big") + header + data), self.environment)
        probe = r'''import pathlib,json,sys
p=pathlib.Path('/home/codex/.codex/fixture-history'); old=p.read_text() if p.exists() else ''
p.write_text(old+'round\n')
a=pathlib.Path('/attachments')/sys.argv[1]/'f1.txt'; good=a.read_bytes()==b'safe attachment'
try: a.write_text('forbidden'); readonly=False
except OSError: readonly=True
pathlib.Path('/workspace/chat-result').write_text(json.dumps({'history':p.read_text(),'attachment':good,'readonly':readonly}))
'''
        command = ["codex", "exec", "--chat-session", session, "--chat-turn", turn]
        override = ["-I", "-c", probe, turn]
        for _ in range(2):
            result = isolated.run(str(runtime / "codex"), command, str(self.work), self.environment, _argv_override=override)
            self.assertEqual(result, 0)
        observed = json.loads((self.work / "chat-result").read_text())
        self.assertEqual(observed, {"history": "round\nround\n", "attachment": True, "readonly": True})
        root = self.home / ".remote-ssh-chat" / session
        with (root / "session.lock").open("r+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = isolated.run(str(runtime / "codex"), command, str(self.work), self.environment, _argv_override=override)
            self.assertEqual(result, 2)
        self.assertEqual((root / "codex-home" / "fixture-history").read_text(), "round\nround\n")
        self.assertEqual(self.auth.read_text(), '{"fake":"test-only"}')

    def test_claude_adapter_runs_in_isolated_home_with_native_image_input(self):
        runtime = self.root / "runtime-claude"; runtime.mkdir()
        shutil.copy2(os.path.realpath(sys.executable), runtime / "claude")
        key = self.home / "fixture-api-key"; key.write_text("fixture-only-key\n"); key.chmod(0o600)
        session, turn = str(uuid.uuid4()), str(uuid.uuid4())
        data = b"\x89PNG\r\n\x1a\nsynthetic-image"
        header = json.dumps({"files": [{"name": "f1.png", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]}).encode()
        chat_files.stage(session, turn, io.BytesIO(len(header).to_bytes(4, "big") + header + data), self.environment)
        probe = r'''import base64,json,os,pathlib,sys
message=json.loads(sys.stdin.readline()); content=message['message']['content']
assert content[0]['text']=='test message'
assert content[1]['source']['media_type']=='image/png'
assert base64.b64decode(content[1]['source']['data'])==b'\x89PNG\r\n\x1a\nsynthetic-image'
assert os.environ['ANTHROPIC_API_KEY']=='fixture-only-key'
assert not any(k.upper().startswith('SSH_') for k in os.environ)
assert not pathlib.Path('/home/codex/.codex/auth.json').exists()
history=pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])/'fixture-history'
old=history.read_text() if history.exists() else ''; history.write_text(old+'round\n')
pathlib.Path('/workspace/claude-result').write_text(history.read_text())
'''
        cmd = ["claude", "-p", "--chat-session", session, "--chat-turn", turn, "--chat-prompt", "test message",
               "--chat-image", "/attachments/" + turn + "/f1.png"]
        for _ in range(2):
            self.assertEqual(isolated.run(str(runtime / "claude"), cmd, str(self.work), self.environment,
                                          _auth_path=str(key), _argv_override=["-I", "-c", probe]), 0)
        self.assertEqual((self.work / "claude-result").read_text(), "round\nround\n")
        self.assertEqual(key.read_text(), "fixture-only-key\n")
        calls = []
        def connector(host):
            calls.append(host); raise AssertionError("disallowed host reached connector")
        with tempfile.TemporaryDirectory(prefix="claude-gate-test-") as directory:
            with isolated.Gateway(os.path.join(directory, "proxy.sock"), connector, isolated.CLAUDE_HOSTS):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(3); client.connect(os.path.join(directory, "proxy.sock"))
                    client.sendall(b"CONNECT api.openai.com:443 HTTP/1.1\r\nHost: x\r\n\r\n")
                    self.assertIn(b"403 Forbidden", recv_header(client))
        self.assertEqual(calls, [])

    def test_bubblewrap_failure_never_falls_back_to_codex(self):
        failure = subprocess.CompletedProcess(args=[], returncode=1)
        with patch.object(isolated.os.path, "isfile", return_value=True), \
             patch.object(isolated.os, "access", return_value=True), \
             patch.object(isolated, "validate_paths", return_value=("/opt/codex", str(self.work), str(self.auth))), \
             patch.object(isolated.subprocess, "run", return_value=failure) as execute:
            code = isolated.run("/opt/codex", ["codex", "exec"], str(self.work), self.environment)
        self.assertEqual(code, 1)
        execute.assert_called_once()
        self.assertEqual(execute.call_args.args[0][0], "/usr/bin/bwrap")

    def test_gateway_rejects_unlisted_host_without_connecting(self):
        calls = []
        def connector(host):
            calls.append(host)
            raise AssertionError("unexpected connection")
        with tempfile.TemporaryDirectory(prefix="codex-gate-test-") as directory:
            path = os.path.join(directory, "proxy.sock")
            with isolated.Gateway(path, connector):
                for host in (b"chatgpt.com.attacker.test", b"127.0.0.1", b"api.openai.com:444"):
                    with self.subTest(host=host), socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(3); client.connect(path)
                        client.sendall(b"CONNECT " + host + b":443 HTTP/1.1\r\nHost: x\r\n\r\n")
                        self.assertIn(b"403 Forbidden", recv_header(client))
        self.assertEqual(calls, [])

    def test_dns_private_addresses_are_not_used_for_provider(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
                   (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443))]
        with patch.object(isolated.socket, "getaddrinfo", return_value=records), \
             patch.object(isolated.socket, "socket") as create:
            with self.assertRaises(OSError):
                isolated.global_connection("chatgpt.com")
            create.assert_not_called()

    def test_isolated_process_hides_host_state_and_uses_bounded_gateway(self):
        for program in ("/usr/bin/bwrap", "/usr/bin/python3"):
            if not os.path.isfile(program): self.skipTest("required namespace tools unavailable")
        host_marker = self.home / "source-marker.txt"
        host_marker.write_text("203.0.113.93")
        runtime = self.root / "runtime"
        runtime.mkdir()
        shutil.copy2(os.path.realpath(sys.executable), runtime / "codex")
        shutil.copy2("/usr/bin/true", runtime / "codex-code-mode-host")
        target = socket.socket(); target.bind(("127.0.0.1", 0)); target.listen(1); target.settimeout(15)
        target_port = target.getsockname()[1]
        calls = []
        def connector(host):
            calls.append(host)
            return socket.create_connection(("127.0.0.1", target_port), timeout=5)
        def endpoint():
            try:
                with target.accept()[0] as connection:
                    if connection.recv(4) == b"ping": connection.sendall(b"pong")
            finally:
                target.close()
        thread = threading.Thread(target=endpoint, daemon=True); thread.start()
        probe = r'''import json,os,pathlib,socket,subprocess,sys,urllib.parse
secret=sys.argv[1]; host_port=int(sys.argv[2]); out={}
out['ssh_clean']=not any(k.upper().startswith('SSH_') for k in os.environ)
out['untrusted_env_hidden']=not any('203.0.113.93' in value or 'untrusted-proxy-value' in value for value in os.environ.values())
out['host_marker_hidden']=not os.path.exists(secret)
out['logs_hidden']=not os.path.exists('/var/log') and not os.path.exists('/run/log')
out['home']=os.environ.get('HOME')=='/home/codex'
out['unprivileged_uid']=os.getuid()==1000 and os.getgid()==1000
out['auth_bound']=pathlib.Path('/home/codex/.codex/auth.json').read_text()=='{"fake":"test-only"}'
out['runtime_helper_available']=subprocess.run(['/opt/codex-code-mode-host'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
try:
 pathlib.Path('/usr/bin/outer-isolation-write-probe').write_text('must-not-write')
 out['system_write_blocked']=False
except OSError: out['system_write_blocked']=True
try:
 with open('/home/codex/.codex/auth.json','a') as auth: auth.write('must-not-change')
 out['auth_readonly']=False
except OSError: out['auth_readonly']=True
out['proc_source_hidden']=True
for p in pathlib.Path('/proc').iterdir():
 if p.name.isdigit():
  try:
   if b'203.0.113.93' in (p/'environ').read_bytes(): out['proc_source_hidden']=False
  except (OSError,PermissionError): pass
status=pathlib.Path('/proc/self/status').read_text().splitlines()
caps={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in status if line.startswith(('CapEff:','CapPrm:','CapBnd:','NoNewPrivs:'))}
out['caps_dropped']=all(int(caps[k],16)==0 for k in ('CapEff','CapPrm','CapBnd')) and caps['NoNewPrivs']=='1'
inner=subprocess.run(['/usr/bin/bwrap','--unshare-user','--unshare-pid','--ro-bind','/','/','--proc','/proc','--dev','/dev','--','/usr/bin/true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
out['nested_bwrap_available']=inner.returncode==0
rows=pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:]
out['host_network_hidden']=not any(int(x.rsplit(':',1)[1],16)==host_port for row in rows for x in row.split()[1:3])
try:
 s=socket.create_connection(('127.0.0.1',host_port),timeout=1); s.close(); out['host_direct_blocked']=False
except OSError: out['host_direct_blocked']=True
url=urllib.parse.urlparse(os.environ['HTTPS_PROXY']); proxy=(url.hostname,url.port)
def header(s):
 data=b''
 while b'\r\n\r\n' not in data:
  chunk=s.recv(1024)
  if not chunk: break
  data+=chunk
 return data
with socket.create_connection(proxy,timeout=4) as s:
 s.settimeout(4); s.sendall(b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n')
 out['allowed_gateway']=b'200 Connection Established' in header(s)
 s.sendall(b'ping'); out['gateway_roundtrip']=s.recv(4)==b'pong'
with socket.create_connection(proxy,timeout=4) as s:
 s.settimeout(4); s.sendall(b'CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example\r\n\r\n')
 out['denied_gateway']=b'403 Forbidden' in header(s)
pathlib.Path('/workspace/created-by-test').write_text('ok')
print(json.dumps(out),flush=True)
'''
        with tempfile.TemporaryDirectory(prefix="codex-gate-test-") as directory:
            with isolated.Gateway(os.path.join(directory, "proxy.sock"), connector):
                executable, work, auth = isolated.validate_paths(str(runtime / "codex"), str(self.work), self.environment)
                cmd = isolated.sandbox_command(executable, work, auth, directory,
                                               ["-I", "-c", probe, str(host_marker), str(target_port)])
                result = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        env={"PATH":"/usr/bin:/usr/sbin:/bin", "LANG":"C.UTF-8"}, timeout=25)
        thread.join(10)
        if result.returncode != 0:
            target.close()
            self.fail("isolated process failed: " + result.stderr.decode("utf-8", "replace")[:1000])
        self.assertFalse(thread.is_alive())
        report = json.loads(result.stdout)
        self.assertTrue(all(report.values()), report)
        self.assertEqual(calls, ["chatgpt.com"])
        self.assertEqual((self.work / "created-by-test").read_text(), "ok")
        self.assertEqual(self.auth.read_text(), '{"fake":"test-only"}')

    def test_managed_task_runs_isolated_once_and_can_be_queried(self):
        for program in ("/usr/bin/bwrap", "/usr/bin/python3"):
            if not os.path.isfile(program): self.skipTest("required namespace tools unavailable")
        root = HELPER.parent
        host_marker = self.home / "private-source-marker"
        host_marker.write_text("203.0.113.93")
        fake_bin = self.root / "bin"; fake_bin.mkdir()
        (fake_bin / "codex").symlink_to(os.path.realpath(sys.executable))
        # The ELF Python binary stands in for codex and runs this disposable
        # project file named 'exec'. No real account or model is invoked.
        (self.work / "exec").write_text("import os,pathlib,sys\n"
            "assert not any(k.upper().startswith('SSH_') for k in os.environ)\n"
            "assert not pathlib.Path(sys.argv[1]).exists()\n"
            "assert not pathlib.Path('/var/log').exists()\n"
            "pathlib.Path('/workspace/counter').open('a').write('once\\n')\n"
            "print('fixture-isolated-ok',flush=True)\n")
        privacy = base64.b64encode(zlib.compress((root / "RemoteCodexPrivacy.py").read_bytes(), 9)).decode("ascii")
        sandbox = base64.b64encode(zlib.compress(HELPER.read_bytes(), 9)).decode("ascii")
        runner = ("import base64,zlib,sys; scope={'__name__':'test_remote_privacy'}; "
                  "exec(zlib.decompress(base64.b64decode('" + privacy + "')),scope); "
                  "scope['preflight']=lambda *args: True; sys.exit(scope['main']())")
        command = [sys.executable, "-B", "-c", runner, "--expected-ipv4", "203.0.113.4",
                   "--isolation-code", sandbox, "--isolation-workspace", str(self.work), "--", "codex", "exec", str(host_marker)]
        request = json.dumps({"command": command, "cwd": str(self.work), "capture": True}, separators=(",", ":")).encode()
        self.assertLess(len(request), 32768)  # RemoteTask.MAX_PAYLOAD
        identifier = str(uuid.uuid4()); state = self.root / "task-state"
        task = root / "RemoteTask.py"
        base = [sys.executable, str(task)]
        env = os.environ.copy(); env.update(self.environment); env["PATH"] = str(fake_bin) + ":/usr/bin:/usr/sbin:/bin"
        start = [*base, "start", "--id", identifier, "--state-dir", str(state), "--payload-stdin"]
        first = subprocess.run(start, input=request, capture_output=True, env=env, timeout=10)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(first.stdout)["outcome"], "accepted")
        status = [*base, "status", "--id", identifier, "--state-dir", str(state)]
        final = None
        for _ in range(160):
            result = subprocess.run(status, capture_output=True, env=env, timeout=5, check=True)
            final = json.loads(result.stdout)
            if final["state"] in ("finished", "launch_failed"): break
            time.sleep(.05)
        self.assertEqual(final["state"], "finished", final)
        output = subprocess.run([*base, "output", "--id", identifier, "--state-dir", str(state)],
                                capture_output=True, env=env, timeout=5, check=True)
        errors = subprocess.run([*base, "output", "--id", identifier, "--state-dir", str(state), "--stream", "stderr"],
                                capture_output=True, env=env, timeout=5, check=True)
        self.assertEqual(final["exit_code"], 0, errors.stdout.decode("utf-8", "replace"))
        self.assertIn(b"fixture-isolated-ok", output.stdout)
        duplicate = subprocess.run(start, input=request, capture_output=True, env=env, timeout=10)
        self.assertEqual(duplicate.returncode, 3)
        self.assertEqual(json.loads(duplicate.stdout)["outcome"], "already_exists")
        self.assertEqual((self.work / "counter").read_text(), "once\n")


if __name__ == "__main__":
    unittest.main()
