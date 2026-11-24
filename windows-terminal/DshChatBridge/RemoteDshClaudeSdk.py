"""Launch the personal Claude Agent SDK using the existing VPS account sandbox."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile


SDK_VERSION = "0.3.311"
WORKER = "dsh-claude-sdk-worker.mjs"
SDK_MOUNT = "/opt/dsh-claude-sdk"
NODE_MOUNT = "/opt/dsh-claude-node"


def sdk_directory(base, *relative):
    directory = base
    for part in relative:
        directory /= part
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError("unsafe SDK package directory")
    return directory


def sdk_runtime(home):
    root = sdk_directory(Path(home).resolve(strict=True), ".dsh-claude-sdk")
    directory = sdk_directory(root, "node_modules", "@anthropic-ai", "claude-agent-sdk")
    node = sdk_directory(root, "runtime", "bin") / "node"
    info = node.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o6022 or
            not os.access(node, os.X_OK)):
        raise ValueError("unsafe Node runtime")
    for filename in ("sdk.mjs", "package.json"):
        info = (directory / filename).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError("unsafe SDK package file")
    with (directory / "package.json").open("rb") as stream:
        manifest = json.loads(stream.read(65537))
    if (not isinstance(manifest, dict) or manifest.get("name") != "@anthropic-ai/claude-agent-sdk" or
            manifest.get("version") != SDK_VERSION):
        raise ValueError("unexpected SDK package version")
    return node, directory


def sdk_command(isolation, native, executable, work, home, profile, gate_dir, node, package, memory_isolation=False, mounts=None,
                design=False):
    prefix, separator, _ = isolation["RUNNER"].partition("input_data=None\n")
    if not separator:
        raise ValueError("incompatible sandbox runner")
    disable_memory = "env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']='1'\n" if memory_isolation else ""
    workflow_env = "env['DSH_WORKFLOW_FILES']='1'\n" if mounts else ""
    runner = prefix + disable_memory + workflow_env + r'''
import resource,tempfile
env.pop('CODEX_HOME',None)
env['CLAUDE_CONFIG_DIR']='/home/codex/.claude'
env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']='1'
env['DISABLE_TELEMETRY']='1'
env['ENABLE_CLAUDEAI_MCP_SERVERS']='false'
env['PWD']=payload['workspace']
def limit_auth_output():
 resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536))
try:
 with tempfile.TemporaryFile() as output:
  status=subprocess.run(['/opt/claude','auth','status','--json'],cwd='/tmp',env=env,
      stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.DEVNULL,timeout=12,preexec_fn=limit_auth_output)
  output.seek(0); auth=json.loads(output.read(65537))
 if status.returncode or auth.get('loggedIn') is not True or auth.get('authMethod')!='claude.ai':
  sys.exit(2)
 result=subprocess.run(['/opt/dsh-claude-node','/run/gate/dsh-claude-sdk-worker.mjs'],cwd=payload['workspace'],env=env)
finally:
 stopped.set(); listener.close()
sys.exit(result.returncode if result.returncode>=0 else 128-result.returncode)
'''
    workspace = "/workspace" if mounts else native["isolated_workspace_path"](work)
    source = tempfile.mkdtemp(dir=gate_dir) if design else mounts[0] if mounts else work
    command = isolation["sandbox_command"](
        executable, source, None, gate_dir, [], chat_home=None if mounts else str(profile), provider="claude",
        native_home=None if mounts else str(home), subscription=not mounts, workspace_target=workspace, runner_script=runner,
        uploads=mounts[1] if mounts else None, read_only_workspace=design or bool(mounts))
    split = command.index("--")
    command[split:split] = ["--dir", SDK_MOUNT, "--ro-bind", str(package), SDK_MOUNT, "--ro-bind", str(node), NODE_MOUNT]
    if mounts:
        command[split:split] = ["--ro-bind", str(profile / ".credentials.json"), "/home/codex/.claude/.credentials.json"]
    return command


def run(privacy, isolation, config, reply, support, workflow=None):
    if ("workflowFiles" in config) != bool(workflow):
        raise ValueError("workflow isolation unavailable")
    class SdkConversation(support["Conversation"]):
        account_rejected = False

        def notification(self, method, params):
            outcome = super().notification(method, params)
            if outcome == "failed" and params["turn"].get("error") == "oauth_org_not_allowed":
                self.account_rejected = True
            return outcome

    environment = privacy["clean_environment"](os.environ)
    expected4 = privacy["address"](config["expectedIpv4"], 4)
    expected6 = privacy["address"](config["expectedIpv6"], 6) if config["expectedIpv6"] is not None else None
    driver = SdkConversation(reply, config)
    stopped = support["stop_requested"]
    inflate = support["inflate"]
    sdk = config["sdk"]
    reason = "sdk_setup"
    try:
        if stopped(reply.directory):
            return "stopped", None, None
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            ready = privacy["preflight"](expected4, expected6, environment, "claude-subscription")
        reply.checks = [line[:320] for line in output.getvalue().splitlines()
                        if line.startswith(("IPv4 出口：", "IPv6：", "服务域名", "隐私检查未通过"))][:4]
        if stopped(reply.directory):
            return "stopped", None, None
        if not ready:
            return "failed", None, "egress"
        node, package = sdk_runtime(environment["HOME"])
        path = shutil.which("claude", path=environment.get("PATH"))
        path = path or str(Path(environment["HOME"]) / ".local/bin/claude")
        executable, work, _ = isolation["validate_paths"](
            path, config["workspace"], environment, provider="claude", subscription=True)
        native = dict(isolation)
        for key in ("safety", "session", "paths"):
            exec(compile(inflate(sdk[key], 32768), "<native-" + key + ">", "exec"), native)
        state, home, profile = native["native_profile"](environment["HOME"], "claude")
        credential = (profile / ".credentials.json").lstat()
        support["require_private"](credential, stat.S_ISREG)
        if credential.st_nlink != 1:
            raise ValueError("unsafe native Claude account")
        with native["native_lock"](state) as lease, tempfile.TemporaryDirectory(prefix="claude-sdk-gate-") as gate, contextlib.ExitStack() as lifetime:
            mounts = None
            if workflow:
                temporary = lifetime.enter_context(tempfile.TemporaryDirectory(prefix="workflow-inputs-"))
                mounts = workflow["prepare"](config["workflowFiles"], config["workspace"], environment["HOME"], config["taskId"], temporary)
            (Path(gate) / WORKER).write_bytes(inflate(sdk["worker"], 32768))
            allowed = isolation["CLAUDE_SUBSCRIPTION_HOSTS"]
            with isolation["Gateway"](os.path.join(gate, "proxy.sock"), isolation["global_connection"], allowed):
                command = sdk_command(isolation, native, executable, work, home, profile, gate, node, package,
                                      memory_isolation=config.get("memoryIsolation") is True, mounts=mounts, design=config["design"])
                command[1:1] = ["--sync-fd", str(lease.fileno())]
                if stopped(reply.directory):
                    return "stopped", None, None
                reply.publish("running")
                options = dict(stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    env={"PATH": "/usr/bin:/usr/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"},
                    pass_fds=(lease.fileno(),))
                process = (lifetime.enter_context(workflow["output_process"](command, mounts[2], **options))
                           if workflow else subprocess.Popen(command, **options))
                try:
                    result = driver.drive(process)
                    reason = "turn_failed" if result == "failed" else None
                    if driver.account_rejected:
                        reason = "oauth_org_not_allowed"
                finally:
                    support["close_server"](process)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, EOFError, subprocess.SubprocessError):
        result = "unknown" if driver.dispatched else "failed"
        if driver.dispatched:
            reason = driver.reason
    return result, driver.thread if driver.turn is not None else None, reason
