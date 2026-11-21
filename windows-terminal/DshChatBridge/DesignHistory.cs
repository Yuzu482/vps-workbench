using System.Text.Json;
using RemoteSsh;

namespace DshVpsChat;

internal sealed partial class ChatBridge
{
    private const int MaxDesignLineageBytes = 512;

    private sealed record DesignTurn(ChatTurnRecord Record, Guid? ParentTurnId, DesignBase? ExplicitBase, Guid Root, int Ordinal);

    private sealed class DesignLineage
    {
        internal readonly Dictionary<Guid, DesignTurn> Turns = [];
        private readonly Dictionary<Guid, Guid> tips = [];
        private readonly Dictionary<Guid, Guid> threads = [];
        private readonly Dictionary<Guid, Guid> owners = [];

        internal Guid? ExpectedThread(DesignTurn turn) => threads.TryGetValue(turn.Root, out var thread) ? thread : null;

        internal bool AllowsThread(DesignTurn turn, Guid thread) =>
            !owners.TryGetValue(thread, out var owner) || owner == turn.Root;

        internal void Add(DesignTurn turn)
        {
            if (turn.Record.ThreadId is Guid thread)
            {
                if (!AllowsThread(turn, thread) || (ExpectedThread(turn) is Guid expected && expected != thread))
                    throw new BridgeError("storage_unavailable", "设计分支记录中的远端线程不一致。");
                threads[turn.Root] = thread;
                owners[thread] = turn.Root;
            }
            Turns.Add(turn.Record.TaskId, turn);
            tips[turn.Root] = turn.Record.TaskId;
        }

        internal bool IsTip(DesignTurn turn) => tips[turn.Root] == turn.Record.TaskId;
    }

    private string DesignLineagePath(Guid id) => Path.Combine(directory, $"design-lineage-{id:D}");

    private DesignLineage ReadDesignLineage(ChatConversationRecord record)
    {
        var lineage = new DesignLineage();
        DesignTurn? previous = null;
        foreach (var turn in record.Turns)
        {
            int ordinal = lineage.Turns.Count + 1;
            var basis = ReadDesignBase(record.Id, turn.TaskId, ordinal);
            var parent = previous;
            if (basis is not null &&
                (!lineage.Turns.TryGetValue(basis.ParentTurnId, out parent) || parent.Record.ThreadId is null ||
                 (!basis.Fork && !lineage.IsTip(parent))))
                throw new BridgeError("storage_unavailable", "设计分支的来源或顺序无效。");

            previous = new DesignTurn(turn, parent?.Record.TaskId, basis,
                basis?.Fork == true || parent is null ? turn.TaskId : parent.Root, ordinal);
            lineage.Add(previous);
        }
        return lineage;
    }

    private DesignBase? ReadDesignBase(Guid sessionId, Guid turnId, int ordinal)
    {
        string path = DesignLineagePath(turnId);
        if (!File.Exists(path)) return null;
        try
        {
            using var file = OpenSnapshot(path, MaxDesignLineageBytes);
            using var document = JsonDocument.Parse(BridgeProtocol.ReadBounded(file, MaxDesignLineageBytes));
            var entry = document.RootElement;
            if (BridgeProtocol.HasFields(entry, "sessionId", "turnId", "ordinal", "base") &&
                Guid.TryParseExact(BridgeProtocol.Text(entry, "sessionId"), "D", out var session) && session == sessionId &&
                Guid.TryParseExact(BridgeProtocol.Text(entry, "turnId"), "D", out var id) && id == turnId &&
                entry.GetProperty("ordinal") is { ValueKind: JsonValueKind.Number } order &&
                order.TryGetInt32(out int position) && position == ordinal)
                return DesignBase.Parse(entry.GetProperty("base"));
        }
        catch (Exception error) when (error is JsonException or BridgeError)
        {
            // Persisted metadata has its own error category, separate from request validation.
        }
        throw new BridgeError("storage_unavailable", "设计分支记录不可用。");
    }

