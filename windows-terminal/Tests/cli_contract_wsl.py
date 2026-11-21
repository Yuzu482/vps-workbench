"""Run cli_contract_linux.py with locally supplied npm archives in WSL."""
import os
from pathlib import Path
import struct
import subprocess
import sys

if len(sys.argv) != 3:
    raise SystemExit("expected paths to the local Codex and Claude npm archives")
files = [Path(__file__).with_name("cli_contract_linux.py"), Path(sys.argv[1]), Path(sys.argv[2])]
for item in files:
    if not item.is_file() or item.stat().st_size > 250 * 1024 * 1024:
        raise SystemExit("fixture file missing or too large")
runner = r'''import pathlib,struct,subprocess,sys,tempfile
def read_exact(n):
 out=b''
 while len(out)<n:
  b=sys.stdin.buffer.read(n-len(out))
  if not b: raise RuntimeError('incomplete fixture transfer')
  out+=b
 return out
with tempfile.TemporaryDirectory(prefix='remote-cli-contract-input-') as d:
 paths=[]
 for name in ('runner.py','codex.tgz','claude.tgz'):
  n=struct.unpack('>Q',read_exact(8))[0]
  if n>250*1024*1024: raise RuntimeError('fixture input too large')
  path=pathlib.Path(d)/name
  with path.open('wb') as f:
   while n:
    data=read_exact(min(n,1024*1024)); f.write(data); n-=len(data)
  paths.append(str(path))
 result=subprocess.run([sys.executable,'-B',*paths],timeout=250)
 sys.exit(result.returncode)
'''
wsl = Path(os.environ["SystemRoot"]) / "System32" / "wsl.exe"
process = subprocess.Popen([str(wsl), "-d", os.environ.get("REMOTE_TEST_WSL_DISTRO", "Ubuntu-24.04"), "-u", "nobody",
                            "--cd", "/tmp", "--exec", "python3", "-B", "-c", runner], stdin=subprocess.PIPE)
try:
    for item in files:
        process.stdin.write(struct.pack(">Q", item.stat().st_size))
        with item.open("rb") as source:
            while chunk := source.read(1024 * 1024): process.stdin.write(chunk)
    process.stdin.close()
    code = process.wait(timeout=280)
except BaseException:
    process.kill(); process.wait()
    raise
sys.exit(code)
