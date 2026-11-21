"""Run synthetic procfs/network-namespace checks as WSL's unprivileged nobody."""
import base64
import os
from pathlib import Path
import subprocess
import sys

test = Path(__file__).with_name("test_source_isolation_linux.py").read_bytes()
wsl = Path(os.environ["SystemRoot"]) / "System32" / "wsl.exe"
distro = os.environ.get("REMOTE_TEST_WSL_DISTRO", "Ubuntu-24.04")
runner = "import sys,base64;exec(compile(base64.b64decode(sys.stdin.read()),'test_source_isolation_linux.py','exec'),globals())"
command = [str(wsl), "-d", distro, "-u", "nobody", "--cd", "/tmp", "--exec", "env",
           "SSH_CONNECTION=203.0.113.93 23456 192.0.2.8 22", "python3", "-B", "-c", runner]
result = subprocess.run(command, input=base64.b64encode(test), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
