#!/usr/bin/env python3
"""Run a remote agent in the Linux Workbench sandbox."""
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import uuid


ALLOWED_HOSTS = frozenset(("chatgpt.com", "api.openai.com"))
CLAUDE_HOSTS = frozenset(("api.anthropic.com",))
CLAUDE_SUBSCRIPTION_HOSTS = CLAUDE_HOSTS | frozenset(("platform.claude.com",))
MAX_HEADER = 8192


def global_connection(host):
    """Connect only to a resolved public IP; never reconnect by hostname."""
    addresses = socket.getaddrinfo(host, 443, 0, socket.SOCK_STREAM)
    for family, kind, protocol, _, target in addresses:
        try:
            value = ipaddress.ip_address(target[0])
            if getattr(value, "ipv4_mapped", None):
                value = value.ipv4_mapped
            if not value.is_global:
                continue
            connection = socket.socket(family, kind, protocol)
            connection.settimeout(8)
            try:
                connection.connect(target)
                connection.settimeout(None)
                return connection
            except OSError:
                connection.close()
        except ValueError:
            continue
    raise OSError("no public provider address available")


def pump(first, second):
    """Relay a connection in both directions, preserving half-closes."""
    peers = {first: second, second: first}
    active = set(peers)
    while active:
        readable, _, _ = select.select(list(active), [], [], 60)
        if not readable:
            continue
        for source in readable:
            try:
                data = source.recv(65536)
            except OSError:
                data = b""
            if data:
                try:
                    peers[source].sendall(data)
                except OSError:
                    return
            else:
                active.remove(source)
                try:
                    peers[source].shutdown(socket.SHUT_WR)
                except OSError:
                    pass


class Gateway:
    def __init__(self, path, connector=global_connection, allowed_hosts=ALLOWED_HOSTS):
        self.path = path
        self.connector = connector
        self.allowed_hosts = allowed_hosts
        self.stop = threading.Event()
        self.slots = threading.BoundedSemaphore(16)
        directory = os.path.dirname(path)
        for name, content in (("passwd", "codex:x:1000:1000:Codex:/home/codex:/bin/sh\n"),
                              ("group", "codex:x:1000:\n"),
                              ("nsswitch.conf", "passwd: files\ngroup: files\nhosts: files dns\n"),
                              ("hosts", "127.0.0.1 localhost\n::1 localhost\n")):
            with open(os.path.join(directory, name), "x", encoding="ascii") as stream:
                stream.write(content)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(path)
        os.chmod(path, 0o600)
        self.listener.listen(16)
        self.listener.settimeout(0.25)
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.listener.close()
        self.thread.join(timeout=2)

    def serve(self):
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not self.slots.acquire(blocking=False):
                client.close()
                continue
            threading.Thread(target=self.handle, args=(client,), daemon=True).start()

    def handle(self, client):
        try:
            with client:
                client.settimeout(8)
                data = bytearray()
                while b"\r\n\r\n" not in data and len(data) <= MAX_HEADER:
                    chunk = client.recv(min(2048, MAX_HEADER + 1 - len(data)))
                    if not chunk:
                        return
                    data.extend(chunk)
                if len(data) > MAX_HEADER or b"\r\n\r\n" not in data:
                    return
                header, pending = bytes(data).split(b"\r\n\r\n", 1)
                line = header.split(b"\r\n", 1)[0]
                match = re.fullmatch(rb"CONNECT ([A-Za-z0-9.-]+):443 HTTP/1\.[01]", line)
                host = match.group(1).decode("ascii").lower() if match else ""
                if host not in self.allowed_hosts:
                    client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                    return
                try:
                    remote = self.connector(host)
                except OSError:
                    client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                    return
                with remote:
                    client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    if pending:
                        remote.sendall(pending)
                    client.settimeout(None)
                    pump(client, remote)
        except (OSError, ValueError):
            pass
        finally:
            self.slots.release()


