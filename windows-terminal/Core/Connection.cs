using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace RemoteSsh;

public enum Authentication { Key, Password }

// Contains paths and connection settings only. Passwords and key contents never
// enter the manager, profile files, arguments, or application logs.
public sealed record Connection(string Host, int Port, string User,
    Authentication Authentication, string IdentityPath, string KnownHostsPath)
{
    public void Validate(bool checkFiles = true)
    {
        ValidateTarget(Host, Port);
        if (string.IsNullOrEmpty(User) || !Regex.IsMatch(User, @"\A[A-Za-z0-9_][A-Za-z0-9_.@\\-]{0,127}\z"))
            throw new ArgumentException("用户名仅支持英文字母、数字、下划线、点、@、反斜杠和短横线。");
        if (!Enum.IsDefined(Authentication)) throw new ArgumentException("认证方式无效。");
        if (Authentication == Authentication.Key) CheckPath(IdentityPath, "私钥", checkFiles);
        else if (!string.IsNullOrEmpty(IdentityPath)) throw new ArgumentException("密码模式不应指定私钥。");
        CheckPath(KnownHostsPath, "known_hosts", checkFiles);
    }

    public static void ValidateTarget(string host, int port)
    {
        if (string.IsNullOrEmpty(host) || host.Length > 253 ||
            !(IPAddress.TryParse(host, out _) || host.Split('.').All(label =>
                Regex.IsMatch(label, @"\A[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\z"))))
            throw new ArgumentException("请输入有效的主机名或 IP 地址。");
        if (port is < 1 or > 65535) throw new ArgumentException("端口范围为 1–65535。");
    }

    private static void CheckPath(string path, string label, bool checkFile)
    {
        // OpenSSH performs percent/tilde and environment expansion on option values.
        // Accept spaces and Unicode, but reject these expansion forms and syntax.
        if (string.IsNullOrWhiteSpace(path) || path.Length > 2048 ||
            !Regex.IsMatch(path, @"\A[A-Za-z]:[\\/]") || !Path.IsPathFullyQualified(path) ||
            path[3..].Contains(':') || path.Any(c => char.IsControl(c) || "\"%~*?<>|".Contains(c)) ||
            path.Contains("${", StringComparison.Ordinal) ||
            path.Split(['\\', '/']).Any(part => part is "." or ".."))
            throw new ArgumentException($"{label} 必须是完整的 Windows 文件路径，不支持通配符、变量或相对目录。");
        if (checkFile && !File.Exists(path)) throw new FileNotFoundException($"找不到 {label} 文件：{path}");
    }
}

public static class ConnectionCodec
{
    private static readonly JsonSerializerOptions Options = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter() }
    };
    public static string ToJson(Connection value) => JsonSerializer.Serialize(value, Options);
    public static Connection FromJson(string json)
    {
        if (json.Length > 16384) throw new ArgumentException("配置过大。");
        // Reject duplicate fields, including case variants; JSON profiles are a
        // closed format so different parsers cannot interpret them differently.
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new ArgumentException("配置必须是 JSON 对象。");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in document.RootElement.EnumerateObject())
            if (!names.Add(property.Name)) throw new ArgumentException("配置字段重复。");
        var result = JsonSerializer.Deserialize<Connection>(json, Options) ?? throw new ArgumentException("配置为空。");
        result.Validate(checkFiles: false);
        return result;
    }
    public static string Encode(Connection value)
    {
        value.Validate(checkFiles: false);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(ToJson(value))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
    public static Connection Decode(string token)
    {
        if (token.Length is 0 or > 22000 || !Regex.IsMatch(token, @"\A[A-Za-z0-9_-]+\z"))
            throw new ArgumentException("启动参数无效。");
        var encoded = token.Replace('-', '+').Replace('_', '/');
        encoded = encoded.PadRight((encoded.Length + 3) / 4 * 4, '=');
        return FromJson(new UTF8Encoding(false, true).GetString(Convert.FromBase64String(encoded)));
    }
}

public static class SshCommand
{
    public static string Executable => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "OpenSSH", "ssh.exe");

    public sealed record SocksRelay(int Port, string BridgePath);

    public static ProcessStartInfo Build(Connection connection, bool checkFiles = true, SocksRelay? relay = null)
    {
        connection.Validate(checkFiles);
        if (checkFiles && !File.Exists(Executable)) throw new FileNotFoundException("未找到 Windows 系统 OpenSSH 客户端。", Executable);
        string proxy = "ProxyCommand=none";
        if (relay is not null)
        {
            if (relay.Port is < 1 or > 65535 || connection.Host.Contains('%') || !Path.IsPathFullyQualified(relay.BridgePath) ||
                !Regex.IsMatch(relay.BridgePath, @"\A[A-Za-z]:[\\/][\p{L}\p{N}_. \\/-]+\z"))
                throw new ArgumentException("SOCKS 中继端口或程序路径无效。请使用不含特殊符号的程序目录。");
            if (checkFiles && !File.Exists(relay.BridgePath)) throw new FileNotFoundException("缺少 SOCKS 中继程序。", relay.BridgePath);
            // OpenSSH may execute ProxyCommand through a shell. Restrict every
            // interpolated value and quote the fixed executable path.
            proxy = $"ProxyCommand=\"{relay.BridgePath.Replace('\\', '/')}\" {relay.Port} {connection.Host} {connection.Port}";
        }
        var start = new ProcessStartInfo(Executable) { UseShellExecute = false };
        void Add(params string[] args) { foreach (string arg in args) start.ArgumentList.Add(arg); }
        void Option(string value) => Add("-o", value);
        Add("-F", "NUL");
        foreach (string option in new[] {
            proxy, "ProxyJump=none", "IdentityAgent=none", "IdentitiesOnly=yes", "IdentityFile=none",
            "StrictHostKeyChecking=yes", "GlobalKnownHostsFile=NUL", "UpdateHostKeys=no", "BatchMode=no",
            "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "PermitLocalCommand=no",
            "ControlMaster=no", "CanonicalizeHostname=no", "ConnectTimeout=15", "ConnectionAttempts=1",
            "ServerAliveInterval=30", "ServerAliveCountMax=3", "NumberOfPasswordPrompts=3" }) Option(option);
        Option("UserKnownHostsFile=\"" + connection.KnownHostsPath.Replace('\\', '/') + "\"");
        if (connection.Authentication == Authentication.Key)
        {
            Option("PreferredAuthentications=publickey"); Option("PasswordAuthentication=no");
            Option("KbdInteractiveAuthentication=no");
            Add("-i", connection.IdentityPath.Replace('\\', '/'));
        }
        else
        {
            Option("PubkeyAuthentication=no"); Option("PreferredAuthentications=password,keyboard-interactive");
            Option("PasswordAuthentication=yes"); Option("KbdInteractiveAuthentication=yes");
        }
        Add("-p", connection.Port.ToString(System.Globalization.CultureInfo.InvariantCulture), "-l", connection.User, "-tt", connection.Host);
        // Authentication prompts stay in the terminal; never start a GUI askpass helper.
        start.Environment["SSH_ASKPASS_REQUIRE"] = "never";
        return start;
    }
}
