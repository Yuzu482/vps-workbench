using System.Globalization;
using System.Text.Json;
using System.Text.Encodings.Web;

namespace RemoteSsh;

// Claude uses its own native session and output format. Authentication is
// provided on the remote host; this adapter never accepts credentials locally.
public static class ClaudeChat
{
    public const int MaxDshApiOutputTokens = 8192;
    public static IReadOnlyList<string> ModelAliases { get; } =
        Array.AsReadOnly<string>(["sonnet", "opus", "haiku"]);

    public static ManagedTaskRequest BuildTurnRequest(string prompt, string workspace, PrivacyOptions options,
        bool outerOnly, string appDirectory, Guid conversation, Guid turn, Guid? thread,
        IReadOnlyList<ChatAttachment> attachments, string authMode = "api_key", Guid? accountSource = null, bool nativeProfile = false) =>
        BuildRequest(prompt, workspace, options, outerOnly, appDirectory, conversation, turn, thread, attachments,
            authMode, accountSource, nativeProfile, model: null, encryptedCredentials: false);

    public static ManagedTaskRequest BuildDshApiTurnRequest(string prompt, string workspace, PrivacyOptions options,
        string appDirectory, Guid conversation, Guid turn, Guid? thread, string? model) =>
        BuildRequest(prompt, workspace, options, outerOnly: false, appDirectory, conversation, turn, thread, [],
            authMode: "api_key", accountSource: null, nativeProfile: false, model, encryptedCredentials: true);

    public static byte[] EncodeDshApiTurnRequest(string prompt, string workspace, PrivacyOptions options,
        string appDirectory, Guid conversation, Guid turn, Guid? thread, string? model, string? memory, bool memoryIsolation,
        int? maxOutputTokens = null, string? reasoningEffort = null, JsonElement? workflowFiles = null)
    {
        var request = BuildRequest(prompt, workspace, options, outerOnly: false, appDirectory, conversation, turn, thread, [],
            authMode: "api_key", accountSource: null, nativeProfile: false, model, encryptedCredentials: true,
            promptFromStdin: memory is not null || workflowFiles.HasValue, memoryIsolation, maxOutputTokens, reasoningEffort,
            workflow: workflowFiles.HasValue);
        if (memory is null && workflowFiles is null) return ManagedTask.EncodeRequest(request);
        var json = new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        var message = new { prompt, memory };
        // The remote stream frame adds the fixed user-message envelope to the same two strings.
        if (JsonSerializer.SerializeToUtf8Bytes(message, json).Length > 65536 - 128)
            throw new ArgumentException("Claude API 项目记忆过大。");
        var chatInput = workflowFiles.HasValue ? JsonSerializer.SerializeToElement(new { prompt, memory, workflowFiles }, json)
            : JsonSerializer.SerializeToElement(message, json);
        return JsonSerializer.SerializeToUtf8Bytes(new { command = request.Command, cwd = workspace, capture = true, chatInput }, json);
    }

