using System.Text;
using System.Text.Json;

namespace RemoteSsh;

public enum ChatItemKind { Notice, Assistant, Command, FileChange, Error }
public sealed record ChatItem(ChatItemKind Kind, string Title, string Text);

public static class CodexChat
{
    // Legacy one-shot requests remain available for existing receipts.
    public static ManagedTaskRequest BuildRequest(string prompt, string workspace, PrivacyOptions options,
        bool outerOnly, string appDirectory)
    {
        if (string.IsNullOrWhiteSpace(prompt) || prompt.Length > 8192 || prompt.Contains('\0'))
            throw new ArgumentException("请输入不超过 8192 字符的任务内容。");
        ManagedTask.ValidateRemoteDirectory(workspace);
        if (string.IsNullOrWhiteSpace(workspace)) throw new ArgumentException("请填写远端项目目录。");
        var command = new List<string> { "codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check" };
        if (outerOnly) command = PrivacyCommand.UseOuterSandboxOnly(command.ToArray()).ToList();
        else command.AddRange(["--sandbox", "read-only"]);
        // A literal separator keeps prompts that begin with '-' out of CLI options.
        command.Add("--"); command.Add(prompt);
        var request = new ManagedTaskRequest(PrivacyCommand.WrapManaged(command.ToArray(), options, appDirectory, workspace), workspace, true);
        _ = ManagedTask.EncodeRequest(request); // Validate the complete bound before reserving a receipt.
        return request;
    }

    // A conversation uses one isolated home, while each turn retains a separate
    // durable task receipt. Resume only an explicitly observed native thread ID.
    public static ManagedTaskRequest BuildTurnRequest(string prompt, string workspace, PrivacyOptions options,
        bool outerOnly, string appDirectory, Guid conversation, Guid turn, Guid? thread,
        IReadOnlyList<ChatAttachment> attachments, bool nativeProfile = false)
    {
        if (string.IsNullOrWhiteSpace(prompt) || prompt.Length > 8192 || prompt.Contains('\0'))
            throw new ArgumentException("请输入不超过 8192 字符的消息。");
        ManagedTask.ValidateRemoteDirectory(workspace);
        if (string.IsNullOrWhiteSpace(workspace)) throw new ArgumentException("请填写远端项目目录。");
        if (attachments.Count > 4) throw new ArgumentException("每轮最多选择 4 个附件。");
        string turnPath = turn.ToString("D");
        var command = new List<string> { "codex", "exec", "--chat-session", conversation.ToString("D") };
        if (attachments.Count != 0) command.AddRange(["--chat-turn", turnPath]);
        if (outerOnly) command = PrivacyCommand.UseOuterSandboxOnly(command.ToArray()).ToList();
        else command.AddRange(["--sandbox", "read-only"]);
        if (thread is not null) command.Add("resume");
        command.AddRange(["--json", "--skip-git-repo-check", "--ignore-user-config"]);
        foreach (var item in attachments.Where(a => a.Image)) command.Add("--image=/attachments/" + turnPath + "/" + item.RemoteName);
        if (thread is not null) command.Add(thread.Value.ToString("D"));
        if (attachments.Count != 0)
            prompt += "\n\n本轮附加文件（只读）：\n" + string.Join("\n", attachments.Select(a => "- /attachments/" + turnPath + "/" + a.RemoteName));
        command.Add("--"); command.Add(prompt);
        var request = new ManagedTaskRequest(PrivacyCommand.WrapManaged(command.ToArray(), options, appDirectory, workspace, nativeProfile: nativeProfile), workspace, true);
        _ = ManagedTask.EncodeRequest(request);
        return request;
    }

