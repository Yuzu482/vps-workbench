"""Read VPS readiness without submitting a model turn or exposing credentials."""
import contextlib
import io
import json
import os
from pathlib import Path
import resource
import shutil
import stat
import subprocess
import tempfile


def private_file(path, limit):
    try:
        info = path.lstat()
        return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
                info.st_mode & 0o077 == 0 and info.st_nlink == 1 and 0 < info.st_size <= limit)
    except OSError:
        return False


def bound_output():
    resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))


def check_account(config, modules, home):
    provider = config["provider"]
    tool = {"codex": "codex", "claude": "claude", "claude-sdk": "claude", "antigravity": "agy"}[provider]
    env = {"HOME": str(home), "PATH": str(home / ".local/bin") + ":/usr/local/bin:/usr/bin:/bin:/snap/bin",
           "LANG": "C.UTF-8", "TERM": "dumb"}
    binary = shutil.which(tool, path=env["PATH"])
    if not binary or not os.access("/usr/bin/bwrap", os.X_OK):
        return "runtime_missing"
    if provider == "antigravity":
        root = home / ".dsh-antigravity"
        if not private_file(root / "hosts.json", 4096):
            return "runtime_missing"
        if not (root / "home").is_dir():
            return "account_missing"
        return "manual"

    profile = home / ".claude"
    credential = {
        "codex": home / ".codex/auth.json",
        "claude": home / ".config/remote-ssh/anthropic-api-key",
        "claude-sdk": profile / ".credentials.json",
    }[provider]
    if not private_file(credential, 8192 if provider == "claude" else 256 * 1024):
        return "account_missing"
    if provider == "claude":
        if config["enforceEncryptedKey"] and not modules["isolation"]["dsh_api_storage_ready"](str(home)):
            return "encrypted_home_required"
    if provider == "claude-sdk":
        try:
            modules["sdk"]["sdk_runtime"](str(home))
        except (OSError, ValueError, AttributeError):
            return "runtime_missing"
    try:
        executable, _, _ = modules["isolation"]["validate_paths"](
            binary, config["workspace"], env, provider=tool, subscription=provider == "claude-sdk")
    except (OSError, ValueError):
        return "runtime_missing"
    if provider == "claude":
        return "key_configured"
    if provider == "codex":
        env["CODEX_HOME"] = str(home / ".codex")
        argv = [executable, "-c", 'cli_auth_credentials_store="file"', "login", "status"]
    else:
        env.update(CLAUDE_CONFIG_DIR=str(profile), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                   DISABLE_TELEMETRY="1", ENABLE_CLAUDEAI_MCP_SERVERS="false")
        argv = [executable, "auth", "status", "--json"]
    try:
        with tempfile.TemporaryFile() as output:
            status = subprocess.run(argv, cwd="/tmp", env=env, stdin=subprocess.DEVNULL,
                                    stdout=output, stderr=subprocess.DEVNULL, timeout=12,
                                    preexec_fn=bound_output)
            if status.returncode != 0:
                return "account_missing"
            if provider == "claude-sdk":
                output.seek(0)
                auth = json.loads(output.read(65537))
                if not isinstance(auth, dict) or auth.get("loggedIn") is not True or auth.get("authMethod") != "claude.ai":
                    return "account_missing"
    except (OSError, ValueError, subprocess.SubprocessError):
        return "account_unavailable"
    return "signed_in"


def check(config, modules):
    kind = config["kind"]
    if kind == "ssh":
        workspace = Path(config["workspace"])
        return "connected" if (workspace.is_dir() and os.access(workspace, os.R_OK | os.X_OK)) else "workspace_unavailable"
    home = Path.home().resolve(strict=True)
    if kind == "account":
        return check_account(config, modules, home)
    if kind == "model":
        privacy = modules["privacy"]
        provider = {"codex": "codex", "claude": "claude", "claude-sdk": "claude-subscription",
                    "antigravity": "codex"}[config["provider"]]
        try:
            expected4 = privacy["address"](config["expectedIpv4"], 4)
            expected6 = privacy["address"](config["expectedIpv6"], 6) if config["expectedIpv6"] else None
            hosts = None
            if config["provider"] == "antigravity":
                path = home / ".dsh-antigravity/hosts.json"
                if not private_file(path, 4096):
                    return "egress_unverified"
                with path.open("rb") as stream:
                    hosts = modules["agy"]["allowed_hosts"](json.loads(stream.read(4097)))
            with contextlib.redirect_stdout(io.StringIO()):
                ready = privacy["preflight"](expected4, expected6, privacy["clean_environment"](os.environ), provider,
                                             service_hosts=hosts)
            return "model_route_ready" if ready else "egress_unverified"
        except (OSError, ValueError, TypeError):
            return "egress_unverified"
    if kind == "resources":
        try:
            with tempfile.TemporaryDirectory(prefix="workbench-mcp-check-") as gate:
                modules["extensions"]["prepare"](gate, home, config["mcpServers"])
        except (OSError, ValueError):
            return "resources_unavailable"
        return "resources_ready"
    raise ValueError("invalid setup check")
