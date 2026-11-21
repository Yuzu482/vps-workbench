#!/usr/bin/env python3
"""Check a remote process's egress before replacing this process with Codex.

This checks observable configuration and routes, not all possible proxying or
application telemetry. It intentionally never prints proxy values or addresses.
"""
import argparse
import base64
import concurrent.futures
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import zlib


SERVICES = {
    4: ("https://api.ipify.org/", "https://ipv4.icanhazip.com/"),
    6: ("https://api64.ipify.org/", "https://ipv6.icanhazip.com/"),
}
HOSTS = ("chatgpt.com", "api.openai.com")
CLAUDE_HOSTS = ("api.anthropic.com",)
CLAUDE_SUBSCRIPTION_HOSTS = ("api.anthropic.com", "platform.claude.com")
OVERRIDES = {"OPENAI_BASE_URL", "OPENAI_API_BASE", "CHATGPT_BASE_URL", "CODEX_BASE_URL",
             "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"}


def clean_environment(source):
    return {name: value for name, value in source.items() if not name.upper().startswith("SSH_")}


def matches_ssh_source(expected, environment):
    # Check the SSH server's current connection metadata without printing it.
    # This verifies only the current peer, not historical logs or other files.
    parts = environment.get("SSH_CONNECTION", "").split()
    if len(parts) != 4 or any("%" in item for item in (expected, parts[0], parts[2])):
        return False
    try:
        peer, server, target = map(ipaddress.ip_address, (parts[0], parts[2], expected))
        ports = [int(parts[1]), int(parts[3])]
        return peer == target and all(1 <= port <= 65535 for port in ports)
    except ValueError:
        return False


def risky_environment(environment):
    return sorted(name for name, value in environment.items() if value and
                  ((name.upper().endswith("_PROXY") and name.upper() != "NO_PROXY") or
                   name.upper() in OVERRIDES))


def address(value, version):
    parsed = ipaddress.ip_address(value)
    if parsed.version != version or getattr(parsed, "scope_id", None):
        raise ValueError("address family does not match")
    return parsed


def sample(url, version, environment):
    try:
        result = subprocess.run(["curl", "-q", "-" + str(version), "--fail", "--silent",
                                 "--show-error", "--connect-timeout", "4", "--max-time", "8",
                                 "--max-filesize", "256", "--", url], env=environment,
                                capture_output=True, timeout=10, check=True)
        return address(result.stdout.decode("ascii").strip(), version)
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return None


def samples(environment):
    # Two independent services, twice each. No local-machine address is queried.
    jobs = [(version, url) for version, urls in SERVICES.items() for url in urls for _ in range(2)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        values = list(pool.map(lambda job: sample(job[1], job[0], environment), jobs))
    return {version: [value for (v, _), value in zip(jobs, values) if v == version] for version in (4, 6)}


def route_checks(environment, hosts=HOSTS):
    # Resolve in a bounded child so a stuck resolver cannot hang the terminal.
    script = ("import socket,json\nout={}\nfor h in " + repr(hosts) + ":\n"
              " try:\n  out[h]=list({a[4][0] for a in socket.getaddrinfo(h,443,0,socket.SOCK_STREAM)})\n"
              " except OSError:\n  out[h]=[]\nprint(json.dumps(out))\n")
    try:
        result = subprocess.run([sys.executable, "-I", "-c", script], env=environment,
                                capture_output=True, timeout=10, check=True)
        resolved = json.loads(result.stdout)
        if not isinstance(resolved, dict):
            raise ValueError("invalid DNS result")
        routes = {4: [], 6: []}
        for host in hosts:
            addresses = resolved.get(host, [])
            if not isinstance(addresses, list) or not addresses:
                return {4: "unknown", 6: "unknown"}
            for version in (4, 6):
                matches = [address(item, version) for item in addresses
                           if ipaddress.ip_address(item).version == version]
                if not matches:
                    routes[version].append("no_dns_address")
                    continue
                found = False
                # DNS can return many addresses; limit work but never call the
                # unchecked remainder unreachable.
                unknown = len(matches) > 8
                for item in matches[:8]:
                    route = subprocess.run(["ip", "-" + str(version), "route", "get", str(item)],
                                           env=environment, capture_output=True, timeout=3)
                    if route.returncode == 0:
                        found = True
                        break
                    if b"network is unreachable" not in route.stderr.lower() and b"no route to host" not in route.stderr.lower():
                        unknown = True
                routes[version].append("found" if found else "unknown" if unknown else "unreachable")
        default6 = subprocess.run(["ip", "-6", "route", "show", "default"], env=environment,
                                  capture_output=True, timeout=3, check=True)
        v4 = "found" if all(item == "found" for item in routes[4]) else "unknown"
        v6 = ("found" if "found" in routes[6] or default6.stdout.strip() else
              "unknown" if "unknown" in routes[6] else "no_route_observed")
        return {4: v4, 6: v6}
    except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.SubprocessError):
        return {4: "unknown", 6: "unknown"}


