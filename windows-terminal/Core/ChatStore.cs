using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace RemoteSsh;

public sealed class ChatTurnRecord
{
    public Guid TaskId { get; set; }
    public string Receipt { get; set; } = "";
    public string Prompt { get; set; } = "";
    public List<string> Attachments { get; set; } = [];
    public Guid? ThreadId { get; set; }
}

public sealed class ChatConversationRecord
{
    public int Version { get; set; } = 1;
    public Guid Id { get; set; }
    public string Provider { get; set; } = "codex";
    // Missing in version-1 records: preserve the original API-key behavior.
    public string ClaudeAuthMode { get; set; } = "api_key";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Guid? ClaudeAccountSourceId { get; set; }
    // Missing in older records: keep their original per-conversation profiles.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool NativeProfile { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool MemoryIsolation { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool MemoryExtraction { get; set; }
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public string User { get; set; } = "";
    public string Workspace { get; set; } = "";
    public string ExpectedIpv4 { get; set; } = "";
    public bool OuterOnly { get; set; }
    public List<ChatTurnRecord> Turns { get; set; } = [];
}

public static class ChatStore
{
    const int MaxBytes = 1024 * 1024;
    static readonly JsonSerializerOptions Json = new() { WriteIndented = false, MaxDepth = 12, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };

    static void RejectDuplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var field in element.EnumerateObject())
            { if (!seen.Add(field.Name)) throw new ArgumentException("会话字段重复。"); RejectDuplicates(field.Value); }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray()) RejectDuplicates(item);
    }

    public static string PathFor(string directory, Guid id) => Path.Combine(directory, $"conversation-{id:D}.json");

    public static FileStream Lock(string directory, Guid id)
    {
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, $"conversation-{id:D}.lock");
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("会话锁无效。");
        return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }

    public static void Validate(ChatConversationRecord record, Connection connection, string directory)
    {
        if (record.Version != 1 || record.Id == Guid.Empty || record.Provider is not ("codex" or "claude" or "claude-sdk" or "antigravity") ||
            !string.Equals(record.Host, connection.Host, StringComparison.OrdinalIgnoreCase) || record.Port != connection.Port ||
            !string.Equals(record.User, connection.User, StringComparison.Ordinal) || record.Turns is null || record.Turns.Count > 100 ||
            record.ClaudeAuthMode is not ("api_key" or "subscription") ||
            (record.ClaudeAuthMode == "subscription" && record.Provider is not ("claude" or "claude-sdk")) ||
            (record.Provider == "claude-sdk" && (record.ClaudeAuthMode != "subscription" || !record.NativeProfile)) ||
            (record.ClaudeAccountSourceId is Guid source && (source == Guid.Empty || source == record.Id || record.Provider != "claude" || record.ClaudeAuthMode != "subscription")) ||
            (record.NativeProfile && (record.ClaudeAccountSourceId is not null || (record.Provider == "claude" && record.ClaudeAuthMode != "subscription"))) ||
            (record.MemoryExtraction && (record.Provider != "codex" || record.MemoryIsolation || record.Turns.Count != 1)) ||
            (record.Turns.Count == 0 && (record.Provider != "claude" || record.ClaudeAuthMode != "subscription")))
            throw new ArgumentException("会话与当前连接不匹配或格式无效。");
        ManagedTask.ValidateRemoteDirectory(record.Workspace);
        if (string.IsNullOrWhiteSpace(record.Workspace)) throw new ArgumentException("会话项目目录无效。");
        _ = new PrivacyOptions(record.ExpectedIpv4, null).Validated();
        var ids = new HashSet<Guid>();
        foreach (var turn in record.Turns)
        {
            if (turn is null || turn.TaskId == Guid.Empty || !ids.Add(turn.TaskId) ||
                turn.Receipt is null || !Regex.IsMatch(turn.Receipt, @"\Atask-[A-Za-z0-9-]+\.json\z", RegexOptions.CultureInvariant) ||
                turn.Prompt is null || turn.Prompt.Length is 0 or > 8192 || turn.Prompt.Contains('\0') ||
                turn.Attachments is null || turn.Attachments.Count > 4 || turn.Attachments.Any(x => x is null || x.Length > 160 || x.Any(char.IsControl)) || turn.ThreadId == Guid.Empty)
                throw new ArgumentException("会话消息格式无效。");
            var receipt = ManagedTask.ReadReceipt(connection, Path.Combine(directory, turn.Receipt));
            if (receipt.TaskId != turn.TaskId || receipt.StateDirectory is not null)
                throw new ArgumentException("会话回执不匹配。");
        }
    }

    public static ChatConversationRecord Read(string path, Connection connection, string directory)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length > MaxBytes || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new ArgumentException("会话文件无效。");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length > MaxBytes) throw new ArgumentException("会话文件过大。");
        int expected = checked((int)stream.Length), count = 0, part; byte[] bytes = new byte[expected + 1];
        while (count < bytes.Length && (part = stream.Read(bytes, count, bytes.Length - count)) > 0) count += part;
        if (count != expected) throw new IOException("读取时会话文件发生变化。");
        using (var document = JsonDocument.Parse(bytes.AsMemory(0, count))) RejectDuplicates(document.RootElement);
        var record = JsonSerializer.Deserialize<ChatConversationRecord>(bytes.AsSpan(0, count), Json) ?? throw new ArgumentException("会话文件无效。");
        if (!string.Equals(Path.GetFullPath(path), Path.GetFullPath(PathFor(directory, record.Id)), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("会话文件路径不匹配。");
        Validate(record, connection, directory);
        return record;
    }

    public static void Save(ChatConversationRecord record, Connection connection, string directory)
    {
        Validate(record, connection, directory);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(record, Json);
        if (bytes.Length > MaxBytes) throw new ArgumentException("会话记录已达到大小限制。");
        string target = PathFor(directory, record.Id), temp = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { file.Write(bytes); file.Flush(flushToDisk: true); }
            if (File.Exists(target) && (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("会话文件无效。");
            File.Move(temp, target, overwrite: true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