    private void SaveDesignBase(DesignBase designBase, int ordinal)
    {
        var snapshot = new { request.SessionId, request.TurnId, ordinal, @base = designBase };
        SaveSnapshot(DesignLineagePath(request.TurnId), JsonSerializer.SerializeToUtf8Bytes(snapshot, BridgeProtocol.Json), replace: false);
    }

    private static BridgeError BranchUnavailable() =>
        new("design_branch_unavailable", "无法使用所选的设计轮次。请选择可用的来源。");

    private Guid? SelectDesignThread(DesignLineage lineage, DesignBase designBase)
    {
        if (!lineage.Turns.TryGetValue(designBase.ParentTurnId, out var parent) ||
            !IsCompleted(parent.Record, ReadOutput(parent.Record.TaskId)) ||
            (!designBase.Fork && !lineage.IsTip(parent)))
            throw BranchUnavailable();
        return designBase.Fork ? null : parent.Record.ThreadId;
    }

    private static bool IsCompleted(ChatTurnRecord turn, TurnOutput output) =>
        output.State == "complete" && turn.ThreadId.HasValue;

    private bool CanBranch(ChatConversationRecord record)
    {
        if (record.Turns.Count >= MaxTurns) return false;
        var last = record.Turns[^1];
        var output = ReadOutput(last.TaskId);
        return output.State is "failed" or "stopped" || IsCompleted(last, output);
    }

    private object DesignHistory(ChatConversationRecord? record)
    {
        if (record is null || !IsDesign(record.Id)) throw BranchUnavailable();
        var lineage = ReadDesignLineage(record);
        if (request.TurnId != Guid.Empty)
        {
            if (!lineage.Turns.TryGetValue(request.TurnId, out var turn)) throw BranchUnavailable();
            return new { ok = true, turn = ProjectTurn(turn.Record, record.Turns[^1], turn) };
        }

        var history = record.Turns.Select(turn =>
        {
            var node = lineage.Turns[turn.TaskId];
            var output = ReadOutput(turn.TaskId);
            bool complete = IsCompleted(turn, output);
            string title = PromptTitle(turn.Prompt);
            return new
            {
                id = turn.TaskId,
                node.ParentTurnId,
                fork = node.ExplicitBase?.Fork == true,
                node.Ordinal,
                title = title.Length > 0 ? title : $"第 {node.Ordinal} 轮",
                state = ProjectState(turn, output),
                hasBoards = complete && HasHtmlFence(output.Reply),
                canContinue = complete && lineage.IsTip(node)
            };
        }).ToArray();
        return new { ok = true, history };
    }

    private static bool HasHtmlFence(string markdown)
    {
        using var lines = new StringReader(markdown);
        char marker = '\0';
        int opening = 0;
        bool html = false, hasMarkup = false;
        while (lines.ReadLine() is string line)
        {
            var text = line.AsSpan().TrimEnd();
            int indentation = 0;
            while (indentation < text.Length && text[indentation] == ' ') indentation++;
            var fence = text[indentation..];
            int length = 0;
            if (indentation <= 3 && fence.Length >= 3 && fence[0] is '`' or '~')
                while (length < fence.Length && fence[length] == fence[0]) length++;
            var info = fence[length..].Trim();
            if (opening == 0)
            {
                if (length < 3 || (fence[0] == '`' && info.Contains('`'))) continue;
                marker = fence[0];
                opening = length;
                html = info.Equals("html", StringComparison.OrdinalIgnoreCase) ||
                    info.Equals("html5", StringComparison.OrdinalIgnoreCase);
                hasMarkup = false;
            }
            else if (length >= opening && marker == fence[0] && info.IsEmpty)
            {
                if (html && hasMarkup) return true;
                opening = 0;
            }
            else if (html && text.Contains('<'))
            {
                hasMarkup = true;
            }
        }
        return false;
    }
}