def preflight(expected4, expected6, environment, provider="codex", *, service_hosts=None):
    risky = risky_environment(environment)
    if risky:
        print("隐私检查未通过：发现代理或服务地址覆盖变量：" + ", ".join(risky), flush=True)
        return False
    observations = samples(environment)
    routes = (route_checks(environment, service_hosts) if service_hosts is not None else
              route_checks(environment, CLAUDE_SUBSCRIPTION_HOSTS) if provider == "claude-subscription" else
              route_checks(environment, CLAUDE_HOSTS) if provider == "claude" else route_checks(environment))
    v4 = observations[4]
    ok4 = len(v4) == 4 and all(item == expected4 for item in v4)
    print("IPv4 出口：" + ("4/4 与预期一致" if ok4 else "采样不完整或与预期不符"), flush=True)
    print("服务域名 IPv4 系统路由：" + routes[4], flush=True)
    observed6 = any(item is not None for item in observations[6])
    need6 = expected6 is not None or observed6 or routes[6] != "no_route_observed"
    ok6 = (routes[6] == "found" and expected6 is not None and
           len(observations[6]) == 4 and all(item == expected6 for item in observations[6])) if need6 else True
    print("服务域名 IPv6 系统路由：" + routes[6], flush=True)
    print("IPv6：" + ("4/4 与预期一致" if need6 and ok6 else
                       "路由或预期地址检查未通过" if need6 else "未观察到可用路由或出口；并非禁用证明"), flush=True)
    print("检查仅覆盖指定服务、环境变量和系统路由，不能证明模型程序的实际网络路径。", flush=True)
    return ok4 and routes[4] == "found" and ok6


def main(argv=None):
    parser = argparse.ArgumentParser(description="Remote Codex egress privacy check")
    parser.add_argument("--expected-ipv4", required=True)
    parser.add_argument("--expected-ipv6")
    parser.add_argument("--expected-ssh-source")
    parser.add_argument("--isolation-code")
    parser.add_argument("--isolation-workspace")
    parser.add_argument("--workflow-code")
    parser.add_argument("--workflow-task")
    parser.add_argument("--provider", choices=("codex", "claude", "claude-subscription"), default="codex")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        expected4 = address(args.expected_ipv4, 4)
        expected6 = address(args.expected_ipv6, 6) if args.expected_ipv6 else None
    except ValueError:
        print("预期出口地址无效。", file=sys.stderr)
        return 2
    if (args.isolation_code is None) != (args.isolation_workspace is None) or (args.isolation_code is not None and len(args.isolation_code) > 12288):
        print("隔离参数无效；未启动模型程序。", file=sys.stderr)
        return 2
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if ((args.workflow_code is None) != (args.workflow_task is None) or
            (args.workflow_code is not None and (args.provider != "claude" or not args.isolation_code or
             len(args.workflow_code) > 12288 or command[:4] != ["claude", "-p", "--dsh-encrypted-credentials", "--dsh-api-chat-stdin"]))):
        return 2
    if not command:
        command = ["codex"]
    expected_program = "claude" if args.provider.startswith("claude") else "codex"
    subscription = command[1:4] == ["-p", "--chat-auth", "subscription"]
    if not args.check_only and ((expected_program == "claude" and args.isolation_code is None) or
                                (args.isolation_code is not None and os.path.basename(command[0]) != expected_program) or
                                (args.provider == "claude-subscription") != subscription or
                                (expected_program == "claude" and not subscription and "--chat-auth" in command[1:])):
        print("模型后端与隔离配置不匹配；未启动。", file=sys.stderr)
        return 2
    if args.expected_ssh_source is not None and not matches_ssh_source(args.expected_ssh_source, os.environ):
        print("SSH 来源无法确认或与预期中继不符，未启动模型程序。", file=sys.stderr)
        return 1
    environment = clean_environment(os.environ)
    if not preflight(expected4, expected6, environment, args.provider):
        print("未启动模型程序：请检查代理、路由和预期出口。", file=sys.stderr)
        return 1
    if args.check_only:
        return 0
    program = shutil.which(command[0], path=environment.get("PATH"))
    if not program and command[0] in ("codex", "claude"):
        # Non-interactive SSH commonly omits the user's local bin directory.
        candidate = os.path.join(environment.get("HOME", ""), ".local", "bin", command[0])
        if os.path.isabs(candidate) and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            program = candidate
    if not program:
        print("找不到远端程序。", file=sys.stderr)
        return 2
    if args.isolation_code is not None:
        try:
            compressed = base64.b64decode(args.isolation_code, validate=True)
            decoder = zlib.decompressobj()
            source = decoder.decompress(compressed, 32769)
            if len(source) > 32768 or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise ValueError("invalid isolation payload")
            scope = {"__name__": "remote_codex_isolation"}
            exec(compile(source, "<remote-codex-isolation>", "exec"), scope)
            if args.workflow_code is not None:
                decoder = zlib.decompressobj()
                module = decoder.decompress(base64.b64decode(args.workflow_code, validate=True), 18001)
                if len(module) > 18000 or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                    raise ValueError("invalid workflow helper")
                workflow = {"__name__": "remote_workflow_files"}
                exec(compile(module, "<remote-workflow-files>", "exec"), workflow)
                return workflow["run_api"](scope, program, command, args.isolation_workspace, environment, args.workflow_task)
            return scope["run"](program, command, args.isolation_workspace, environment)
        except (KeyError, ValueError, UnicodeError, OSError, zlib.error, SyntaxError):
            print("隔离环境无法建立；未启动模型程序。", file=sys.stderr)
            return 2
    try:
        os.execve(program, command, environment)
    except OSError:
        print("无法启动远端程序。", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