# This code runs inside the PID/network/mount namespaces after bubblewrap has
# configured loopback and dropped every capability from the workload.
RUNNER = r'''
import base64,json,os,pathlib,select,socket,subprocess,sys,threading
payload=json.loads(base64.b64decode(sys.argv[1]))
provider=payload.get('provider','codex') if isinstance(payload,dict) else 'codex'
command=payload['argv'] if isinstance(payload,dict) else payload
listener=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
listener.bind(('127.0.0.1',0)); listener.listen(16); listener.settimeout(.25)
proxy='http://127.0.0.1:'+str(listener.getsockname()[1])
stopped=threading.Event()
def transfer(a,b):
 peers={a:b,b:a}; active=set(peers)
 while active:
  ready,_,_=select.select(list(active),[],[],60)
  for s in ready:
   try: data=s.recv(65536)
   except OSError: data=b''
   if data:
    try: peers[s].sendall(data)
    except OSError: return
   else:
    active.remove(s)
    try: peers[s].shutdown(socket.SHUT_WR)
    except OSError: pass
def bridge(client):
 try:
  with client:
   with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as remote:
    remote.connect('/run/gate/proxy.sock'); transfer(client,remote)
 except OSError: pass
def serve():
 while not stopped.is_set():
  try: client,_=listener.accept()
  except socket.timeout: continue
  except OSError: break
  threading.Thread(target=bridge,args=(client,),daemon=True).start()
threading.Thread(target=serve,daemon=True).start()
env={'HOME':'/home/codex','CODEX_HOME':'/home/codex/.codex','PATH':'/usr/bin:/usr/sbin:/bin',
     'LANG':'C.UTF-8','TERM':'dumb','USER':'codex','LOGNAME':'codex','PWD':'/workspace',
     'HTTP_PROXY':proxy,'HTTPS_PROXY':proxy,'http_proxy':proxy,'https_proxy':proxy,
     'WS_PROXY':proxy,'WSS_PROXY':proxy}
input_data=None
if provider=='claude':
 env.pop('CODEX_HOME',None); env['CLAUDE_CONFIG_DIR']='/home/codex/.claude'
 env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']='1'; env['DISABLE_TELEMETRY']='1'
 if payload.get('subscription'):
  env['ENABLE_CLAUDEAI_MCP_SERVERS']='false'
 else:
  env['ANTHROPIC_API_KEY']=pathlib.Path('/run/anthropic-key').read_text(encoding='utf-8').strip()
 if payload.get('claudeStdin') is True:
  input_data=sys.stdin.buffer.read(65537)
  if not input_data or len(input_data)>65536:
   sys.exit(2)
 else:
  content=[{'type':'text','text':payload['prompt']}]
  types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}
  for name in payload['images']:
   p=pathlib.Path(name); content.append({'type':'image','source':{'type':'base64','media_type':types[p.suffix],
        'data':base64.b64encode(p.read_bytes()).decode('ascii')}})
  input_data=(json.dumps({'type':'user','message':{'role':'user','content':content}},ensure_ascii=False)+'\n').encode('utf-8')
try:
 server_stdio=provider=='codex' and command[:1]==['app-server'] and payload.get('stdio') is True
 result=subprocess.run(['/opt/'+provider,*command],cwd='/workspace',env=env,input=input_data,
                       stdin=None if input_data is not None or server_stdio else subprocess.DEVNULL)
finally:
 stopped.set(); listener.close()
sys.exit(result.returncode if result.returncode>=0 else 128-result.returncode)
'''


def _inside(path, root):
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False


def check_workspace(work):
    # Block existing IPC and nested mounts; bounded scan may race host changes.
    with open("/proc/self/mountinfo", "r", encoding="utf-8") as mounts:
        for line in mounts:
            fields = line.split()
            if len(fields) < 5:
                raise ValueError("invalid mount information")
            point = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
            if point != work and _inside(point, work):
                raise ValueError("workspace has nested mounts")
    pending, count = [work], 0
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                count += 1
                if count > 200000:
                    raise ValueError("workspace inspection limit exceeded")
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISSOCK(info.st_mode) or stat.S_ISFIFO(info.st_mode) or stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode):
                    raise ValueError("workspace contains an IPC or device endpoint")
                if stat.S_ISDIR(info.st_mode):
                    pending.append(entry.path)


