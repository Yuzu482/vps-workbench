using System.Text;
using System.Text.Json;
using RemoteSsh;

namespace DshVpsChat;

internal sealed record RemoteStatus(string State, int? ExitCode = null, bool Captured = false, bool Truncated = false);

internal static class OutputProjection
{
    internal static RemoteStatus ReadStatus(ManagedToolResult result, Guid id)
    {
        if (result.Uncertain || result.ExitCode != 0) return new("unknown");
        try
        {
            using var document = JsonDocument.Parse(result.Output);
            var value = document.RootElement;
            if (!Guid.TryParseExact(BridgeProtocol.Text(value, "task_id"), "D", out Guid observed) || observed != id)
                return new("unknown");
            string? state = BridgeProtocol.Text(value, "state");
            if (state == "running") return new(state, Captured: true);
            if (state == "launch_failed") return new(state);
            if (state == "finished" &&
                value.TryGetProperty("exit_code", out var exit) && exit.ValueKind == JsonValueKind.Number &&
                exit.TryGetInt32(out int code))
            {
                bool capture = value.TryGetProperty("output_captured", out var captured) && captured.ValueKind == JsonValueKind.True;
                bool complete = value.TryGetProperty("output_truncated", out var truncated) && truncated.ValueKind == JsonValueKind.False;
                return new(state, code, capture, !complete);
            }
        }
        catch (JsonException) { }
        return new("unknown");
    }

    internal static TurnOutput Project(string provider, string raw, Guid? expected, string state, Func<Guid, bool>? allowsThread = null)
    {
        // Drop the unfinished line from live captures; only whole CLI events are displayable.
        string output = raw[..(raw.LastIndexOf('\n') + 1)];
        return provider == "codex" ? ProjectCodex(output, expected, state, allowsThread) : ProjectClaude(output, expected, state);
    }

    private static TurnOutput ProjectCodex(string output, Guid? expected, string state, Func<Guid, bool>? allowsThread)
    {
        var parsed = ChatBackends.Parse("codex", output, complete: true);
        var activity = parsed.Where(item => item.Kind == ChatItemKind.Notice).Take(4)
            .Select(item => new Activity(item.Title, Visible(item.Text, 320))).ToList();
        string reply = "";
        if (MatchesCodexThread(output, expected, allowsThread))
        {
            reply = parsed.LastOrDefault(item => item.Kind == ChatItemKind.Assistant)?.Text ?? "";
            activity.AddRange(parsed.Where(item => item.Kind is ChatItemKind.Command or ChatItemKind.FileChange)
                .Take(8 - activity.Count).Select(item => new Activity(item.Title, "")));
        }
        if (state == "failed") activity.Add(new Activity("VPS 执行失败", "请检查 VPS 上的 Codex 登录、运行环境和出口设置。"));
        return new(state, Visible(reply, CodexStream.MaxChatReply), activity.ToArray());
    }

    private static bool MatchesCodexThread(string output, Guid? expected, Func<Guid, bool>? allowsThread)
    {
        Guid? thread = null;
        foreach (string line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!line.StartsWith('{')) continue;
            try
            {
                using var document = JsonDocument.Parse(line);
                var value = document.RootElement;
                if (BridgeProtocol.Text(value, "type") != "thread.started") continue;
                if (thread.HasValue || !Guid.TryParse(BridgeProtocol.Text(value, "thread_id"), out Guid observed) ||
                    observed == Guid.Empty || (expected.HasValue && observed != expected) || allowsThread?.Invoke(observed) == false) return false;
                thread = observed;
            }
            catch (JsonException) { return false; }
        }
        return thread.HasValue;
    }

    private static TurnOutput ProjectClaude(string output, Guid? expected, string state)
    {
        var parsed = ChatBackends.Parse("claude", output, complete: true);
        var activity = parsed.Where(item => item.Kind == ChatItemKind.Notice).Take(4)
            .Select(item => new Activity(item.Title, Visible(item.Text, 320))).ToList();
        var answer = new StringBuilder();
        bool initialized = false;
        string? model = null;
        foreach (string line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!line.StartsWith('{')) continue;
            try
            {
                using var document = JsonDocument.Parse(line);
                var value = document.RootElement;
                string? kind = BridgeProtocol.Text(value, "type");
                if (kind == "system" && BridgeProtocol.Text(value, "subtype") == "init")
                {
                    if (initialized || !Guid.TryParse(BridgeProtocol.Text(value, "session_id"), out Guid observed) || observed != expected)
                        return new(state, "", activity.ToArray());
                    initialized = true;
                    string? reportedModel = BridgeProtocol.Text(value, "model");
                    if (BridgeProtocol.IsModelId(reportedModel)) model = reportedModel;
                }
                if (!initialized || kind != "assistant" ||
                    (value.TryGetProperty("parent_tool_use_id", out var parent) && parent.ValueKind != JsonValueKind.Null) ||
                    !value.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object ||
                    !message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
                    continue;
                foreach (var part in content.EnumerateArray())
                {
                    switch (BridgeProtocol.Text(part, "type"))
                    {
                        case "text" when BridgeProtocol.Text(part, "text") is string text && text.Length > 0:
                            if (answer.Length > 0) answer.Append("\n\n");
                            answer.Append(Visible(text, text.Length));
                            break;
                        case "tool_use" when activity.Count < 8 && BridgeProtocol.Text(part, "name") is "Read" or "Glob" or "Grep":
                            activity.Add(new Activity("只读工具", BridgeProtocol.Text(part, "name")!));
                            break;
                    }
                }
            }
            catch (JsonException)
            {
                // The malformed event is omitted from the live preview. Core checks the intact
                // completion record independently before allowing this session to continue.
            }
        }
        if (state == "failed") activity.Add(new Activity("VPS 执行失败", "请核对远端运行环境、Claude Code 认证和预期出口。"));
        string reply = state == "complete" && parsed.LastOrDefault(item => item.Kind == ChatItemKind.Assistant) is ChatItem final
            ? final.Text : answer.ToString();
        return new(state, Visible(reply, CodexStream.MaxChatReply), activity.ToArray(), Model: model);
    }

    internal static string Visible(string text, int limit)
    {
        if (limit <= 0) return "";
        var output = new StringBuilder(Math.Min(text.Length, limit));
        foreach (Rune rune in text.EnumerateRunes())
        {
            if (Rune.IsControl(rune) && rune.Value is not ('\n' or '\t')) continue;
            if (output.Length + rune.Utf16SequenceLength > limit) break;
            output.Append(rune.ToString());
        }
        return output.ToString();
    }
}
