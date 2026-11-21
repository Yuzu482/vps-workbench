using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;

namespace RemoteSsh;

public static class ClaudeSubscription
{
    public static Guid? ValidateSource(ChatConversationRecord conversation, Connection connection, string directory)
    {
        if (conversation.ClaudeAccountSourceId is not Guid source) return null;
        var original = ChatStore.Read(ChatStore.PathFor(directory, source), connection, directory);
        if (original.Id != source || original.Provider != "claude" || original.ClaudeAuthMode != "subscription" || original.ClaudeAccountSourceId is not null)
            throw new ArgumentException("找不到匹配当前连接的独立订阅账号来源。");
        return source;
    }

    public static ProcessStartInfo BuildStatus(Connection connection, Guid session, string appDirectory, Guid? source = null, bool nativeProfile = false)
    {
        if (session == Guid.Empty || source == Guid.Empty || source == session || connection.Authentication != Authentication.Key)
            throw new ArgumentException("订阅状态检查需要会话和 SSH 私钥认证。");
        if (nativeProfile && source is not null) throw new ArgumentException("原生账号不能指定旧会话来源。");
        byte[] auth = File.ReadAllBytes(Path.Combine(appDirectory, "RemoteClaudeAuth.py"));
        byte[] shared = File.ReadAllBytes(Path.Combine(appDirectory, "RemoteClaudeShared.py"));
        if (auth.Length is 0 or > 12000 || shared.Length is 0 or > 10000) throw new ArgumentException("订阅状态检查程序大小无效。");
        using var combined = new MemoryStream(); combined.Write(shared); combined.WriteByte((byte)'\n');
        if (nativeProfile)
        {
            byte[] safety = File.ReadAllBytes(Path.Combine(appDirectory, "RemoteNativeSafety.py"));
            if (safety.Length is 0 or > 3000) throw new ArgumentException("原生目录检查程序大小无效。");
            combined.Write(safety); combined.WriteByte((byte)'\n');
        }
        combined.Write(auth);
        byte[] sourceBytes = combined.ToArray();
        if (sourceBytes.Length > 18000) throw new ArgumentException("订阅状态检查程序大小无效。");
        using var compressed = new MemoryStream();
        using (var z = new ZLibStream(compressed, CompressionLevel.SmallestSize, true)) z.Write(sourceBytes);
        string encoded = Convert.ToBase64String(compressed.ToArray());
        string command = $"python3 -B -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode(\"{encoded}\")))' --session {session:D}";
        if (source is not null) command += $" --source {source:D}";
        if (nativeProfile) command += " --native";
        var start = SshCommand.Build(connection);
        int tty = start.ArgumentList.IndexOf("-tt"), batch = start.ArgumentList.IndexOf("BatchMode=no");
        if (tty < 0 || batch < 0) throw new InvalidOperationException("SSH 配置无效。");
        start.ArgumentList[tty] = "-T"; start.ArgumentList[batch] = "BatchMode=yes";
        start.ArgumentList.Add(command);
        start.CreateNoWindow = true; start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.StandardOutputEncoding = new UTF8Encoding(false, false); start.StandardErrorEncoding = new UTF8Encoding(false, false);
        return start;
    }

    public static string Status(ManagedToolResult result, Guid session)
    {
        if (result.Uncertain || result.ExitCode != 0 || result.Output.Length > 512) return "unavailable";
        try
        {
            using var doc = JsonDocument.Parse(result.Output); var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
                !root.TryGetProperty("session", out var id) || id.ValueKind != JsonValueKind.String || id.GetString() != session.ToString("D") ||
                !root.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.String) return "unavailable";
            return status.GetString() is "ready" or "not_logged_in" or "cli_missing" or "cli_unsupported" or "busy" or "wrong_auth" or "wrong_profile" or "shared_profile_changed"
                ? status.GetString()! : "unavailable";
        }
        catch (JsonException) { return "unavailable"; }
    }

    public static string LoginCommand(Guid session, bool nativeProfile = false)
    {
        if (session == Guid.Empty) throw new ArgumentException("会话无效。");
        if (nativeProfile) return "env -i HOME=\"$HOME\" PATH=\"$PATH\" TERM=\"${TERM:-xterm}\" LANG=C.UTF-8 claude auth login";
        return $"r=\"$HOME/.remote-ssh-chat/{session:D}\"\n" +
            "c=$(command -v claude || printf '%s/.local/bin/claude' \"$HOME\")\n" +
            "env -i HOME=\"$r/native-home\" CLAUDE_CONFIG_DIR=\"$r/claude-home\" PATH=\"$PATH\" TERM=\"${TERM:-xterm}\" LANG=C.UTF-8 \"$c\" auth login";
    }
}
