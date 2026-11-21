"""Synthetic evidence for SSH-source exposure; no external network is used."""
import os
import shutil
import socket
import subprocess
import sys
import unittest

MARKER = b"203.0.113.93"


@unittest.skipUnless(sys.platform == "linux", "requires Linux procfs and namespaces")
class SourceIsolationEvidence(unittest.TestCase):
    def clean_environment(self):
        return {key: value for key, value in os.environ.items() if not key.upper().startswith("SSH_")}

    def test_clean_child_can_still_read_parent_environment(self):
        self.assertIn(MARKER.decode(), os.environ.get("SSH_CONNECTION", ""), "test parent needs synthetic SSH_CONNECTION")
        code = ("import os,pathlib\ntry:\n data=(pathlib.Path('/proc')/str(os.getppid())/'environ').read_bytes()\n"
                " print('parent_marker='+str(b'203.0.113.93' in data))\n"
                "except PermissionError:\n print('parent_marker=denied')\n"
                "print('child_ssh='+str(any(k.upper().startswith('SSH_') for k in os.environ)))")
        result = subprocess.run([sys.executable, "-c", code], env=self.clean_environment(), capture_output=True, timeout=5, check=True)
        self.assertTrue(b"parent_marker=True" in result.stdout or b"parent_marker=denied" in result.stdout)
        self.assertIn(b"child_ssh=False", result.stdout)

    @unittest.skipUnless(shutil.which("bwrap"), "bubblewrap not installed")
    def test_pid_isolation_alone_does_not_hide_shared_network(self):
        listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen(1)
        client = socket.create_connection(listener.getsockname()); server, _ = listener.accept()
        port = client.getsockname()[1]
        code = ("import pathlib,sys; p=int(sys.argv[1]); rows=pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:]; "
                "print(any(int(v.rsplit(':',1)[1],16)==p for row in rows for v in row.split()[1:3]))")
        base = ["bwrap", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-pid", "--new-session"]
        try:
            shared = subprocess.run([*base, "--", sys.executable, "-c", code, str(port)], env=self.clean_environment(),
                                    capture_output=True, timeout=10)
            isolated = subprocess.run([*base, "--unshare-net", "--", sys.executable, "-c", code, str(port)], env=self.clean_environment(),
                                      capture_output=True, timeout=10)
            if shared.returncode or isolated.returncode:
                self.skipTest("unprivileged PID/network namespaces are unavailable")
            self.assertEqual(shared.stdout.strip(), b"True")
            self.assertEqual(isolated.stdout.strip(), b"False")
        finally:
            client.close(); server.close(); listener.close()


if __name__ == "__main__":
    unittest.main()
