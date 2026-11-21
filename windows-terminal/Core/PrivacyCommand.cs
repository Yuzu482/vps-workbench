using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace RemoteSsh;

public sealed record PrivacyOptions(string ExpectedIpv4, string? ExpectedIpv6, int? SocksPort = null, string? ExpectedSshSource = null)
{
    public PrivacyOptions Validated()
    {
        static string Parse(string value, AddressFamily family)
        {
            if (value.Contains('%') || !IPAddress.TryParse(value, out var ip) || ip.AddressFamily != family)
                throw new ArgumentException("请输入有效的预期 IPv4 / IPv6 出口地址。");
            return ip.ToString();
        }
        if ((SocksPort is null) != string.IsNullOrWhiteSpace(ExpectedSshSource) || SocksPort is < 1 or > 65535)
            throw new ArgumentException("中继模式需要有效的 SOCKS5 端口和预期 SSH 来源地址。");
        string? source = null;
        if (SocksPort is not null)
        {
            if (ExpectedSshSource!.Contains('%') || !IPAddress.TryParse(ExpectedSshSource, out var ip))
                throw new ArgumentException("请输入有效的预期中继出口地址。");
            source = ip.ToString();
        }
        return new(Parse(ExpectedIpv4, AddressFamily.InterNetwork),
            string.IsNullOrWhiteSpace(ExpectedIpv6) ? null : Parse(ExpectedIpv6, AddressFamily.InterNetworkV6), SocksPort, source);
    }
}