    private static ManagedTaskRequest BuildRequest(string prompt, string workspace, PrivacyOptions options,
        bool outerOnly, string appDirectory, Guid conversation, Guid turn, Guid? thread,
        IReadOnlyList<ChatAttachment> attachments, string authMode, Guid? accountSource, bool nativeProfile,
        string? model, bool encryptedCredentials, bool promptFromStdin = false, bool memoryIsolation = false,
        int? maxOutputTokens = null, string? reasoningEffort = null, bool workflow = false)
    {
        if (string.IsNullOrWhiteSpace(prompt) || prompt.Length > 8192 || prompt.Contains('\0'))
            throw new ArgumentException("请输入不超过 8192 字符的消息。");
        ManagedTask.ValidateRemoteDirectory(workspace);
        if (string.IsNullOrWhiteSpace(workspace)) throw new ArgumentException("请填写远端项目目录。");
        if (attachments.Count > 4) throw new ArgumentException("每轮最多选择 4 个附件。");
        if (authMode is not ("api_key" or "subscription")) throw new ArgumentException("Claude 认证方式无效。");
        if (accountSource is not null && (authMode != "subscription" || accountSource == Guid.Empty || accountSource == conversation))
            throw new ArgumentException("Claude 账号来源无效。");
        if (nativeProfile && (authMode != "subscription" || accountSource is not null))
            throw new ArgumentException("原生账号配置无效。");
        if (model is not null && !ModelAliases.Contains(model))
            throw new ArgumentException("请选择 Claude Code 支持的模型别名。");
        if (maxOutputTokens is < 1024 or > MaxDshApiOutputTokens || reasoningEffort is not (null or "low" or "medium" or "high"))
            throw new ArgumentException("高级模型设置无效。");
        string turnPath = turn.ToString("D");
        if (attachments.Count != 0)
            prompt += "\n\n本轮附加文件（只读）：\n" + string.Join("\n", attachments.Select(a => "- /attachments/" + turnPath + "/" + a.RemoteName));
        var command = new List<string> { "claude", "-p" };
        if (encryptedCredentials) command.Add("--dsh-encrypted-credentials");
        if (promptFromStdin) command.Add("--dsh-api-chat-stdin");
        if (model is not null) command.AddRange(["--model", model]);
        if (reasoningEffort is not null) command.AddRange(["--effort", reasoningEffort]);
        if (memoryIsolation || maxOutputTokens.HasValue)
        {
            var settings = new Dictionary<string, object>();
            var environment = new Dictionary<string, string>();
            if (memoryIsolation)
            {
                settings.Add("autoMemoryEnabled", false);
                environment.Add("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
            }
            if (maxOutputTokens is int limit)
                environment.Add("CLAUDE_CODE_MAX_OUTPUT_TOKENS", limit.ToString(CultureInfo.InvariantCulture));
            settings.Add("env", environment);
            command.AddRange(["--settings", JsonSerializer.Serialize(settings)]);
        }
        if (authMode == "subscription") command.AddRange(["--chat-auth", "subscription"]);
        if (accountSource is Guid source) command.AddRange(["--chat-auth-source", source.ToString("D")]);
        command.AddRange(["--chat-session", conversation.ToString("D")]);
        if (attachments.Count != 0) command.AddRange(["--chat-turn", turnPath]);
        if (!promptFromStdin) command.AddRange(["--chat-prompt", prompt]);
        foreach (var image in attachments.Where(a => a.Image)) command.AddRange(["--chat-image", "/attachments/" + turnPath + "/" + image.RemoteName]);
        command.AddRange(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--strict-mcp-config", "--permission-prompts", "none"]);
        if (outerOnly) command.AddRange(["--tools", "default", "--dangerously-skip-permissions"]);
        else if (workflow)
            command.AddRange(["--tools", "Read,Glob,Grep,Write,Edit", "--permission-mode", "dontAsk", "--allowedTools",
                "Read", "Glob", "Grep", "Write(//output/**)", "Edit(//output/**)", "--add-dir", "/output"]);
        else command.AddRange(["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk"]);
        command.AddRange(["--add-dir", "/attachments"]);
        command.AddRange(thread is null ? ["--session-id", conversation.ToString("D")] : ["--resume", thread.Value.ToString("D")]);
        var request = new ManagedTaskRequest(PrivacyCommand.WrapManaged(command.ToArray(), options, appDirectory, workspace, authMode == "subscription" ? "claude-subscription" : "claude", nativeProfile, workflow ? turn : null), workspace, true);
        _ = ManagedTask.EncodeRequest(request);
        return request;
    }

    static string Field(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    static string Clip(string value, int limit = 8000) => value.Length <= limit ? value : value[..limit] + "\n…（显示内容已截断）";

    public static Guid? CompletedThread(string output, bool finished, int? exitCode, bool truncated, Guid? expected = null)
    {
        if (!finished || exitCode != 0 || truncated || !output.EndsWith('\n')) return null;
        Guid? session = null, result = null; int starts = 0, completions = 0;
        foreach (string line in output.Split('\n'))
        {
            if (!line.StartsWith('{')) continue;
            try
            {
                using var doc = JsonDocument.Parse(line); var root = doc.RootElement;
                if (Field(root, "type") == "system" && Field(root, "subtype") == "init")
                { if (!Guid.TryParse(Field(root, "session_id"), out var id)) return null; session = id; starts++; }
                if (Field(root, "type") == "result")
                {
                    if (Field(root, "subtype") != "success" || !root.TryGetProperty("is_error", out var error) || error.ValueKind != JsonValueKind.False ||
                        !Guid.TryParse(Field(root, "session_id"), out var id)) return null;
                    result = id; completions++;
                }
            }
            catch (JsonException) { return null; }
        }
        return starts == 1 && completions == 1 && session is not null && session == result && (expected is null || expected == session) ? session : null;
    }

    public static IReadOnlyList<ChatItem> ParseOutput(string output, bool complete)
    {
        var items = new List<ChatItem>(); string[] lines = output.Split('\n');
        int count = complete || output.EndsWith('\n') ? lines.Length : lines.Length - 1;
        for (int i = 0; i < count && items.Count < 1000; i++)
        {
            string line = lines[i].TrimEnd('\r');
            if (line.StartsWith("IPv4 出口：", StringComparison.Ordinal) || line.StartsWith("IPv6：", StringComparison.Ordinal) ||
                line.StartsWith("服务域名", StringComparison.Ordinal) || line.StartsWith("未启动", StringComparison.Ordinal))
            { items.Add(new(ChatItemKind.Notice, "连接检查", Clip(line, 500))); continue; }
            if (!line.StartsWith('{')) continue;
            try
            {
                using var doc = JsonDocument.Parse(line); var root = doc.RootElement; string type = Field(root, "type");
                if (type == "result")
                {
                    bool failed = !root.TryGetProperty("is_error", out var error) || error.ValueKind != JsonValueKind.False;
                    string text = Field(root, "result");
                    if (text.Length > 0) items.Add(new(failed ? ChatItemKind.Error : ChatItemKind.Assistant, failed ? "任务提示" : "Claude", Clip(text)));
                }
                else if (type == "assistant" && root.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.Object &&
                         message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                {
                    if (root.TryGetProperty("parent_tool_use_id", out var parent) && parent.ValueKind is not JsonValueKind.Null) continue;
                    foreach (var part in content.EnumerateArray())
                    {
                        if (Field(part, "type") != "tool_use") continue;
                        string name = Field(part, "name");
                        string details = part.TryGetProperty("input", out var input) ? input.GetRawText() : "";
                        bool file = name is "Write" or "Edit" or "NotebookEdit";
                        items.Add(new(file ? ChatItemKind.FileChange : ChatItemKind.Command, "工具 · " + Clip(name, 80), Clip(details)));
                    }
                }
            }
            catch (JsonException) { }
        }
        return items;
    }
}

public static class ChatBackends
{
    public static ManagedTaskRequest Build(string provider, string prompt, string workspace, PrivacyOptions options, bool outerOnly,
        string directory, Guid conversation, Guid turn, Guid? thread, IReadOnlyList<ChatAttachment> attachments, string claudeAuthMode = "api_key", Guid? claudeAccountSource = null, bool nativeProfile = false) => provider switch
    {
        "codex" when claudeAuthMode == "api_key" && claudeAccountSource is null => CodexChat.BuildTurnRequest(prompt, workspace, options, outerOnly, directory, conversation, turn, thread, attachments, nativeProfile),
        "claude" => ClaudeChat.BuildTurnRequest(prompt, workspace, options, outerOnly, directory, conversation, turn, thread, attachments, claudeAuthMode, claudeAccountSource, nativeProfile),
        _ => throw new ArgumentException("未知模型后端。")
    };
    public static Guid? Completed(string provider, string output, bool finished, int? exitCode, bool truncated, Guid? expected = null) => provider switch
    {
        "codex" => CodexChat.CompletedThread(output, finished, exitCode, truncated, expected),
        "claude" => ClaudeChat.CompletedThread(output, finished, exitCode, truncated, expected),
        _ => null
    };
    public static IReadOnlyList<ChatItem> Parse(string provider, string output, bool complete) => provider switch
    {
        "claude" => ClaudeChat.ParseOutput(output, complete),
        _ => CodexChat.ParseOutput(output, complete)
    };
}
