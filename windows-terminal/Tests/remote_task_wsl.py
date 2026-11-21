"""Run Linux task lifecycle and live-output tests without remote credentials."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
payload = {"helper": base64.b64encode((root / "RemoteTask.py").read_bytes()).decode("ascii"),
           "test": base64.b64encode((root / "Tests" / "test_remote_task.py").read_bytes()).decode("ascii")}
runner = r'''import base64,json,pathlib,subprocess,sys,tempfile
a=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='remote-task-suite-') as d:
 p=pathlib.Path(d); (p/'Tests').mkdir()
 (p/'RemoteTask.py').write_bytes(base64.b64decode(a['helper']))
 (p/'Tests'/'test_remote_task.py').write_bytes(base64.b64decode(a['test']))
 r=subprocess.run([sys.executable,'-B',str(p/'Tests'/'test_remote_task.py'),'-q'])
 sys.exit(r.returncode)
'''
wsl = Path(os.environ["SystemRoot"]) / "System32" / "wsl.exe"
command = [str(wsl), "-d", os.environ.get("REMOTE_TEST_WSL_DISTRO", "Ubuntu-24.04"),
           "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-B", "-c", runner]
result = subprocess.run(command, input=json.dumps(payload).encode("ascii"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=75)
sys.stdout.buffer.write(result.stdout); sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