def validate_paths(program, workspace, environment, auth_override=None, provider="codex", subscription=False):
    if sys.platform != "linux" or os.getuid() == 0:
        raise ValueError("isolation requires an unprivileged Linux user")
    home_value = environment.get("HOME", "")
    if not os.path.isabs(home_value):
        raise ValueError("remote home is unavailable")
    home = os.path.realpath(home_value)
    if not os.path.isdir(home):
        raise ValueError("remote home is unavailable")
    work = os.path.realpath(workspace)
    if not os.path.isabs(workspace) or not os.path.isdir(work) or os.stat(work).st_uid != os.getuid():
        raise ValueError("workspace must be an existing user-owned absolute directory")
    # Do not accidentally mount an entire home, OS tree, or known private state.
    sensitive = [os.path.realpath(os.path.join(home, name)) for name in (".ssh", ".codex", ".claude", ".local", ".config", ".remote-ssh-chat")]
    if provider == "agy":
        sensitive += [os.path.realpath(os.path.join(home, name)) for name in (".gemini", ".dsh-antigravity")]
    if _inside(home, work) or any(_inside(work, root) or _inside(root, work) for root in sensitive):
        raise ValueError("workspace includes private home state")
    if any(_inside(work, root) for root in ("/etc", "/usr", "/var", "/run", "/proc", "/sys", "/dev")):
        raise ValueError("workspace is inside a system directory")
    check_workspace(work)
    executable = os.path.realpath(program)
    info = os.stat(executable)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & (stat.S_ISUID | stat.S_ISGID) or not os.access(executable, os.X_OK):
        raise ValueError("Codex executable is not a regular unprivileged file")
    with open(executable, "rb") as stream:
        if stream.read(4) != b"\x7fELF":
            raise ValueError("isolated mode requires a standalone Linux executable")
    if provider == "agy":
        if subscription or auth_override is not None:
            raise ValueError("invalid Antigravity configuration")
        return executable, work, None
    if subscription:
        if provider != "claude" or auth_override is not None:
            raise ValueError("invalid subscription configuration")
        return executable, work, None
    default_auth = os.path.join(home, ".codex", "auth.json") if provider == "codex" else os.path.join(home, ".config", "remote-ssh", "anthropic-api-key")
    auth = os.path.abspath(auth_override or default_auth)
    info = os.lstat(auth)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("remote auth file must be a private regular file owned by the user")
    if provider == "claude" and not 0 < info.st_size <= 8192:
        raise ValueError("invalid API key file")
    return executable, work, auth


def runtime_companions(executable):
    # Standalone Codex locates these helpers beside its own executable. Mount
    # only known ELF siblings, never an entire user-owned runtime directory.
    directory = os.path.dirname(executable)
    result = []
    for name in ("codex-code-mode-host", "codex-exec-server"):
        candidate = os.path.join(directory, name)
        if not os.path.lexists(candidate):
            continue
        target = os.path.realpath(candidate)
        if os.path.dirname(target) != directory:
            raise ValueError("Codex runtime helper escapes its installation directory")
        info = os.stat(target)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & (stat.S_ISUID | stat.S_ISGID) or not os.access(target, os.X_OK):
            raise ValueError("invalid Codex runtime helper")
        with open(target, "rb") as stream:
            if stream.read(4) != b"\x7fELF":
                raise ValueError("invalid Codex runtime helper")
        result.append((target, "/opt/" + name))
    return result


def certificate_bindings():
    # Project the Fedora/RHEL CA bundle without mounting all of /etc/pki.
    bundle = "/etc/pki/tls/certs/ca-bundle.crt"
    if not os.path.isfile(bundle):
        return []
    return ["--ro-bind", bundle, bundle, "--ro-bind", bundle, "/etc/pki/tls/cert.pem"]


