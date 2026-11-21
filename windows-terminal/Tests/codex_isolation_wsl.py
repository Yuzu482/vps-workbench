"""Run isolated Codex synthetic tests in WSL as an unprivileged user."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
payload = {"helper": base64.b64encode((root / "RemoteCodexIsolate.py").read_bytes()).decode("ascii"),
           "safety": base64.b64encode((root / "RemoteNativeSafety.py").read_bytes()).decode("ascii"),
           "native": base64.b64encode((root / "RemoteNativeSession.py").read_bytes()).decode("ascii"),
           "chat": base64.b64encode((root / "RemoteChatFiles.py").read_bytes()).decode("ascii"),
           "claudeauth": base64.b64encode((root / "RemoteClaudeAuth.py").read_bytes()).decode("ascii"),
           "claudeshared": base64.b64encode((root / "RemoteClaudeShared.py").read_bytes()).decode("ascii"),
           "test": base64.b64encode((root / "Tests" / "test_codex_isolation_linux.py").read_bytes()).decode("ascii"),
           "privacy": base64.b64encode((root / "RemoteCodexPrivacy.py").read_bytes()).decode("ascii"),
           "task": base64.b64encode((root / "RemoteTask.py").read_bytes()).decode("ascii")}
runner = r'''import base64,json,pathlib,subprocess,sys,tempfile
j=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='codex-isolation-suite-') as d:
 p=pathlib.Path(d); (p/'Tests').mkdir()
 (p/'RemoteCodexIsolate.py').write_bytes(base64.b64decode(j['helper']))
 (p/'RemoteNativeSafety.py').write_bytes(base64.b64decode(j['safety']))
 (p/'RemoteNativeSession.py').write_bytes(base64.b64decode(j['native']))
 (p/'RemoteChatFiles.py').write_bytes(base64.b64decode(j['chat']))
 (p/'RemoteClaudeAuth.py').write_bytes(base64.b64decode(j['claudeauth']))
 (p/'RemoteClaudeShared.py').write_bytes(base64.b64decode(j['claudeshared']))
 (p/'RemoteCodexPrivacy.py').write_bytes(base64.b64decode(j['privacy']))
 (p/'RemoteTask.py').write_bytes(base64.b64decode(j['task']))
 (p/'Tests'/'test_codex_isolation_linux.py').write_bytes(base64.b64decode(j['test']))
 r=subprocess.run([sys.executable,'-B','-m','unittest','discover','-s',str(p/'Tests'),'-p','test_codex_isolation_linux.py','-v'])
 sys.exit(r.returncode)
'''
wsl = Path(os.environ["SystemRoot"]) / "System32" / "wsl.exe"
distro = os.environ.get("REMOTE_TEST_WSL_DISTRO", "Ubuntu-24.04")
command = [str(wsl), "-d", distro, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-B", "-c", runner]
result = subprocess.run(command, input=json.dumps(payload).encode("ascii"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
