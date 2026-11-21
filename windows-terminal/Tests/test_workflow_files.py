"""Offline workflow checks. Run with python3 -B on an unprivileged Linux VPS."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid


def probe(files, isolation):
    """Exercise the production snapshot and namespace launcher with a deterministic ELF."""
    with tempfile.TemporaryDirectory(prefix="workflow-check-") as tmp:
        root = Path(tmp)
        home, project, temporary, gate = (root / name for name in ("home", "workspace", "snapshot", "gate"))
        for path in (home, project, temporary, gate):
            path.mkdir(mode=0o700)
        (project / "nested").mkdir()
        allowed = project / "nested" / "allowed.txt"
        allowed.write_text("selected")
        (project / "hidden.txt").write_text("private fixture")
        prior = home / ".remote-ssh-chat" / "workflow-outputs" / str(uuid.uuid4())
        for directory in (prior.parent.parent, prior.parent, prior):
            directory.mkdir(mode=0o700)
        (prior / "previous.txt").write_text("prior fixture")
        task = str(uuid.uuid4())
        grant = {"paths": ["nested/allowed.txt"], "attachments": [{"name": "note.txt", "data": "bm90ZQ=="}]}
        snapshot, uploads, output = files["prepare"](grant, str(project), str(home), task, temporary)
        if Path(output) != prior.parent / task or Path(output).exists():
            raise AssertionError("unexpected task output")
        script = r'''
import errno,json,os,sys
from pathlib import Path
def absent(path):
    try: Path(path).lstat()
    except OSError as error: return error.errno == errno.ENOENT
    return False
def unwritable(path):
    try: Path(path).write_bytes(b"changed")
    except OSError: return True
    return False
ssh_hidden = not any(name.startswith("SSH_") for name in os.environ)
proc_hidden = True
for proc in Path("/proc").iterdir():
    if proc.name.isdigit():
        try:
            proc_hidden &= all(not entry.startswith(b"SSH_") for entry in (proc / "environ").read_bytes().split(b"\0"))
        except (PermissionError, FileNotFoundError): pass
mounts = Path("/proc/self/mountinfo").read_text()
output_mounts = []
for proc in Path("/proc").iterdir():
    if proc.name.isdigit():
        try:
            table = (proc / "mountinfo").read_text()
        except (PermissionError, FileNotFoundError): continue
        assert "workflow-outputs" not in table
        output_mounts.extend(line.split() for line in table.splitlines() if line.split()[4] == "/output")
checks = {
    "output_mount_anonymous": bool(output_mounts) and all(row[3] == "/" and row[row.index("-")+1:row.index("-")+3] == ["tmpfs", "tmpfs"] for row in output_mounts),
    "authorized_project_read": Path("nested/allowed.txt").read_text() == "selected",
    "authorized_attachment_read": Path("/attachments/note.txt").read_text() == "note",
    "unauthorized_project_absent": absent("hidden.txt") and absent(sys.argv[1]),
    "listings_only_granted": os.listdir(".") == ["nested"] and os.listdir("nested") == ["allowed.txt"]
        and os.listdir("/attachments") == ["note.txt"],
    "unrelated_paths_absent_from_mounts": all(path not in mounts for path in sys.argv[1:]),
    "project_write_denied": unwritable("nested/allowed.txt") and unwritable("new-file"),
    "attachment_write_denied": unwritable("/attachments/note.txt"),
    "other_task_output_absent": absent(sys.argv[2]) and absent("/output/previous.txt"),
    "ssh_environment_absent": ssh_hidden and proc_hidden,
}
Path("/output/result.txt").write_text("finished")
print(json.dumps(checks))
'''
        # Use the same environment filtering and gateway. No model service is contacted.
        def no_network(host):
            raise AssertionError("unexpected outbound request")
        with isolation["Gateway"](str(gate / "proxy.sock"), no_network):
            command = isolation["sandbox_command"](sys.executable, snapshot, None, str(gate),
                ["-I", "-c", script, str(project / "hidden.txt"), str(prior / "previous.txt")],
                uploads=uploads, read_only_workspace=True)
            with files["output_process"](command, output, env={"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"},
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as result:
                stdout, stderr = result.communicate(timeout=25)
        if result.returncode:
            raise RuntimeError("namespace probe exited " + str(result.returncode) + ": " + stderr.decode(errors="replace")[:200])
        checks = json.loads(stdout)
        checks["output_persisted"] = (Path(output) / "result.txt").read_text() == "finished"
        checks["project_intact"] = allowed.read_text() == "selected"
        if not all(checks.values()):
            raise AssertionError(checks)
        return checks


@unittest.skipUnless(sys.platform == "linux", "Linux sandbox")
class WorkflowFilesTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        self.files = runpy.run_path(str(root / "DshChatBridge" / "RemoteWorkflowFiles.py"))
        self.isolation = runpy.run_path(str(root / "RemoteCodexIsolate.py"))

    def test_namespace(self):
        self.assertTrue(all(probe(self.files, self.isolation).values()))

    def test_invalid_inputs(self):
        validate = self.files["validate"]
        for path in ("", "/file", "a//b", "./x", "a/../x", "a\\b", "a\x00b", "x" * 256, "界" * 86):
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate({"paths": [path], "attachments": []})
        for data in ("Zg", "Zh==", "Zg==\n", "+___", base64.b64encode(bytes(512 * 1024 + 1)).decode()):
            with self.assertRaises(ValueError):
                validate({"paths": [], "attachments": [{"name": "file", "data": data}]})
        for paths in (["x"] * 2, [str(i) for i in range(17)]):
            with self.assertRaises(ValueError):
                validate({"paths": paths, "attachments": []})
        self.assertEqual(validate({"paths": [], "attachments": []}), ([], {}))

    def test_only_regular_single_link_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "project"
            project.mkdir()
            (root / "secret").write_bytes(b"fixture")
            (project / "symlink").symlink_to(root / "secret")
            (project / "linkdir").symlink_to(root)
            os.link(root / "secret", project / "hardlink")
            os.mkfifo(project / "fifo")
            for name in ("symlink", "linkdir/secret", "hardlink", "fifo", "missing"):
                with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary, self.assertRaises((ValueError, OSError)):
                    self.files["prepare"]({"paths": [name], "attachments": []}, str(project), str(root), str(uuid.uuid4()), temporary)

    def test_atomic_archive_failures_and_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project, gate, output = root / "project", root / "gate", root / "output"
            project.mkdir()
            gate.mkdir()
            with self.isolation["Gateway"](str(gate / "proxy.sock"), lambda *_: None):
                def run(script, destination=output):
                    command = self.isolation["sandbox_command"](sys.executable, str(project), None, str(gate),
                        ["-I", "-c", script], read_only_workspace=True)
                    return self.files["output_process"](command, destination, stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for hazard in ("os.symlink('/etc/passwd', '/output/link')", "os.mkfifo('/output/fifo')",
                               "os.link('/output/plain', '/output/alias')"):
                    with self.subTest(hazard=hazard), self.assertRaises(ValueError):
                        with run("import os;open('/output/plain','xb').close();" + hazard) as process:
                            self.assertEqual(process.wait(timeout=10), 0)
                    self.assertFalse(output.exists())
                    self.assertFalse((root / ".pending-output").exists())
                with run("from pathlib import Path;Path('/output/file').write_bytes(b'original');raise SystemExit(3)") as process:
                    self.assertFalse(output.exists())
                    with self.assertRaises(FileExistsError), run("pass"):
                        self.fail("second writer entered")
                    self.assertEqual(process.wait(timeout=10), 3)
                self.assertEqual((output / "file").read_bytes(), b"original")
                with self.assertRaises(FileExistsError), run("pass"):
                    self.fail("existing archive replaced")
                with self.assertRaises(OSError), run("pass", root / "other") as process:
                    (root / "other").mkdir()
                    process.wait(timeout=10)
                self.assertTrue((root / "other").is_dir())
                self.assertFalse((root / ".pending-other").exists())

    def test_artifact_listing_and_preview(self):
        module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "DshChatBridge/RemoteWorkflowArtifacts.py"))
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            task = str(uuid.uuid4())
            root = home
            for part in (".remote-ssh-chat", "workflow-outputs", task):
                root /= part
                root.mkdir(mode=0o700)
            def read(**query):
                return module["read_artifacts"](self.files, home, task, query)
            nested = root / "子目录"
            nested.mkdir()
            (nested / "完整.bin").write_bytes(bytes(range(256)) * 4096)
            (root / "too-big").write_bytes(bytes(1024 * 1024 + 1))
            (root / "symlink").symlink_to(home)
            (home / "private").write_bytes(b"synthetic")
            os.link(home / "private", root / "hardlink")
            os.mkfifo(root / "pipe")
            rows = read()
            self.assertEqual(rows, {"files": [{"path": "too-big", "size": 1048577},
                 {"path": "子目录/完整.bin", "size": 1048576}], "truncated": False})
            file = read(path="子目录/完整.bin")["file"]
            self.assertEqual(base64.b64decode(file["data"], validate=True), (nested / "完整.bin").read_bytes())
            for name in ("../private", "symlink/private", "hardlink", "pipe", "too-big", "./子目录/完整.bin"):
                with self.subTest(name=name), self.assertRaises((OSError, ValueError)):
                    read(path=name)
            for i in range(257):
                (root / str(i)).touch()
            rows = read()
            self.assertTrue(rows["truncated"])
            self.assertEqual(len(rows["files"]), 256)
            last = rows["files"][-1]["path"]
            second = read(after=last)
            self.assertFalse(second["truncated"])
            self.assertEqual(len(second["files"]), 3)
            all_names = [row["path"] for row in rows["files"] + second["files"]]
            self.assertEqual(all_names, sorted({str(i) for i in range(257)} | {"too-big", "子目录/完整.bin"}))
            self.assertEqual(read(after=all_names[-1]), {"files": [], "truncated": False})
            # Native clients compare UTF-16 code units, including at the cursor boundary.
            for name in ("\ue000", "\U00010000"):
                (root / name).touch()
            self.assertEqual([row["path"] for row in read(after="子目录/完整.bin")["files"]], ["\U00010000", "\ue000"])
            chunk = read(path="too-big", offset=0)["file"]
            tail = read(path="too-big", offset=1048576)["file"]
            self.assertEqual(chunk["offset"], 0)
            self.assertEqual(chunk["size"], 1048577)
            self.assertEqual(tail["offset"], 1048576)
            self.assertEqual(tail["size"], chunk["size"])
            self.assertRegex(chunk["revision"], r"^[a-f0-9]{64}$")
            self.assertEqual(chunk["revision"], tail["revision"])
            self.assertEqual(len(base64.b64decode(chunk["data"], validate=True)), 1048576)
            self.assertEqual(tail["data"], "AA==")
            self.assertEqual(read(path="0", offset=0)["file"]["data"], "")
            (root / "replacement").write_bytes(bytes(1048577))
            (root / "replacement").replace(root / "too-big")
            self.assertNotEqual(read(path="too-big", offset=1048576)["file"]["revision"], tail["revision"])
            with (root / "oversize").open("wb") as oversized:
                oversized.truncate(self.files["OUTPUT_BYTES"] + 1)
            for invalid in ({"after": None}, {"after": "../wrong"}, {"after": "0", "path": "0"},
                            {"offset": 0}, {"after": "0", "offset": 0}, {"path": "oversize", "offset": 0},
                            *({"path": "too-big", "offset": bad}
                              for bad in (-1, True, 0.5, None, "5", 1048577, self.files["OUTPUT_BYTES"] + 1))):
                with self.subTest(invalid), self.assertRaises(ValueError):
                    read(**invalid)
            with patch.dict(self.files, OUTPUT_ENTRIES=128), self.assertRaises(ValueError):
                read(after="0")
            root.chmod(0o755)
            with self.assertRaises(ValueError):
                read()

    def test_antigravity_credential_mount_never_exposes_profile(self):
        path = Path(__file__).resolve().parents[1] / "DshChatBridge/RemoteDshAntigravity.py"
        agy = runpy.run_path(str(path))
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as lifetime:
            root = Path(tmp)
            profile = root / "profile"
            profile.mkdir()
            credential = profile / "account" / "session"
            credential.parent.mkdir()
            credential.write_text("synthetic")
            credential.chmod(0o600)
            (profile / "unselected").write_text("private fixture")
            with self.assertRaises(ValueError):
                agy["credential_files"](self.files, None, profile, lifetime)
            credentials = agy["credential_files"](self.files, {"files": ["account/session"]}, profile, lifetime)
            for part in ("gate", "project", "attachments"):
                (root / part).mkdir()
            mounts = tuple(str(root / name) for name in ("project", "attachments", "output"))
            with self.isolation["Gateway"](str(root / "gate/proxy.sock"), lambda *_: None):
                command = agy["sandbox_command"](self.isolation, sys.executable, "/unused", profile, str(root / "gate"), None,
                    mounts=mounts, credentials=credentials)
                self.assertNotIn(str(profile), command)
                self.assertNotIn("/unused", command)
                self.assertIn("accept-edits", json.loads(base64.b64decode(command[-1]))["argv"])
                check = 'from pathlib import Path;root=Path("/home/codex");assert (root/"account/session").read_text()=="synthetic";assert not (root/"unselected").exists()'
                command[command.index("--") + 1:] = ["/usr/bin/python3", "-I", "-c", check]
                with self.files["output_process"](command, mounts[2], pass_fds=(credentials[0][0],),
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE) as result:
                    _, stderr = result.communicate(timeout=15)
                self.assertEqual(result.returncode, 0, stderr[:200])

    def test_api_workflow_gate_and_stdin_reach_scoped_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home, project = root / "home", root / "project"
            home.mkdir(mode=0o700)
            project.mkdir()
            (project / "selected").write_text("input")
            (project / "hidden").write_text("private")
            auth = home / "synthetic-key"
            auth.write_text("fixture")
            auth.chmod(0o600)
            task, session = str(uuid.uuid4()), str(uuid.uuid4())
            request = {"prompt": "fixture", "memory": None, "workflowFiles": {"paths": ["selected"], "attachments": []}}
            args = ["claude", "-p", "--dsh-encrypted-credentials", "--dsh-api-chat-stdin", "--chat-session", session, "--session-id", session]
            isolation = dict(self.isolation)
            command = isolation["sandbox_command"]
            isolation["validate_paths"] = lambda *_args, **_kwargs: (sys.executable, str(project), str(auth))
            isolation["dsh_api_storage_ready"] = lambda _home: False
            with self.assertRaises(ValueError):
                self.files["run_api"](isolation, sys.executable, args, str(project), {"HOME": str(home)}, task)
            isolation["dsh_api_storage_ready"] = lambda _home: True
            def synthetic_model(executable, snapshot, key, gate, argv, **options):
                self.assertEqual(argv, ["-p", "--session-id", session])
                self.assertEqual(options["provider"], "claude")
                self.assertTrue(options["claude_stdin"] and options["read_only_workspace"])
                self.assertNotEqual(snapshot, str(project))
                check = ('import json,sys;from pathlib import Path;frame=json.load(sys.stdin);'
                         'assert frame["message"]["content"]==[{"type":"text","text":"fixture"}];'
                         'assert Path("selected").read_text()=="input" and not Path("hidden").exists();'
                         'assert list(Path("/attachments").iterdir())==[];Path("/output/result").write_text("complete");print("reply")')
                return command(executable, snapshot, key, gate, ["-I", "-c", check], **options)
            isolation["sandbox_command"] = synthetic_model
            result_file = home / ".remote-ssh-chat" / "workflow-outputs" / task / "result"
            class ReplyBuffer(io.BytesIO):
                def write(self, data):
                    if result_file.read_text() != "complete":
                        raise AssertionError("API reply reached client before output publication")
                    return super().write(data)
            replies = ReplyBuffer()
            with patch.object(sys, "stdin", type("Input", (), {"buffer": io.BytesIO(json.dumps(request).encode())})()), \
                    patch.object(sys, "stdout", type("Output", (), {"buffer": replies})()):
                result = self.files["run_api"](isolation, sys.executable, args, str(project), {"HOME": str(home)}, task)
            self.assertEqual(result, 0)
            self.assertEqual(replies.getvalue(), b"reply\n")

    def test_sdk_uses_temporary_home_and_fixed_workflow_cwd(self):
        path = Path(__file__).resolve().parents[1] / "DshChatBridge/RemoteDshClaudeSdk.py"
        sdk = runpy.run_path(str(path))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("gate", "profile", "project", "snapshot", "home", "package"):
                (root / name).mkdir()
            (root / "profile" / ".credentials.json").write_text("synthetic")
            (root / "profile" / "private").write_text("private")
            (root / "project" / "selected").write_text("visible")
            (root / "project" / "unapproved").write_text("private")
            mock_cli = root / "fixture-auth-status"
            mock_cli.write_text("#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'\n")
            mock_cli.chmod(0o700)
            mounts = self.files["prepare"]({"paths": ["selected"], "attachments": []},
                str(root / "project"), str(root / "home"), str(uuid.uuid4()), root / "snapshot")
            # File-scoped sessions have the same cwd regardless of the configured VPS project.
            native = {}
            worker = root / "gate" / sdk["WORKER"]
            worker.write_text("import errno,os\nfrom pathlib import Path\n"
                              "assert os.environ['DSH_WORKFLOW_FILES']=='1' and Path('selected').read_text()=='visible'\n"
                              "try:\n"
                              "    Path('unapproved').read_bytes()\n"
                              "except OSError as error:\n"
                              "    assert error.errno == errno.ENOENT\n"
                              "else:\n"
                              "    raise AssertionError('unapproved file is visible')\n"
                              "assert not any(key.startswith('SSH_') for key in os.environ)\n"
                              "for proc in Path('/proc').iterdir():\n"
                              "    if proc.name.isdigit():\n"
                              "        try: raw = (proc / 'environ').read_bytes()\n"
                              "        except (PermissionError, FileNotFoundError): continue\n"
                              "        assert b'SSH_CONNECTION=' not in raw\n"
                              "assert os.getcwd()=='/workspace'\n"
                              "assert Path('/home/codex/.claude/.credentials.json').read_text()=='synthetic'\n"
                              "assert not Path('/home/codex/.claude/private').exists() and Path('/attachments').is_dir()\n"
                              "Path('/output/result').write_text('ok')\n")
            with self.isolation["Gateway"](str(root / "gate/proxy.sock"), lambda *_: None):
                command = sdk["sdk_command"](self.isolation, native, str(mock_cli), "/unmounted-project", "/unmounted-home",
                    root / "profile", str(root / "gate"), sys.executable, root / "package", mounts=mounts)
                self.assertNotIn("/unmounted-project", command)
                self.assertNotIn("/unmounted-home", command)
                with self.files["output_process"](command, mounts[2], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        env={"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"}) as result:
                    _, stderr = result.communicate(timeout=15)
            self.assertEqual(result.returncode, 0, stderr[:200])
            self.assertEqual((Path(mounts[2]) / "result").read_text(), "ok")


if __name__ == "__main__":
    unittest.main()