def sandbox_command(executable, work, auth, gate_dir, argv, chat_home=None, uploads=None, provider="codex", prompt=None, images=None, native_home=None, subscription=False, shared_config=None, overlays=None, workspace_target="/workspace", runner_script=None, native_session_id=None, codex_stdio=False, read_only_workspace=False, claude_stdin=False):
    if workspace_target != "/workspace" and not re.fullmatch(r"/workspaces/[0-9a-f]{64}", workspace_target):
        raise ValueError("invalid isolated workspace target")
    data = {"provider": provider, "argv": argv, "prompt": prompt, "images": images or [], "subscription": subscription}
    if claude_stdin:
        if provider != "claude" or subscription or prompt is not None or images:
            raise ValueError("invalid Claude API transport")
        data["claudeStdin"] = True
    if codex_stdio:
        if provider != "codex" or argv[:1] != ["app-server"]:
            raise ValueError("invalid app-server transport")
        data["stdio"] = True
    if workspace_target != "/workspace" or runner_script is not None:
        data["workspace"] = workspace_target
    if native_session_id is not None:
        data["nativeSessionId"] = chat_identifier(native_session_id)
    payload = base64.b64encode(json.dumps(data, ensure_ascii=False).encode("utf-8")).decode("ascii")
    command = ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
               "--uid", "1000", "--gid", "1000", "--cap-drop", "ALL",
               "--hostname", "codex-isolated", "--new-session", "--die-with-parent",
               "--dir", "/usr", "--ro-bind", "/usr/bin", "/usr/bin", "--ro-bind", "/usr/sbin", "/usr/sbin",
               "--ro-bind", "/usr/lib", "/usr/lib", "--ro-bind-try", "/usr/lib64", "/usr/lib64",
               "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
               "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
               "--dir", "/etc", "--ro-bind-try", "/etc/ssl", "/etc/ssl",
               "--ro-bind", os.path.join(gate_dir, "passwd"), "/etc/passwd",
               "--ro-bind", os.path.join(gate_dir, "group"), "/etc/group",
               "--ro-bind", os.path.join(gate_dir, "nsswitch.conf"), "/etc/nsswitch.conf",
               "--ro-bind", os.path.join(gate_dir, "hosts"), "/etc/hosts",
               "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home",
               "--dir", "/home/codex", "--dir", "/home/codex/.codex", "--dir", "/home/codex/.claude"]
    command += certificate_bindings()
    if subscription:
        if provider != "claude" or native_home is None or chat_home is None or auth is not None:
            raise ValueError("invalid subscription mounts")
        command += ["--bind", native_home, "/home/codex"]
    if shared_config is not None and (not subscription or provider != "claude" or chat_home is None):
        raise ValueError("invalid shared profile")
    if chat_home is not None:
        command += ["--bind", shared_config or chat_home, "/home/codex/.codex" if provider == "codex" else "/home/codex/.claude"]
    for source, target in overlays or []:
        command += ["--bind", source, target]
    command += ["--dir", "/run", "--ro-bind", gate_dir, "/run/gate"]
    if auth is not None:
        command += ["--ro-bind", auth, "/home/codex/.codex/auth.json" if provider == "codex" else "/run/anthropic-key"]
    if codex_stdio:
        command += ["--ro-bind", os.path.join(gate_dir, "codex-config.toml"), "/home/codex/.codex/config.toml"]
    if workspace_target != "/workspace":
        command += ["--dir", "/workspaces"]
    command += ["--dir", workspace_target, "--ro-bind" if read_only_workspace else "--bind", work, workspace_target,
                "--dir", "/opt", "--ro-bind", executable, "/opt/" + provider]
    if uploads is not None:
        command += ["--dir", "/attachments", "--ro-bind", uploads, "/attachments"]
    for source, target in runtime_companions(executable) if provider == "codex" else []:
        command += ["--ro-bind", source, target]
    command += ["--chdir", workspace_target, "--clearenv", "--setenv", "PATH", "/usr/bin:/usr/sbin:/bin",
                "--setenv", "LANG", "C.UTF-8", "--", "/usr/bin/python3", "-I", "-c", RUNNER if runner_script is None else runner_script, payload]
    return command


def chat_identifier(value):
    parsed = str(uuid.UUID(value))
    if value != parsed:
        raise ValueError()
    return parsed


def chat_directory(parent, name, strict=False):
    path = Path(parent) / name
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & (0o077 if strict else 0o022):
        raise ValueError()
    return path