    // A successful process alone is insufficient: require the native session
    // and an explicit completed turn before allowing the next submission.
    public static Guid? CompletedThread(string output, bool finished, int? exitCode, bool truncated, Guid? expected = null)
    {
        if (!finished || exitCode != 0 || truncated || !output.EndsWith('\n')) return null;
        Guid? thread = null; int started = 0, completed = 0;
        foreach (string line in output.Split('\n'))
        {
            if (!line.StartsWith('{')) continue;
            try
            {
                using var doc = JsonDocument.Parse(line); var root = doc.RootElement;
                string type = Field(root, "type");
                if (type == "thread.started")
                {
                    if (!Guid.TryParse(Field(root, "thread_id"), out Guid observed)) return null;
                    thread = observed; started++;
                }
                else if (type == "turn.completed") completed++;
                else if (type is "turn.failed" or "error") return null;
            }
            catch (JsonException) { return null; }
        }
        return started == 1 && completed == 1 && thread is not null && (expected is null || expected == thread) ? thread : null;
    }

    static string Field(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? "" : "";

    static string Clip(string text, int maximum = 8000) =>
        text.Length <= maximum ? text : text[..maximum] + "\n…（显示内容已截断）";

    // Parse complete JSONL snapshots as data, never as HTML or executable code.
    // Rebuilding from the snapshot makes repeated read-only polls idempotent.
    public static IReadOnlyList<ChatItem> ParseOutput(string output, bool complete)
    {
        var result = new List<ChatItem>();
        var positions = new Dictionary<string, int>(StringComparer.Ordinal);
        string[] lines = output.Split('\n');
        int count = complete || output.EndsWith('\n') ? lines.Length : lines.Length - 1;
        for (int i = 0; i < count && result.Count < 1000; i++)
        {
            string line = lines[i].TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(line)) continue;
            if (!line.StartsWith('{'))
            {
                if (line.StartsWith("IPv4 出口：", StringComparison.Ordinal) ||
                    line.StartsWith("IPv6：", StringComparison.Ordinal) ||
                    line.StartsWith("服务域名", StringComparison.Ordinal) ||
                    line.StartsWith("隐私检查未通过", StringComparison.Ordinal) ||
                    line.StartsWith("未启动 Codex", StringComparison.Ordinal))
                    result.Add(new(ChatItemKind.Notice, "连接检查", Clip(line, 500)));
                continue;
            }
            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement; string type = Field(root, "type");
                if (type is not ("item.started" or "item.completed" or "item.updated")) continue;
                if (!root.TryGetProperty("item", out var item) || item.ValueKind != JsonValueKind.Object) continue;
                string kind = Field(item, "type"), id = Field(item, "id");
                ChatItem? rendered = null;
                if (kind == "agent_message" && type == "item.completed")
                    rendered = new(ChatItemKind.Assistant, "Codex", Clip(Field(item, "text")));
                else if (kind == "command_execution")
                {
                    bool failed = Field(item, "status") == "failed" ||
                        (item.TryGetProperty("exit_code", out var exit) && exit.ValueKind == JsonValueKind.Number && exit.TryGetInt32(out int code) && code != 0);
                    string status = type == "item.started" ? "执行中" : failed ? "失败" : "已结束";
                    string command = Field(item, "command"), text = Field(item, "aggregated_output");
                    rendered = new(ChatItemKind.Command, "终端 · " + status,
                        Clip(command + (string.IsNullOrEmpty(text) ? "" : "\n" + text), 8000));
                }
                else if (kind == "file_change")
                {
                    var builder = new StringBuilder();
                    if (item.TryGetProperty("changes", out var changes) && changes.ValueKind == JsonValueKind.Array)
                        foreach (var change in changes.EnumerateArray().Take(50))
                            builder.AppendLine(Field(change, "path"));
                    string status = type == "item.started" ? "处理中" : Field(item, "status") == "failed" ? "失败" : "已报告";
                    rendered = new(ChatItemKind.FileChange, "文件 · " + status, Clip(builder.ToString().TrimEnd(), 4000));
                }
                else if (kind == "error" && type == "item.completed")
                    rendered = new(ChatItemKind.Error, "任务提示", Clip(Field(item, "message"), 4000));
                if (rendered is null) continue;
                if (id.Length > 0 && positions.TryGetValue(id, out int position)) result[position] = rendered;
                else { if (id.Length > 0) positions[id] = result.Count; result.Add(rendered); }
            }
            catch (JsonException) { /* Ignore a partial or unsupported event. */ }
        }
        return result;
    }
}
