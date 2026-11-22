"""Offline, unprivileged SSH installer dispatch and receipt tests."""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

import remote_setup as setup


SOURCE = Path(setup.__file__).read_bytes()
PREFIX = "VPS-Workbench-Backend-1.0.0-linux/"
FAKE = b"""
import json, os, pathlib, sys, time
home = pathlib.Path(os.environ['HOME'])
assert set(os.environ) <= {'PATH', 'LANG', 'HOME', 'LC_CTYPE'}
assert os.environ['PATH'] == '/usr/sbin:/usr/bin:/bin'
argv = sys.argv[1:]
explicit = '--workspace' in argv
work = pathlib.Path(argv[argv.index('--workspace') + 1]) if explicit else home / 'vps-workbench-project'
platform = {'system':'Linux','architecture':'arm64','blocker':None,'workspace':'not_checked','providers':{}}
if explicit and not work.is_dir():
    platform.update(blocker='workspace_unavailable', workspace='workspace_unavailable')
if argv[0] == 'doctor' or platform['blocker']:
    print(json.dumps(platform))
    sys.exit(2 if platform['blocker'] else 0)
assert argv[0] == 'install'
if not explicit:
    work.mkdir(exist_ok=True)
with (home / 'calls').open('a') as f:
    print('install',file=f)
time.sleep(0.3)
providers = [argv[n+1] for n,s in enumerate(argv) if s == '--provider']
results = {p:{'runtime':'existing','onSshPath':True,'account':'unchecked'} for p in providers}
if 'claude-sdk' in providers:
    results['claude-sdk'] = {'runtime':'failed','code':'fixture_provider_failure'}
print('private-upstream-diagnostic',file=sys.stderr)
print(json.dumps({'providers':results,'workspace':str(work),'release':str(home/'private-release')}))
sys.exit(int('claude-sdk' in providers))
"""


def archive(members=None):
    out = io.BytesIO()
    if members is None:
        members = [("manifest.json", b"{}"), ("workbench-vps.py", FAKE)]
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, content in members:
            member = tarfile.TarInfo(PREFIX + name)
            member.size = len(content)
            tar.addfile(member, io.BytesIO(content))
    return out.getvalue()


