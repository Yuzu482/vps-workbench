import ast
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zlib

import build
import vps_runtimes as runtimes


HERE = Path(__file__).resolve().parent
CLI = runpy.run_path(str(HERE / "workbench-vps.py"))


class PackageTests(unittest.TestCase):
    def test_release_is_reproducible_and_reuses_wire_helpers_without_private_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a = build.build(root / "a", "a" * 40)
            b = build.build(root / "b", "a" * 40)
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertEqual(a.with_name(a.name + ".sha256").read_text().split()[0], hashlib.sha256(a.read_bytes()).hexdigest())
            with tarfile.open(a) as package:
                prefix = a.name.removesuffix(".tar.gz") + "/"
                files = {entry.name.removeprefix(prefix): package.extractfile(entry).read() for entry in package}
            self.assertEqual(set(files), set(build.SOURCES) | {"manifest.json"})
            with tempfile.TemporaryDirectory() as copy:
                unpack = Path(copy).resolve()
                for name, data in files.items():
                    target = unpack / name
                    target.parent.mkdir(exist_ok=True)
                    target.write_bytes(data)
                metadata = CLI["manifest"](unpack)
                self.assertEqual(metadata["revision"], "a" * 40)
                self.assertEqual(metadata["architectures"], ["x64", "arm64"])
                for name, original in build.SOURCES.items():
                    self.assertEqual(files[name], original.read_bytes())
                (unpack / "helpers" / "RemoteCodexIsolate.py").write_text("# tampered", encoding="utf-8")
                with self.assertRaisesRegex(CLI["SetupError"], "package_digest_mismatch"):
                    CLI["manifest"](unpack)

    def test_verify_does_not_execute_a_corrupt_runtime_module(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = build.build(root)
            with tarfile.open(archive) as source:
                prefix = archive.name.removesuffix(".tar.gz") + "/"
                for entry in source:
                    target = root / "package" / entry.name.removeprefix(prefix)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.extractfile(entry).read())
            package = root / "package"
            (package / "vps_runtimes.py").write_text("raise AssertionError('unexpected execution')\n")
            result = subprocess.run([sys.executable, "-I", "-B", str(package / "workbench-vps.py"), "verify"],
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout), {"error": "package_digest_mismatch"})
            self.assertEqual(result.stderr, b"")

    def test_manifest_rejects_non_manifest_files_and_invalid_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"hello"
            (root / "README.md").write_bytes(payload)
            (root / "extra.txt").write_bytes(payload)
            checksum = {"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            data = {"schema": 1, "version": "1.0.0", "architectures": ["x64", "arm64"], "files": {"README.md": checksum}}
            index = root / "manifest.json"
            index.write_text(json.dumps(data))
            with self.assertRaisesRegex(CLI["SetupError"], "unexpected_package_files"):
                CLI["manifest"](root)
            data["files"]["../README.md"] = checksum
            index.write_text(json.dumps(data))
            with self.assertRaisesRegex(CLI["SetupError"], "invalid_manifest"):
                CLI["manifest"](root)


class PlatformTests(unittest.TestCase):
    def test_distro_support_stays_inside_the_existing_ssh_helper_budget(self):
        source = build.SOURCES["helpers/RemoteCodexIsolate.py"].read_bytes()
        self.assertLessEqual(len(source), 32768)
        self.assertLessEqual(len(base64.b64encode(zlib.compress(source, 9))), 12288)

    def check_platform(self, distro, like, family, machine):
        fields = CLI["distro_fields"](f'ID={distro}\nID_LIKE="{like}"\nVERSION_ID=24\n')
        result = CLI["classify"]("Linux", machine, fields, "glibc 2.39")
        self.assertIsNone(result["blocker"])
        self.assertEqual(result["packageManager"], family)
        self.assertEqual(result["architecture"], {"aarch64": "arm64", "x86_64": "x64"}[machine])
        return result

    def test_ubuntu_and_debian_use_apt_dependencies(self):
        for distro, like in (("ubuntu", "debian"), ("debian", ""), ("linuxmint", "ubuntu debian")):
            with self.subTest(distro=distro):
                self.assertIn("iproute2", self.check_platform(distro, like, "apt", "x86_64")["dependencyCommand"])

    def test_fedora_and_el_use_dnf_dependencies(self):
        for distro, like in (("fedora", ""), ("rhel", "fedora"), ("rocky", "rhel centos fedora"), ("almalinux", "rhel fedora")):
            with self.subTest(distro=distro):
                self.assertIn("iproute", self.check_platform(distro, like, "dnf", "aarch64")["dependencyCommand"])

    def test_native_windows_macos_musl_and_other_cpus_are_reported_separately(self):
        checks = [("Windows", "AMD64", "", "linux_required"), ("Darwin", "arm64", "", "linux_required"),
                  ("Linux", "aarch64", "", "glibc_2_28_required"), ("Linux", "x86_64", "glibc 2.27", "glibc_2_28_required"),
                  ("Linux", "riscv64", "glibc 2.40", "unsupported_cpu")]
        for system, machine, libc, blocker in checks:
            with self.subTest(system=system, machine=machine, libc=libc):
                self.assertEqual(CLI["classify"](system, machine, {}, libc)["blocker"], blocker)

    def test_ca_binding_projects_only_the_distro_bundle(self):
        source = build.SOURCES["helpers/RemoteCodexIsolate.py"]
        functions = ast.parse(source.read_bytes()).body
        binding = next(node for node in functions if isinstance(node, ast.FunctionDef) and node.name == "certificate_bindings")
        helpers = {"os": os}
        exec(compile(ast.Module(body=[binding], type_ignores=[]), str(source), "exec"), helpers)
        check = helpers["certificate_bindings"]
        bundle = "/etc/pki/tls/certs/ca-bundle.crt"
        with patch("os.path.isfile", return_value=False):
            self.assertEqual(check(), [])
        with patch("os.path.isfile", side_effect=lambda name: name == bundle):
            self.assertEqual(check(), ["--ro-bind", bundle, bundle, "--ro-bind", bundle, "/etc/pki/tls/cert.pem"])


class RuntimeTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux", "Linux path ownership and executable privileges")
    def test_existing_executable_requires_protected_path_including_symlink_hops(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            writable = root / "replaceable"
            writable.mkdir()
            binary = root / "true"
            shutil.copyfile("/usr/bin/true", binary)
            binary.chmod(0o700)
            entry = writable / "redirect"
            entry.symlink_to(binary)
            link = root / "alias"
            link.symlink_to(entry)
            arch = CLI["platform_info"]()["architecture"]
            self.assertEqual(runtimes.binary_path(link, arch), binary)
            writable.chmod(0o777)
            self.assertIsNone(runtimes.binary_path(link, arch))

    def test_shadowing_npm_launcher_blocks_before_installing_an_unreachable_cli(self):
        home = Path("/fixture/home")
        with patch.object(runtimes.shutil, "which", return_value="/usr/bin/codex"), \
                patch.object(runtimes, "binary_path", return_value=None), \
                patch.object(runtimes, "stage_cli", side_effect=AssertionError("must not stage a shadowed binary")):
            with self.assertRaisesRegex(runtimes.SetupError, "incompatible_runtime_on_ssh_path"):
                runtimes.install_cli({}, "codex", "x64", home, home, None, None)

    def test_architecture_selection_is_pinned_and_sdk_package_pin_matches_bridge(self):
        catalog = json.loads((HERE / "runtime-catalog.json").read_bytes())
        sdk_source = build.SOURCES["helpers/RemoteDshClaudeSdk.py"].read_text(encoding="utf-8")
        self.assertIn(f'SDK_VERSION = "{catalog["claude-sdk"]["version"]}"', sdk_source)
        for kind in ("codex", "claude", "node", "antigravity"):
            with self.subTest(kind=kind):
                self.assertNotEqual(runtimes.selected_artifact(catalog, kind, "x64"),
                                    runtimes.selected_artifact(catalog, kind, "arm64"))
        self.assertEqual(runtimes.selected_artifact(catalog, "claude-sdk", "x64"),
                         runtimes.selected_artifact(catalog, "claude-sdk", "arm64"))

    def test_offline_download_stays_offline_and_tampered_artifacts_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sample = b"offline fixture"
            (root / "codex.tgz").write_bytes(sample)
            spec = {"url": "https://registry.npmjs.org/@openai/codex/-/codex.tgz",
                    "integrity": "sha256-" + hashlib.sha256(sample).hexdigest()}
            with patch.object(runtimes, "build_opener", side_effect=AssertionError("unexpected network")):
                runtimes.download(spec, root / "verified", root)
                self.assertEqual((root / "verified").read_bytes(), sample)
                (root / "codex.tgz").write_bytes(b"untrusted bytes")
                with self.assertRaisesRegex(runtimes.SetupError, "artifact_digest_mismatch"):
                    runtimes.download(spec, root / "invalid", root)
                with self.assertRaisesRegex(runtimes.SetupError, "invalid_runtime_catalog"):
                    runtimes.download({**spec, "url": "https://example.com/codex.tgz"}, root / "invalid-origin", root)

    def test_archive_uses_selected_files_only_and_rejects_a_selected_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "allowed.tgz"
            sample = b"binary fixture"
            with tarfile.open(archive, "w:gz") as tar:
                for name in ("package/codex", "../../escaped"):
                    member = tarfile.TarInfo(name)
                    member.size = len(sample)
                    tar.addfile(member, io.BytesIO(sample))
            out = root / "selected"
            runtimes.copy_members(archive, out, {"package/codex": ("codex", 0o700, True)})
            self.assertEqual((out / "codex").read_bytes(), sample)
            self.assertEqual(list(out.iterdir()), [out / "codex"])
            archive = root / "invalid.tgz"
            with tarfile.open(archive, "w:gz") as tar:
                member = tarfile.TarInfo("package/codex")
                member.type = tarfile.SYMTYPE
                member.linkname = "/etc/passwd"
                tar.addfile(member)
            with self.assertRaisesRegex(runtimes.SetupError, "invalid_archive_member"):
                runtimes.copy_members(archive, out, {"package/codex": ("codex", 0o700, True)})


if __name__ == "__main__":
    unittest.main()
