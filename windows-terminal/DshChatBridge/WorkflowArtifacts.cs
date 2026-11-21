using System.Text.Json;
using RemoteSsh;

namespace DshVpsChat;

internal sealed partial class ChatBridge
{
    private async Task<object> WorkflowArtifacts()
    {
        var turn = ReadConversation()?.Turns.Find(item => item.TaskId == request.TurnId);
        if (turn is null || ProjectState(turn, ReadOutput(turn.TaskId)) is not ("complete" or "failed" or "stopped"))
            throw new BridgeError("artifacts_unavailable", "请先确认原阶段的运行结果。");
        using var pins = HoldPins(out var connection, create: false);
        var start = Prepare(connection, Path.Combine(directory, turn.Receipt), ManagedTaskAction.WorkflowArtifacts);
        var query = new Dictionary<string, object>();
        if (request.ArtifactPath is not null) query.Add("path", request.ArtifactPath);
        if (request.ArtifactOffset.HasValue) query.Add("offset", request.ArtifactOffset.Value);
        if (request.ArtifactAfter is not null) query.Add("after", request.ArtifactAfter);
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(query, BridgeProtocol.Json);
        var observed = await ManagedTask.RunAsync(start, payload, SshTimeout);
        BridgeError Invalid() => new("artifacts_unavailable", "无法读取此阶段的产物，请核对文件状态。");
        if (observed.Uncertain || observed.ExitCode != 0) throw Invalid();
        try
        {
            using var document = JsonDocument.Parse(observed.Output);
            var reply = document.RootElement;
            if (BridgeProtocol.Text(reply, "task_id") != turn.TaskId.ToString("D")) throw Invalid();
            if (request.ArtifactPath is { } path)
            {
                if (!BridgeProtocol.HasFields(reply, "task_id", "file")) throw Invalid();
                var file = reply.GetProperty("file");
                bool chunked = request.ArtifactOffset.HasValue;
                string[] fields = chunked ? ["path", "size", "offset", "revision", "data"] : ["path", "size", "data"];
                if (!BridgeProtocol.HasFields(file, fields) || BridgeProtocol.Text(file, "path") != path ||
                    file.GetProperty("size") is not { ValueKind: JsonValueKind.Number } size || !size.TryGetInt32(out int total) ||
                    total < 0 || total > (chunked ? 256 * 1024 * 1024 : 1024 * 1024) ||
                    BridgeProtocol.Text(file, "data") is not { } data) throw Invalid();
                int offset = request.ArtifactOffset ?? 0;
                if (chunked && (file.GetProperty("offset") is not { ValueKind: JsonValueKind.Number } position ||
                    !position.TryGetInt32(out var actual) || actual != offset || (offset != 0 && offset >= total) ||
                    BridgeProtocol.Text(file, "revision") is not { Length: 64 } revision || !revision.All(char.IsAsciiHexDigitLower)))
                    throw Invalid();
                int count = Math.Min(1024 * 1024, total - offset);
                if (data.Length != 4 * ((count + 2) / 3)) throw Invalid();
                byte[] decoded = Convert.FromBase64String(data);
                if (decoded.Length != count || Convert.ToBase64String(decoded) != data) throw Invalid();
                return new { ok = true, file = file.Clone() };
            }
            if (!BridgeProtocol.HasFields(reply, "task_id", "files", "truncated") ||
                reply.GetProperty("files") is not { ValueKind: JsonValueKind.Array } rows || rows.GetArrayLength() > 256 ||
                reply.GetProperty("truncated").ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw Invalid();
            bool truncated = reply.GetProperty("truncated").GetBoolean();
            if (truncated && rows.GetArrayLength() != 256) throw Invalid();
            string? previous = request.ArtifactAfter;
            foreach (var row in rows.EnumerateArray())
            {
                string? name = BridgeProtocol.Text(row, "path");
                if (!BridgeProtocol.HasFields(row, "path", "size") || name is null || !WorkflowFiles.IsPath(name) ||
                    StringComparer.Ordinal.Compare(previous, name) >= 0 ||
                    row.GetProperty("size") is not { ValueKind: JsonValueKind.Number } size ||
                    !size.TryGetInt64(out long count) || count < 0 || count > 9007199254740991L) throw Invalid();
                previous = name;
            }
            return new { ok = true, files = rows.Clone(), truncated };
        }
        catch (Exception ex) when (ex is JsonException or FormatException) { throw Invalid(); }
    }
}