@unittest.skipUnless(sys.platform == "linux" and os.getuid() != 0, "requires an unprivileged Linux fixture")
class DispatchTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(scratch.cleanup)
        self.home = Path(scratch.name)
        fake_home = patch.object(setup, "ssh_home", return_value=self.home)
        fake_home.start()
        self.addCleanup(fake_home.stop)
        env = patch.dict(os.environ, {"HOME": str(self.home), "PATH": "/usr/sbin:/usr/bin:/bin",
                                      "SSH_AUTH_SOCK": "secret", "HTTPS_PROXY": "secret", "API_KEY": "secret"})
        env.start()
        self.addCleanup(env.stop)
        self.bundle = archive()
        self.digest = hashlib.sha256(self.bundle).hexdigest()
        self.probe = {"kind": "probe", "targetId": "a" * 64, "workspace": str(self.home / "vps-workbench-project")}
        self.start = {**self.probe, "kind": "start", "installId": str(uuid.uuid4()), "providers": ["codex"]}
        self.status = {k: self.start[k] for k in ("targetId", "installId")}
        self.status["kind"] = "status"

    def call(self, request):
        return setup.dispatch(request, self.bundle, self.digest, SOURCE)

    def await_finish(self):
        for _ in range(150):
            result = setup.dispatch(self.status)
            if not result["ok"] or result["install"]["state"] != "running":
                return result
            time.sleep(0.03)
        self.fail("detached fixture worker did not finish")

    def test_probe_preserves_platform_for_missing_workspace_and_never_installs(self):
        result = self.call({**self.probe, "workspace": self.probe["workspace"] + "/"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["platform"]["workspace"], "will_create")
        self.assertFalse(Path(self.probe["workspace"]).exists())
        custom = str(self.home / "missing")
        result = self.call({**self.probe, "workspace": custom})
        self.assertEqual(result["platform"], {"system": "Linux", "architecture": "arm64",
                         "workspace": "workspace_unavailable", "blocker": "workspace_unavailable", "providers": {}})
        self.assertFalse((self.home / ".local").exists())
        self.assertFalse((self.home / "calls").exists())

    def test_detaches_from_launcher_and_recovers_original_without_replaying(self):
        # Mimic the fixed SSH adapter exiting immediately after printing the start reply.
        launcher = ("import json,sys; from pathlib import Path; src=Path(sys.argv[1]).read_bytes(); "
                    "ns={'__name__':'workbench_vps_remote'}; exec(src,ns); "
                    "ns['ssh_home']=lambda:Path(sys.argv[2]); "
                    "print(json.dumps(ns['dispatch'](json.loads(sys.argv[3]),sys.stdin.buffer.read(),sys.argv[4],src)))")
        process = subprocess.run([setup.PYTHON, "-I", "-B", "-c", launcher, setup.__file__, str(self.home),
                                  json.dumps(self.start), self.digest], input=self.bundle, capture_output=True, check=True)
        started = json.loads(process.stdout)
        self.assertEqual(started["install"]["state"], "running")
        self.assertEqual(process.stderr, b"")
        self.assertTrue(self.call(self.start)["ok"])
        final = self.await_finish()
        self.assertEqual(final["install"], {"id": self.start["installId"], "state": "succeeded",
                         "providers": ["codex"], "results": {"codex": {"runtime": "existing", "onSshPath": True}}})
        self.assertEqual(self.call(self.start), final)
        self.assertEqual((self.home / "calls").read_text(), "install\n")
        self.assertTrue(Path(self.probe["workspace"]).is_dir())
        self.assertNotIn(str(self.home), str(final))
        self.assertEqual(self.call({**self.start, "providers": ["claude"]})["code"], "install_binding_mismatch")
        self.assertEqual(self.call({**self.start, "workspace": str(self.home)})["code"], "install_binding_mismatch")
        changed = archive([("workbench-vps.py", FAKE), ("manifest.json", b"{}")])
        self.assertEqual(setup.dispatch(self.start, changed, hashlib.sha256(changed).hexdigest(), SOURCE)["code"],
                         "install_binding_mismatch")
        self.assertEqual(setup.dispatch({**self.status, "targetId": "b" * 64})["code"], "install_binding_mismatch")

    def test_preserves_partial_failure_and_custom_workspace(self):
        custom = self.home / "other-project"
        custom.mkdir()
        note = custom / "keep.txt"
        note.write_text("existing project")
        self.assertTrue(self.call({**self.start, "providers": ["codex", "claude-sdk"], "workspace": str(custom)})["ok"])
        result = self.await_finish()["install"]
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["results"]["codex"]["runtime"], "existing")
        self.assertEqual(result["results"]["claude-sdk"], {"runtime": "failed", "code": "fixture_provider_failure"})
        self.assertEqual(note.read_text(), "existing project")
        self.assertFalse(Path(self.probe["workspace"]).exists())

    def test_custom_missing_stays_missing_and_reports_reason(self):
        custom = self.home / "not-created"
        self.call({**self.start, "workspace": str(custom)})
        final = self.await_finish()["install"]
        self.assertEqual(final["state"], "failed")
        self.assertEqual(final["code"], "workspace_unavailable")
        self.assertFalse(custom.exists())
        self.assertFalse(Path(self.probe["workspace"]).exists())
        self.assertFalse((self.home / "calls").exists())

    def test_archive_integrity_and_private_root(self):
        self.assertEqual(setup.dispatch(self.start, self.bundle + b"!", self.digest, SOURCE)["install"]["code"],
                         "package_digest_mismatch")
        unsafe = archive([("manifest.json", b"{}"), ("workbench-vps.py", FAKE), ("../escape", b"x")])
        result = setup.dispatch(self.probe, unsafe, hashlib.sha256(unsafe).hexdigest())
        self.assertEqual(result, {"ok": False, "code": "invalid_backend_archive"})
        (self.home / ".local").symlink_to(self.home)
        install = self.call(self.start)["install"]
        self.assertEqual((install["state"], install["id"], install["code"]),
                         ("failed", self.start["installId"], "unsafe_directory"))
        self.assertFalse((self.home / "share").exists())
        self.assertFalse((self.home / "calls").exists())
        (self.home / ".local").unlink()
        self.assertEqual(setup.dispatch(self.status)["code"], "install_receipt_missing")
        self.start["installId"] = self.status["installId"] = str(uuid.uuid4())
        self.assertEqual(self.call(self.start)["install"]["state"], "running")
        self.assertEqual(self.await_finish()["install"]["state"], "succeeded")

    def test_missing_uncertain_and_corrupt_receipts_never_replay(self):
        result = setup.dispatch(self.status)
        self.assertEqual(result["code"], "install_receipt_missing")
        self.assertFalse((self.home / ".local").exists())
        # Lost worker before completing any result. A subsequent read and start
        # must both report the original as unknown even if a fresh launch would work.
        with patch.object(setup, "launch", return_value=None) as launch:
            self.assertEqual(self.call(self.start)["install"]["state"], "running")
        launch.assert_called_once()
        self.assertEqual(setup.dispatch(self.status)["install"]["state"], "unknown")
        self.assertEqual(self.call(self.start)["install"]["code"], "worker_unconfirmed")
        receipt = self.home / setup.JOB_ROOT / self.start["installId"] / "receipt.json"
        saved = receipt.read_bytes()
        receipt.write_bytes(b"{")
        self.assertEqual(self.call(self.start)["code"], "install_receipt_unavailable")
        self.assertEqual(receipt.read_bytes(), b"{")
        receipt.write_bytes(saved)
        self.assertFalse((self.home / "calls").exists())

    def test_rejects_request_extensions_and_unsafe_paths(self):
        for change in ({"providers": []}, {"providers": ["codex", "codex"]}, {"providers": ["shell"]},
                       {"targetId": "x" * 64}, {"installId": str(uuid.UUID(int=0))},
                       {"command": "anything"}, {"workspace": "../relative"}, {"workspace": "/tmp/../root"}):
            with self.subTest(change=change):
                self.assertFalse(self.call({**self.start, **change})["ok"])
        self.assertFalse((self.home / ".local").exists())
        with patch.dict(os.environ, {"PATH": ".:/usr/bin"}):
            started = self.call(self.start)["install"]
        self.assertEqual(started["state"], "failed")
        self.assertEqual(started["code"], "unsafe_ssh_path")
        self.assertEqual(self.call(self.start)["install"], started)

    def test_terminated_worker_leaves_unknown_receipt(self):
        stopped_worker = b"import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n"
        result = setup.dispatch(self.start, self.bundle, self.digest, stopped_worker)
        self.assertEqual(result["install"]["state"], "running")
        final = self.await_finish()
        self.assertEqual(final["install"]["state"], "unknown")
        self.assertEqual(self.call(self.start), final)
        self.assertFalse((self.home / "calls").exists())


if __name__ == "__main__":
    unittest.main()