public static class PrivacyCommand
{
    private static byte[] ReadHelper(string directory, string name = "RemoteCodexPrivacy.py")
    {
        var bytes = File.ReadAllBytes(Path.Combine(directory, name));
        int limit = name == "RemoteCodexIsolate.py" ? 32768 : 18000;
        if (bytes.Length == 0 || bytes.Length > limit) throw new ArgumentException("隐私检查脚本大小无效。");
        // Keep the compressed remote command within its argument limit on Windows checkouts.
        return Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("\r\n", "\n", StringComparison.Ordinal));
    }

    public static ProcessStartInfo BuildSsh(Connection connection, PrivacyOptions options, string directory, bool checkFiles = true)
    {
        var safe = options.Validated();
        string encoded = Convert.ToBase64String(ReadHelper(directory));
        var relay = safe.SocksPort is int port ? new SshCommand.SocksRelay(port, Path.Combine(directory, "RemoteSsh.Proxy.exe")) : null;
        var start = SshCommand.Build(connection, checkFiles, relay);
        // The only shell interpolations are base64 and parsed IP literals.
        string remote = $"python3 -B -c 'import base64;exec(base64.b64decode(\"{encoded}\"))' --expected-ipv4 {safe.ExpectedIpv4}";
        if (safe.ExpectedIpv6 is not null) remote += $" --expected-ipv6 {safe.ExpectedIpv6}";
        if (safe.ExpectedSshSource is not null) remote += $" --expected-ssh-source {safe.ExpectedSshSource}";
        start.ArgumentList.Add(remote);
        return start;
    }

    public static string[] WrapManaged(string[] command, PrivacyOptions options, string directory, string? isolationWorkspace = null, string provider = "codex", bool nativeProfile = false, Guid? workflowTask = null)
    {
        if (command.Length == 0 || string.IsNullOrEmpty(command[0])) throw new ArgumentException("请填写远端程序。");
        var safe = options.Validated();
        if (provider is not ("codex" or "claude" or "claude-subscription") || (provider != "codex" && isolationWorkspace is null))
            throw new ArgumentException("模型后端或隔离配置无效。");
        if (nativeProfile && (isolationWorkspace is null || provider == "claude"))
            throw new ArgumentException("原生会话需要隔离环境和原生登录。");
        if (safe.SocksPort is not null) throw new ArgumentException("托管任务暂不支持 SSH 来源中继。");
        using var output = new MemoryStream();
        using (var stream = new ZLibStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            stream.Write(ReadHelper(directory));
        string encoded = Convert.ToBase64String(output.ToArray());
        string script = $"import base64,zlib;exec(zlib.decompress(base64.b64decode('{encoded}')))";
        // The full request stays bounded at 16 KiB; reserve 8 KiB
        // per argument for the compressed helper and future maintenance.
        if (script.Length > 8192) throw new ArgumentException("隐私检查脚本过大，无法作为任务参数发送。");
        var result = new List<string> { "python3", "-B", "-c", script, "--expected-ipv4", safe.ExpectedIpv4 };
        if (provider != "codex") result.AddRange(["--provider", provider]);
        if (workflowTask is Guid task)
        {
            if (provider != "claude" || isolationWorkspace is null || task == Guid.Empty || nativeProfile)
                throw new ArgumentException("工作流 API 隔离参数无效。");
            using var workflowOutput = new MemoryStream();
            using (var compressor = new ZLibStream(workflowOutput, CompressionLevel.SmallestSize, leaveOpen: true))
                compressor.Write(ReadHelper(directory, "RemoteWorkflowFiles.py"));
            result.AddRange(["--workflow-code", Convert.ToBase64String(workflowOutput.ToArray()), "--workflow-task", task.ToString("D")]);
        }
        if (safe.ExpectedIpv6 is not null) result.AddRange(["--expected-ipv6", safe.ExpectedIpv6]);
        if (isolationWorkspace is not null)
        {
            ManagedTask.ValidateRemoteDirectory(isolationWorkspace);
            byte[] isolationSource = ReadHelper(directory, "RemoteCodexIsolate.py");
            if (nativeProfile)
            {
                byte[] safety = ReadHelper(directory, "RemoteNativeSafety.py");
                byte[] native = ReadHelper(directory, "RemoteNativeSession.py");
                using var joined = new MemoryStream(); joined.Write(isolationSource); joined.WriteByte((byte)'\n'); joined.Write(safety); joined.WriteByte((byte)'\n'); joined.Write(native);
                isolationSource = joined.ToArray();
                if (isolationSource.Length > 32768) throw new ArgumentException("隔离程序大小无效。");
            }
            else if (provider == "claude-subscription")
            {
                byte[] shared = ReadHelper(directory, "RemoteClaudeShared.py");
                using var joined = new MemoryStream(); joined.Write(shared); joined.WriteByte((byte)'\n'); joined.Write(isolationSource);
                isolationSource = joined.ToArray();
                if (isolationSource.Length > 32768) throw new ArgumentException("隔离程序大小无效。");
            }
            using var isolationOutput = new MemoryStream();
            using (var stream = new ZLibStream(isolationOutput, CompressionLevel.SmallestSize, leaveOpen: true))
                stream.Write(isolationSource);
            string isolation = Convert.ToBase64String(isolationOutput.ToArray());
            if (isolation.Length > 12288) throw new ArgumentException("隔离程序过大，无法作为任务参数发送。");
            result.AddRange(["--isolation-code", isolation, "--isolation-workspace", isolationWorkspace]);
        }
        result.Add("--"); result.AddRange(command);
        return result.ToArray();
    }

    public static bool IsDirectCodex(string executable) =>
        executable.Replace('\\', '/').Split('/').Last().Equals("codex", StringComparison.OrdinalIgnoreCase);

    // This must only be used with the separately established outer sandbox.
    // Do not silently replace an explicit inner policy or layered configuration.
    public static string[] UseOuterSandboxOnly(string[] command)
    {
        if (command.Length < 2 || !IsDirectCodex(command[0]) || command[1] != "exec")
            throw new ArgumentException("仅外层隔离需要非交互 codex exec。");
        if (command.Skip(2).Any(arg => arg is "--full-auto" or "--approve-for-me" or "--yolo" or
                "--dangerously-bypass-approvals-and-sandbox" ||
            arg is "--sandbox" or "--config" or "--profile" ||
            arg.StartsWith("--sandbox=", StringComparison.Ordinal) ||
            arg.StartsWith("--config=", StringComparison.Ordinal) ||
            arg.StartsWith("--profile=", StringComparison.Ordinal) ||
            arg.StartsWith("-s", StringComparison.Ordinal) ||
            arg.StartsWith("-c", StringComparison.Ordinal) ||
            arg.StartsWith("-p", StringComparison.Ordinal)))
            throw new ArgumentException("仅外层隔离不能与沙箱、自动批准或配置覆盖参数同时使用。");
        return command.Take(2).Concat(["--sandbox", "danger-full-access"]).Concat(command.Skip(2)).ToArray();
    }
}