def chat_paths(home, session, turn, provider="codex"):
    root = Path(os.path.realpath(home))
    info = root.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError()
    root = chat_directory(root, ".remote-ssh-chat", True)
    root = chat_directory(root, chat_identifier(session), True)
    chat_home = chat_directory(root, provider + "-home", True)
    uploads = chat_directory(root, "uploads", True)
    # Bubblewrap needs a target for its read-only authentication bind. This is
    # an empty placeholder, never a copy of the remote credential.
    if provider == "codex":
        target = chat_home / "auth.json"
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd); os.close(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size:
            raise ValueError()
    if turn is not None:
        directory = uploads / chat_identifier(turn)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError()
        manifest = directory / "ready.json"
        fd = os.open(manifest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno()); raw = stream.read(8193)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or len(raw) > 8192:
            raise ValueError()
        value = json.loads(raw); files = value.get("files") if isinstance(value, dict) and set(value) == {"files"} else None
        if not isinstance(files, list) or not 1 <= len(files) <= 4:
            raise ValueError()
        total = 0
        for index, item in enumerate(files, 1):
            if (not isinstance(item, dict) or set(item) != {"name", "size", "sha256"} or
                    not isinstance(item["name"], str) or not re.fullmatch(r"f" + str(index) + r"(?:\.[a-z0-9]{1,10})?", item["name"]) or
                    type(item["size"]) is not int or not 0 <= item["size"] <= 5 * 1024 * 1024 or
                    not isinstance(item["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])):
                raise ValueError()
            total += item["size"]
            fd = os.open(directory / item["name"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size != item["size"]:
                    raise ValueError()
                if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                    raise ValueError()
        if total > 20 * 1024 * 1024:
            raise ValueError()
    check_workspace(str(chat_home)); check_workspace(str(uploads))
    return root, str(chat_home), str(uploads)


def chat_args(command):
    result, values, images, i = command[:2], {}, [], 2
    while i < len(command):
        arg = command[i]
        if arg == "--":
            result.extend(command[i:]); break
        if arg == "--chat-image":
            if i + 1 >= len(command) or len(images) >= 4:
                raise ValueError()
            images.append(command[i + 1]); i += 2
        elif arg in ("--chat-session", "--chat-turn", "--chat-prompt", "--chat-auth", "--chat-auth-source"):
            if arg in values or i + 1 >= len(command):
                raise ValueError()
            values[arg] = command[i + 1] if arg in ("--chat-prompt", "--chat-auth") else chat_identifier(command[i + 1]); i += 2
        else:
            result.append(arg); i += 1
    if "--chat-turn" in values and "--chat-session" not in values:
        raise ValueError()
    session, turn, prompt = values.get("--chat-session"), values.get("--chat-turn"), values.get("--chat-prompt")
    if prompt is not None and (not prompt.strip() or len(prompt) > 12288 or "\x00" in prompt):
        raise ValueError()
    if images and (turn is None or any(not re.fullmatch(r"/attachments/" + re.escape(turn) + r"/f[1-4]\.(?:png|jpg|jpeg|webp)", image) for image in images)):
        raise ValueError()
    auth = values.get("--chat-auth")
    if auth is not None and (auth != "subscription" or session is None):
        raise ValueError()
    source = values.get("--chat-auth-source")
    if source is not None and (auth != "subscription" or source == session):
        raise ValueError()
    return result, session, turn, prompt, images, auth == "subscription", source


def dsh_api_storage_ready(home, auth_override=None):
    """Check the filesystem and metadata without opening the API key."""
    try:
        if not os.path.isabs(home) or os.path.realpath(home) != home:
            return False
        home_info = os.lstat(home)
        if not stat.S_ISDIR(home_info.st_mode) or home_info.st_uid != os.getuid():
            return False
        device = f"{os.major(home_info.st_dev)}:{os.minor(home_info.st_dev)}"
        with (Path("/sys/dev/block") / device / "dm" / "uuid").open("r", encoding="ascii") as stream:
            identifier = stream.read(256).strip()
        if re.fullmatch(r"CRYPT-LUKS2-[0-9a-fA-F]{32}-[^\s]{1,128}", identifier) is None:
            return False
        key = os.path.join(home, ".config", "remote-ssh", "anthropic-api-key")
        if (auth_override is not None and auth_override != key) or os.path.realpath(key) != key:
            return False
        info = os.lstat(key)
        return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_dev == home_info.st_dev)
    except (OSError, ValueError):
        return False


def api_chat_input():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError("invalid Claude API input")
    packet = json.loads(raw)
    if not isinstance(packet, dict) or set(packet) != {"prompt", "memory"}:
        raise ValueError("invalid Claude API input")
    content = []
    for field, limit in (("prompt", 8192), ("memory", 24832)):
        text = packet[field]
        if not isinstance(text, str) or not text.strip() or len(text) > limit or "\0" in text:
            raise ValueError("invalid Claude API input")
        content.append({"type": "text", "text": text})
    frame = json.dumps({"type": "user", "message": {"role": "user", "content": content}}, ensure_ascii=False)
    data = (frame + "\n").encode("utf-8")
    if len(data) > 65536:
        raise ValueError("invalid Claude API frame")
    return data


def run(program, command, workspace, environment, _connector=None, _auth_path=None, _argv_override=None):
    """Start once; any setup failure returns nonzero and never falls back."""
    provider = os.path.basename(command[0]) if command else ""
    if provider not in ("codex", "claude") or command[1:2] != (["exec"] if provider == "codex" else ["-p"]):
        print("隔离模式仅支持指定的非交互模型程序。", file=sys.stderr)
        return 2
    try:
        encrypted_credentials = command[2:3] == ["--dsh-encrypted-credentials"]
        if encrypted_credentials:
            if provider != "claude" or not dsh_api_storage_ready(environment.get("HOME", ""), _auth_path):
                print("未启动 Claude API 请求。请挂载该 VPS 用户的 LUKS2 加密家目录，并配置权限为 0600 的 API 凭据。", file=sys.stderr)
                return 2
            command = command[:2] + command[3:]
        stream_input = None
        if command[2:3] == ["--dsh-api-chat-stdin"]:
            if not encrypted_credentials:
                raise ValueError("Claude API input requires encrypted credentials")
            stream_input = api_chat_input()
            command = command[:2] + command[3:]
        for path in ("/usr/bin/bwrap", "/usr/bin/python3"):
            if not os.path.isfile(path) or not os.access(path, os.X_OK):
                raise ValueError("required isolation utility is missing")
        command, session, turn, prompt, images, subscription, source = chat_args(command)
        if subscription and (provider != "claude" or encrypted_credentials):
            raise ValueError()
        executable, work, auth = validate_paths(program, workspace, environment, _auth_path, provider, subscription)
        if provider == "claude" and (session is None or (prompt is None and stream_input is None)):
            raise ValueError()
        if provider == "codex" and (prompt is not None or images):
            raise ValueError()
        chat_home = uploads = native_home = shared_config = None
        overlays = None
        lock = account_lock = None
        guard_root = guard_id = None
        try:
            if session is not None:
                root, chat_home, uploads = chat_paths(environment["HOME"], session, turn, provider)
                if subscription:
                    native_home = chat_directory(root, "native-home", True)
                    chat_directory(native_home, ".claude", True)
                    check_workspace(str(native_home))
                if source is not None:
                    if "shared_root" not in globals():
                        raise ValueError("shared profile support unavailable")
                    guard_root, guard_id = shared_root(environment["HOME"], source), source
                    account_lock = shared_lock(guard_root)
                fd = os.open(root / "session.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                lock = os.fdopen(fd, "r+b")
                info = os.fstat(lock.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise ValueError("invalid session lock")
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                if subscription and source is None and os.path.lexists(root / ".shared-account-v1.json"):
                    if "shared_verify" not in globals():
                        raise ValueError("shared profile support unavailable")
                    guard_root, guard_id = root, session
                if guard_root is not None:
                    config, entries = shared_verify(guard_root, guard_id)
                    check_workspace(str(config))
                    if source is not None:
                        shared_config = str(config)
                        overlays = shared_overlays(config, entries, chat_home)
                        check_workspace(chat_home)
            argv = _argv_override if _argv_override is not None else command[1:]
            with tempfile.TemporaryDirectory(prefix="codex-gate-") as directory:
                allowed = ALLOWED_HOSTS if provider == "codex" else CLAUDE_SUBSCRIPTION_HOSTS if subscription else CLAUDE_HOSTS
                gate = Gateway(os.path.join(directory, "proxy.sock"), _connector or global_connection, allowed)
                with gate:
                    start = sandbox_command(executable, work, auth, directory, argv, chat_home, uploads, provider, prompt, images, str(native_home) if native_home else None, subscription, shared_config, overlays, claude_stdin=stream_input is not None)
                    safe_env = {"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"}
                    lease = (account_lock or lock).fileno() if guard_root is not None else None
                    if lease is not None:
                        start[1:1] = ["--sync-fd", str(lease)]
                    result = subprocess.run(start, input=stream_input, stdin=subprocess.DEVNULL if stream_input is None else None,
                                            env=safe_env, close_fds=True,
                                            pass_fds=() if lease is None else (lease,))
                    if guard_root is not None:
                        try: shared_verify(guard_root, guard_id)
                        except (OSError, ValueError):
                            print("共享配置已变化；任务可能已执行，请检查原回执。", file=sys.stderr)
                            return 2
        finally:
            if lock is not None:
                lock.close()
            if account_lock is not None:
                account_lock.close()
        return result.returncode if result.returncode >= 0 else 128 - result.returncode
    except BlockingIOError:
        print("账号或会话正忙；本任务未启动模型。", file=sys.stderr)
        return 2
    except (OSError, ValueError, subprocess.SubprocessError):
        print("隔离环境无法建立；模型程序未以普通模式启动。", file=sys.stderr)
        return 2
