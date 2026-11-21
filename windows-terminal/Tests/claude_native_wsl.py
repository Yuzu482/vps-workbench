"""Optional offline test of an official npm-packed Linux Claude binary, with an empty temporary home."""
import base64
import os
from pathlib import Path
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit("Provide the official @anthropic-ai/claude-code-linux-x64 .tgz path")
root = Path(__file__).resolve().parents[1]
wsl = Path(os.environ["SystemRoot"]) / "System32" / "wsl.exe"
distro = os.environ.get("REMOTE_TEST_WSL_DISTRO", "Ubuntu-24.04")
auth = base64.b64encode((root / "RemoteClaudeAuth.py").read_bytes()).decode("ascii")
runner = r'''import base64,importlib.util,pathlib,shutil,sys,tarfile,tempfile,uuid
with tempfile.TemporaryDirectory(prefix='claude-native-status-') as directory:
 p=pathlib.Path(directory); home=p/'home'; home.mkdir(mode=0o700); binary=home/'.local'/'bin'; binary.mkdir(parents=True)
 with tarfile.open(fileobj=sys.stdin.buffer,mode='r|gz') as archive:
  member=next(x for x in archive if x.name=='package/claude'); source=archive.extractfile(member)
  with (binary/'claude').open('wb') as out: shutil.copyfileobj(source,out)
 (binary/'claude').chmod(0o700)
 helper=p/'RemoteClaudeAuth.py'; helper.write_bytes(base64.b64decode('__AUTH__'))
 spec=importlib.util.spec_from_file_location('auth',helper); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
 session=str(uuid.uuid4()); value=module.status(session,{'HOME':str(home),'PATH':'/usr/bin:/bin','SSH_CONNECTION':'fixture-sensitive'})
 print('official CLI, empty profile, isolated offline status:',value,flush=True)
 sys.exit(0 if value=='not_logged_in' else 1)
'''.replace('__AUTH__', auth)
with Path(sys.argv[1]).resolve().open('rb') as archive:
    result = subprocess.run([str(wsl), "-d", distro, "-u", "nobody", "--cd", "/tmp", "--exec", "python3", "-B", "-c", runner],
                            stdin=archive, timeout=120)
sys.exit(result.returncode)
