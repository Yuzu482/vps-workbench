using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using RemoteSsh;

namespace DshVpsChat;

internal sealed record Activity(string Title, string Text);
internal sealed record SteerObservation(Guid Id, string State);
internal sealed record SteerNote(Guid Id, string Prompt, string State);
internal sealed record ApprovalNote(Guid Id, string Title, string Detail, string Kind, bool CanAllow, string State, string? Decision)
{
    internal bool Valid => Id != Guid.Empty && Title is { Length: > 0 and <= 240 } &&
        Detail is { Length: <= 512 } && Kind is { Length: > 0 and <= 32 } &&
        State is ("pending" or "queued" or "dispatching" or "submitted" or "unknown" or "closed") &&
        Decision is (null or "allow" or "deny") && (State != "pending" || Decision is null) &&
        (Decision != "allow" || CanAllow);
}

internal sealed record TurnOutput(string State, string Reply, Activity[] Activity,
    bool SteerReady = false, SteerObservation[]? Steering = null,
    string? Model = null, string? Effort = null, ContextUsage? ContextUsage = null, ApprovalNote[]? Approvals = null,
    SubscriptionLimits? SubscriptionLimits = null, string? FailureCode = null, int? ExitCode = null)
{
    internal static readonly TurnOutput Unobserved = new("unknown", "", []);
}

internal sealed partial class ChatBridge(string stateRoot, BridgeRequest request)
{
    private const int MaxSessions = 100;
    private const int MaxTurns = 100;
    private const int MaxVisibleTurns = 16;
    private const int MaxCacheBytes = 192 * 1024;
    private const int MaxSteeringBytes = 48 * 1024;
    private const int MaxPresetBytes = 64 * 1024;
    private static readonly string AppDirectory = AppContext.BaseDirectory;
    private static readonly TimeSpan SshTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan CatalogTimeout = TimeSpan.FromSeconds(56);
    private readonly TargetSettings settings = request.Settings;
    private readonly string directory = Path.Combine(stateRoot, request.TargetId);
    private bool UsesSdk => settings.Provider == "claude-sdk";
    private bool SupportsStreaming => settings.Provider is "codex" or "claude-sdk" or "antigravity";

    public async Task<object> Execute()
    {
        bool needsPinStorage = request.Op is "send" or "setup-check" or "setup-backend" ||
            (request.Op == "models" && settings.Provider is ("codex" or "antigravity"));
        EnsureDirectory(stateRoot, needsPinStorage);
        if (request.Op == "configuration") return new { ok = true, targetId = request.TargetId,
            memoryTargetId = settings.MemoryFingerprint(), sessions = Array.Empty<object>() };
        EnsureDirectory(directory, needsPinStorage);
        if (request.Op == "list") return new { ok = true, targetId = request.TargetId,
            memoryTargetId = settings.MemoryFingerprint(), sessions = ListSessions() };
        if (request.Op == "models") return await Models();
        if (request.BackendSetup is { } backendSetup) return await ExecuteBackendSetup(backendSetup);
        if (request.Setup is { } check) return await CheckSetup(check);
        if (request.Op == "design-history") return DesignHistory(ReadConversation());
        if (request.Op == "workflow-artifacts") return await WorkflowArtifacts();
        if (request.Op == "get")
        {
            var saved = ReadConversation();
            if (request.TurnId == Guid.Empty) return View(saved);
            return new { ok = true, memoryTargetId = settings.MemoryFingerprint(),
                memoryIsolation = saved?.MemoryIsolation == true,
                existingTurn = saved?.Turns.Exists(turn => turn.TaskId == request.TurnId) == true };
        }
        // A stop is bound to the original turn and cannot update our local
        // projection. It need not wait behind that turn's SSH refresh.
        if (request.Op == "stop") return await Stop(ReadConversation());
        if (request.Op == "steer") return await Steer(ReadConversation());
        if (request.Op == "approval") return await DecideApproval(ReadConversation());
        if (request.Op == "refresh" && !Directory.Exists(directory)) return View(null);

        using var sessionLock = Lock();
        var record = ReadConversation();
        return request.Op == "send" ? await Send(record) : await Refresh(record);
    }

    private async Task<object> CheckSetup(SetupCheck check)
    {
        using var pin = HoldPins(out var connection);
        Guid id = Guid.NewGuid();
        var start = Prepare(connection, null, ManagedTaskAction.SetupCheck, id);
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            check.Kind, check.McpServers, settings.Provider, settings.Workspace,
            expectedIpv4 = settings.Egress.ExpectedIpv4, expectedIpv6 = settings.Egress.ExpectedIpv6 ?? "",
            enforceEncryptedKey = Environment.GetEnvironmentVariable("DSH_VPS_CHAT_SOCKS_PORT") is not null
        }, BridgeProtocol.Json);
        var result = await ManagedTask.RunAsync(start, payload, TimeSpan.FromSeconds(check.Kind == "model" ? 56 : 35));
        if (result.ExitCode != 0 || result.Uncertain || string.IsNullOrWhiteSpace(result.Output))
            throw new BridgeError("setup_unreachable", "VPS 未返回检查结果。请检查 SSH 地址、端口、私钥和中继状态。");
        using var document = JsonDocument.Parse(result.Output);
        var reply = document.RootElement;
        if (!BridgeProtocol.HasFields(reply, "task_id", "status") ||
            !Guid.TryParseExact(BridgeProtocol.Text(reply, "task_id"), "D", out var observed) || observed != id)
            throw new BridgeError("setup_unreachable", "VPS 未返回可核对的检查结果。");
        string? status = BridgeProtocol.Text(reply, "status");
        return (check.Kind, status) switch
        {
            ("ssh", "connected") or ("account", "signed_in" or "key_configured" or "manual") or
                ("model", "model_route_ready") or
                ("resources", "resources_ready") => new { ok = true, targetId = request.TargetId, status },
            ("ssh", "workspace_unavailable") => throw new BridgeError("setup_workspace_unavailable", "SSH 已连通。远端项目目录不存在或当前 VPS 用户无法访问。"),
            ("account", "runtime_missing") => throw new BridgeError("setup_runtime_missing", "VPS 上缺少此执行端的 CLI、SDK 或运行环境，请检查安装。"),
            ("account", "account_missing") => throw new BridgeError("setup_account_missing", "未找到可用的 VPS 登录凭据。请完成登录或设置 API 密钥后重试。"),
            ("account", "encrypted_home_required") => throw new BridgeError("setup_key_storage", "当前 Claude API 路线需要将密钥放在 VPS 用户的 LUKS2 加密家目录中。"),
            ("model", "egress_unverified") => throw new BridgeError("setup_model_route", "VPS 的模型服务路由或预期出口未通过检查。请核对出口和服务域名。"),
            ("resources", "resources_unavailable") => throw new BridgeError("setup_mcp_unavailable", "VPS 上的 MCP 脚本缺失、不可读或权限设置不符合要求。"),
            _ => throw new BridgeError("setup_check_unavailable", "VPS 暂时无法完成这项检查。")
        };
    }

    private async Task<object> Models()
    {
        if (settings.Provider is "claude" or "claude-sdk")
        {
            return new
            {
                ok = true,
                models = ClaudeChat.ModelAliases.Select(id => new
                {
                    id,
                    displayName = "Claude " + char.ToUpperInvariant(id[0]) + id[1..],
                    isDefault = false,
                    efforts = Array.Empty<string>(),
                    defaultEffort = (string?)null
                }).ToArray()
            };
        }
        using var pin = HoldPins(out var connection);
        Guid id = Guid.NewGuid();
        var start = Prepare(connection, null, ManagedTaskAction.Catalog, id);
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            settings.Provider, settings.Workspace, settings.Egress.ExpectedIpv4, settings.Egress.ExpectedIpv6
        }, BridgeProtocol.Json);
        var result = await ManagedTask.RunAsync(start, payload, CatalogTimeout);
        var models = CodexStream.ReadModels(result, id) ??
            throw new BridgeError("models_unavailable", "暂时无法从 VPS 读取模型列表。");
        return new { ok = true, models };
    }

    private static void EnsureDirectory(string path, bool create)
    {
        if (create) Directory.CreateDirectory(path);
        if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new BridgeError("storage_unavailable", "工作台记录目录不可用。");
    }

    private FileStream Lock()
    {
        try { return ChatStore.Lock(directory, request.SessionId); }
        catch (IOException)
        {
            throw new BridgeError("session_blocked", "此会话正在处理另一项操作。请稍后查询。");
        }
    }

    internal static object ReadPreset(string stateRoot, bool includeSessions)
    {
        EnsureDirectory(stateRoot, create: false);
        string path = Path.Combine(stateRoot, "default-target.json");
        if (!File.Exists(path)) return new { ok = true, preset = (object?)null };

        using var file = OpenSnapshot(path, MaxPresetBytes, FileShare.Read | FileShare.Delete);
        using var document = JsonDocument.Parse(BridgeProtocol.ReadBounded(file, MaxPresetBytes), new JsonDocumentOptions { MaxDepth = 8 });
        var preset = document.RootElement;
        string? name = BridgeProtocol.Text(preset, "name");
        if (!BridgeProtocol.HasFields(preset, "name", "settings", "targetId") || string.IsNullOrWhiteSpace(name) ||
            name.Length > 60 || name.Any(char.IsControl))
            throw new BridgeError("invalid_settings", "默认 VPS 设置无法读取，请手动配置连接。");

        var form = preset.GetProperty("settings");
        var target = BridgeProtocol.ParseSettings(form);
        if (!form.TryGetProperty("provider", out _))
            throw new BridgeError("invalid_settings", "默认 VPS 设置缺少执行端，请手动配置连接。");
        string targetId = target.Fingerprint();
        if (BridgeProtocol.Text(preset, "targetId") != targetId)
            throw new BridgeError("target_changed", "默认 VPS 的连接设置或主机指纹已变化，请重新核对。");
        object[] sessions = [];
        if (includeSessions)
        {
            var bridge = new ChatBridge(stateRoot, new("list", target, targetId, Guid.Empty, Guid.Empty, null));
            EnsureDirectory(bridge.directory, create: false);
            sessions = bridge.ListSessions();
        }
        return new
        {
            ok = true,
            preset = new { name, settings = form.Clone(), targetId, memoryTargetId = target.MemoryFingerprint(),
                sessions }
        };
    }

    private object[] ListSessions()
    {
        if (!Directory.Exists(directory)) return [];
        return Directory.EnumerateFiles(directory, "conversation-*.json")
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .Take(MaxSessions)
            .Select(path =>
            {
                var record = ReadConversation(path);
                return new { id = record.Id, title = Title(record), mode = IsDesign(record.Id) ? "design" : "chat" };
            }).ToArray();
    }

    private ChatConversationRecord? ReadConversation()
    {
        string path = ChatStore.PathFor(directory, request.SessionId);
        return File.Exists(path) ? ReadConversation(path) : null;
    }

    private ChatConversationRecord ReadConversation(string path)
    {
        ChatConversationRecord record;
        try { record = ChatStore.Read(path, settings.Connection, directory); }
        catch (Exception ex) when (ex is JsonException or ArgumentException)
        {
            throw new BridgeError("storage_unavailable", "工作台记录不可用。");
        }
        if (record.Provider != settings.Provider || record.ClaudeAuthMode != (UsesSdk ? "subscription" : "api_key") ||
            record.NativeProfile != UsesSdk ||
            record.ClaudeAccountSourceId is not null || record.OuterOnly || record.Workspace != settings.Workspace ||
            record.ExpectedIpv4 != settings.Egress.ExpectedIpv4 || record.Turns.Count == 0)
            throw new BridgeError("storage_unavailable", "会话与当前 VPS 设置不匹配。");
        if (!IsDesign(record.Id))
        {
            Guid? thread = ExpectedThread(record);
            if (record.Turns.Any(turn => turn.ThreadId is not null && turn.ThreadId != thread))
                throw new BridgeError("storage_unavailable", "会话记录中的远端线程不一致。");
        }
        return record;
    }

    private static string Title(ChatConversationRecord record) => PromptTitle(record.Turns[0].Prompt);

    private static string PromptTitle(string prompt)
    {
        string title = string.Join(" ", prompt.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return OutputProjection.Visible(title, 54);
    }

    private object View(ChatConversationRecord? record, DesignLineage? lineage = null)
    {
        bool design = IsDesign(request.SessionId);
        if (design && record is not null) lineage ??= ReadDesignLineage(record);
        var turns = (record?.Turns ?? []).TakeLast(design ? 12 : MaxVisibleTurns)
            .Select(turn => ProjectTurn(turn, record!.Turns[^1], lineage?.Turns[turn.TaskId])).ToArray();
        string title = record is null ? "新对话" : Title(record);
        bool memoryIsolation = record?.MemoryIsolation == true;
        bool canSend = CanSend(record, lineage);
        object session = design
            ? new { id = request.SessionId, title, mode = "design", memoryIsolation, turns, canSend,
                canBranch = record is not null && CanBranch(record) }
            : new { id = request.SessionId, title, mode = "chat", memoryIsolation, turns, canSend };
        return new { ok = true, session };
    }

    private static string ProjectState(ChatTurnRecord turn, TurnOutput output) =>
        output.State == "complete" && turn.ThreadId is null ? "unknown" : output.State;

    private object ProjectTurn(ChatTurnRecord turn, ChatTurnRecord last, DesignTurn? design)
    {
        var output = ReadOutput(turn.TaskId);
        string state = ProjectState(turn, output);
        bool streaming = IsStreaming(turn.TaskId);
        bool canStop = streaming && turn == last && state is ("pending" or "running" or "unknown");
        bool canUseControls = settings.Provider == "antigravity" || (design is not null && settings.Provider == "codex");
        SteerNote[] steering = canUseControls ? ProjectSteering(turn.TaskId, output) : [];
        bool canSteer = canUseControls && streaming && state == "running" && output.SteerReady &&
            turn == last && steering.Length < BridgeProtocol.MaxSteers;
        return design is null
            ? new { id = turn.TaskId, prompt = turn.Prompt, output.Reply, state, output.Activity,
                streaming, canStop, canSteer, steering, output.Model, output.Effort, output.ContextUsage, output.SubscriptionLimits,
                output.FailureCode, output.ExitCode, approvals = settings.Provider == "antigravity" && turn == last ? output.Approvals ?? [] : [] }
            : new { id = turn.TaskId, prompt = turn.Prompt, output.Reply, state, output.Activity,
                streaming, canStop, canSteer, steering, output.Model, output.Effort, output.ContextUsage, output.SubscriptionLimits,
                output.FailureCode, output.ExitCode, approvals = settings.Provider == "antigravity" && turn == last ? output.Approvals ?? [] : [],
                design.ParentTurnId, fork = design.ExplicitBase?.Fork == true, design.Ordinal };
    }

    private bool CanSend(ChatConversationRecord? record, DesignLineage? lineage = null)
    {
        if (record is null) return true;
        if (record.MemoryExtraction) return false;
        var previous = record.Turns[^1];
        string state = ReadOutput(previous.TaskId).State;
        return record.Turns.Count < MaxTurns &&
            ((state == "complete" && previous.ThreadId.HasValue) ||
             (state == "stopped" && IsStreaming(previous.TaskId) &&
              (settings.Provider != "antigravity" || ExpectedThread(record, lineage).HasValue)));
    }

    private Guid? ExpectedThread(ChatConversationRecord record, DesignLineage? lineage = null)
    {
        if (lineage is not null) return lineage.ExpectedThread(lineage.Turns[record.Turns[^1].TaskId]);
        return settings.Provider == "claude" ? record.Id : record.Turns.FirstOrDefault(turn => turn.ThreadId.HasValue)?.ThreadId;
    }

    private string CachePath(Guid id) => Path.Combine(directory, $"turn-{id:D}.json");
    private string StreamPath(Guid id) => Path.Combine(directory, $"stream-{id:D}");
    private string DesignPath(Guid id) => Path.Combine(directory, $"design-{id:D}");
    private string DesignInputPath(Guid id) => Path.Combine(directory, $"design-input-{id:D}");
    private string ModelInputPath(Guid id) => Path.Combine(directory, $"model-input-{id:D}");

    private bool IsDesign(Guid id)
    {
        string path = DesignPath(id);
        if (!File.Exists(path)) return false;
        using var marker = OpenSnapshot(path, 1);
        if (marker.Length != 1 || marker.ReadByte() != 1)
            throw new BridgeError("storage_unavailable", "设计会话记录不可用。");
        return true;
    }

    private bool IsStreaming(Guid id) =>
        SupportsStreaming && File.Exists(StreamPath(id)) &&
        (File.GetAttributes(StreamPath(id)) & FileAttributes.ReparsePoint) == 0;

    private TurnOutput ReadOutput(Guid id)
    {
        string path = CachePath(id);
        if (!File.Exists(path)) return TurnOutput.Unobserved;
        try
        {
            using var file = OpenSnapshot(path, MaxCacheBytes, FileShare.Read | FileShare.Delete);
            var output = JsonSerializer.Deserialize<TurnOutput>(BridgeProtocol.ReadBounded(file, MaxCacheBytes), BridgeProtocol.Json);
            return output is { Reply.Length: <= CodexStream.MaxDesignReply, Activity.Length: <= 9,
                State: "pending" or "running" or "stopping" or "complete" or "stopped" or "failed" or "unknown" } &&
                output.Activity.All(item => item is { Title.Length: <= 80, Text.Length: <= 320 }) &&
                (output.Steering is null || ValidObservations(output.Steering)) &&
                (output.Approvals is null || CodexStream.ValidApprovals(output.Approvals)) &&
                (output.Model is null || BridgeProtocol.IsModelId(output.Model)) &&
                (output.Effort is null || BridgeProtocol.IsEffort(output.Effort)) &&
                (output.ContextUsage is null || output.ContextUsage.Valid) &&
                (output.SubscriptionLimits is null || output.SubscriptionLimits.Valid)
                ? output : TurnOutput.Unobserved;
        }
        catch (Exception ex) when (ex is IOException or JsonException or BridgeError)
        {
            // A damaged or busy display cache cannot authorize another turn.
            return TurnOutput.Unobserved;
        }
    }

    private static bool ValidObservations(SteerObservation[] items) => items.Length <= BridgeProtocol.MaxSteers &&
        items.All(item => item is not null && item.Id != Guid.Empty && CodexStream.IsSteerState(item.State)) &&
        items.Select(item => item.Id).Distinct().Count() == items.Length;

    private string SteeringPath(Guid turn) => Path.Combine(directory, $"steering-{turn:D}.json");

    private SteerNote[] ReadSteering(Guid turn)
    {
        string path = SteeringPath(turn);
        if (!File.Exists(path)) return [];
        using var file = OpenSnapshot(path, MaxSteeringBytes, FileShare.Read | FileShare.Delete);
        var notes = JsonSerializer.Deserialize<SteerNote[]>(BridgeProtocol.ReadBounded(file, MaxSteeringBytes), BridgeProtocol.Json);
        if (notes is null || notes.Length > BridgeProtocol.MaxSteers ||
            notes.Any(note => note is null || note.Id == Guid.Empty || string.IsNullOrWhiteSpace(note.Prompt) ||
                note.Prompt.Length > BridgeProtocol.MaxSteerPrompt || note.Prompt.Contains('\0') || !CodexStream.IsSteerState(note.State)) ||
            notes.Select(note => note.Id).Distinct().Count() != notes.Length)
            throw new BridgeError("storage_unavailable", "补充指令记录无法读取。");
        return notes;
    }

    private SteerNote[] ProjectSteering(Guid turn, TurnOutput output)
    {
        bool settled = output.State is "complete" or "stopped" or "failed";
        return ReadSteering(turn).Select(note =>
        {
            var observed = output.Steering?.FirstOrDefault(item => item.Id == note.Id);
            string state = observed?.State ?? note.State;
            if (settled && state == "queued") state = "unknown";
            if (settled && state == "unknown" && observed is null && output.Steering is not null) state = "rejected";
            return note with { State = state };
        }).ToArray();
    }

    private FileStream LockSteering(Guid turn)
    {
        string path = Path.Combine(directory, $"steering-{turn:D}.lock");
        try
        {
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new BridgeError("storage_before_send", "补充指令记录不可用。");
            return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            throw new BridgeError("session_blocked", "正在处理这轮的另一条补充指令。");
        }
    }

    private async Task<object> Steer(ChatConversationRecord? record)
    {
        ChatTurnRecord? turn = record?.Turns[^1];
        if (turn is null || turn.TaskId != request.TurnId ||
            (settings.Provider != "antigravity" && !IsDesign(request.SessionId)) || !IsStreaming(turn.TaskId))
            throw new BridgeError("steer_unavailable", "这轮生成已经结束，或暂时无法接收补充指令。");

        using var operation = LockSteering(turn.TaskId);
        var notes = ReadSteering(turn.TaskId);
        var existing = notes.FirstOrDefault(note => note.Id == request.SteerId);
        if (existing is not null)
        {
            if (existing.Prompt == request.Prompt) return View(ReadConversation());
            throw new BridgeError("steer_conflict", "该补充指令标识已用于其他内容。");
        }
        if (notes.Length >= BridgeProtocol.MaxSteers)
            throw new BridgeError("steer_limit", "本轮已达 6 条补充指令。");
        if (ReadOutput(turn.TaskId) is not { State: "running", SteerReady: true })
            throw new BridgeError("steer_unavailable", "这轮生成暂时无法接收补充指令。");

        using var pin = HoldPins(out var connection);
        var start = Prepare(connection, Path.Combine(directory, turn.Receipt), ManagedTaskAction.Status);
        start.ArgumentList.Add("--chat-steer");
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new { id = request.SteerId, prompt = request.Prompt }, BridgeProtocol.Json);
        var reserved = new SteerNote(request.SteerId, request.Prompt!, "unknown");
        try
        {
            SaveSteering(turn.TaskId, [.. notes, reserved]);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new BridgeError("storage_before_send", "补充指令记录未能保存。");
        }

        try
        {
            var response = await ManagedTask.RunAsync(start, payload, SshTimeout);
            string? state = CodexStream.SteerOutcome(response, turn.TaskId, request.SteerId);
            if (state is not (null or "unknown"))
                SaveSteering(turn.TaskId, [.. notes, reserved with { State = state }]);
        }
        catch (Exception error) when (error is IOException or Win32Exception or InvalidOperationException or UnauthorizedAccessException)
        {
            // Keep the reserved note. A status read can reconcile it by ID.
        }
        return View(ReadConversation());
    }

    private void SaveSteering(Guid turn, SteerNote[] notes)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(notes, BridgeProtocol.Json);
        if (bytes.Length > MaxSteeringBytes) throw new IOException("Steering record exceeds its size limit.");
        SaveSnapshot(SteeringPath(turn), bytes, replace: true);
    }

    private async Task<object> Send(ChatConversationRecord? record)
    {
        bool savedMode = IsDesign(request.SessionId);
        if ((record is not null || savedMode) && savedMode != request.Design)
            throw new BridgeError("mode_conflict", "这段会话已有固定模式。请从侧栏重新打开它。");
        if (record is not null && (record.MemoryExtraction != request.MemoryExtraction ||
            (request.MemoryIsolation && !record.MemoryIsolation)))
            throw new BridgeError("mode_conflict", "请新建对话以使用此记忆设置。");
        var input = record?.MemoryIsolation == true ? request with { MemoryIsolation = true } : request;
        if (input.MemoryIsolation && input.Extensions is { Memory.Length: > 0 })
            throw new BridgeError("invalid_request", "隔离会话不能附加项目记忆。");
        var lineage = savedMode && record is not null ? ReadDesignLineage(record) : null;
        var existing = record?.Turns.Find(turn => turn.TaskId == request.TurnId);
        if (existing is not null)
        {
            if (existing.Prompt == request.Prompt &&
                lineage?.Turns[existing.TaskId].ExplicitBase == request.DesignBase &&
                MatchesDigest(DesignInputPath(request.TurnId), request.Context?.Digest()) &&
                MatchesDigest(ModelInputPath(request.TurnId), input.ModelDigest()))
                return View(record, lineage);
            throw new BridgeError("turn_conflict", "此消息标识已用于其他内容。");
        }
        BridgeError Blocked() => new("session_blocked", "请先确认上一轮结果。不能续接时，可以另开对话。");
        Guid? thread;
        if (input.DesignBase is not null)
        {
            if (record is null || lineage is null) throw BranchUnavailable();
            if (!CanBranch(record)) throw Blocked();
            thread = SelectDesignThread(lineage, input.DesignBase);
        }
        else
        {
            if (!CanSend(record, lineage)) throw Blocked();
            if (request.WorkflowFiles is not null && record is not null)
                throw new BridgeError("mode_conflict", "工作流阶段需要独立的新会话。");
            thread = record is null ? null : ExpectedThread(record, lineage);
        }

        // Both adapters address native history by a caller-supplied session key. A fork gets its own
        // key while the local transcript, references and receipt remain in the original session.
        var nativeSession = input.SessionId;
        if (input.Design && settings.Provider is ("claude" or "antigravity"))
        {
            Guid root = input.DesignBase?.Fork == true || record is null ? input.TurnId :
                lineage!.Turns[input.DesignBase?.ParentTurnId ?? record.Turns[^1].TaskId].Root;
            nativeSession = DesignSessionKey(root);
        }
        bool streaming = SupportsStreaming;
        string? apiMemory = !streaming && input.Extensions is { Memory.Length: > 0 } extension ? extension.FormatMemory() : null;
        byte[] payload;
        try
        {
            payload = streaming
                ? CodexStream.BuildPayload(input with { SessionId = nativeSession }, thread, AppDirectory)
                : ClaudeChat.EncodeDshApiTurnRequest(input.Prompt!, settings.Workspace, settings.Egress, AppDirectory,
                    nativeSession, input.TurnId, thread, input.Model, apiMemory, input.MemoryIsolation,
                    input.Advanced?.MaxOutputTokens, input.Advanced?.ReasoningEffort,
                    input.WorkflowFiles is null ? null : JsonSerializer.SerializeToElement(input.WorkflowFiles, BridgeProtocol.Json),
                    input.Design ? input.Context?.Text ?? "" : null);
        }
        catch (ArgumentException)
        {
            throw new BridgeError("invalid_request", "消息或 VPS 项目路径超出可发送的范围。");
        }

        using var pin = HoldPins(out var connection);
        string receipt = Path.Combine(directory, $"task-{request.TurnId:D}.json");
        var start = Prepare(connection, receipt, ManagedTaskAction.Start, request.TurnId);
        if (streaming || apiMemory is not null || input.Design || input.WorkflowFiles is not null) start.ArgumentList.Add("--chat-stream");
        record ??= new ChatConversationRecord
        {
            Id = request.SessionId,
            Provider = settings.Provider,
            ClaudeAuthMode = UsesSdk ? "subscription" : "api_key",
            NativeProfile = UsesSdk,
            MemoryIsolation = input.MemoryIsolation,
            MemoryExtraction = input.MemoryExtraction,
            Host = connection.Host,
            User = connection.User,
            Port = connection.Port,
            Workspace = settings.Workspace,
            ExpectedIpv4 = settings.Egress.ExpectedIpv4
        };
        try
        {
            ReserveClaim();
            ManagedTask.ReserveReceipt(connection, receipt, null, request.TurnId);
            if (request.Design && !savedMode) SaveSnapshot(DesignPath(request.SessionId), [1], replace: false);
            if (request.DesignBase is not null) SaveDesignBase(request.DesignBase, record.Turns.Count + 1);
            if (request.Context is not null)
                SaveSnapshot(DesignInputPath(request.TurnId), request.Context.Digest(), replace: false);
            if (input.ModelDigest() is { } modelDigest)
                SaveSnapshot(ModelInputPath(request.TurnId), modelDigest, replace: false);
            if (streaming) SaveSnapshot(StreamPath(request.TurnId), [1], replace: false);
            record.Turns.Add(new ChatTurnRecord
            {
                TaskId = request.TurnId,
                Receipt = Path.GetFileName(receipt),
                Prompt = request.Prompt!
            });
            await SaveConversation(record, connection);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException
                                      or InvalidOperationException or JsonException)
        {
            throw new BridgeError("storage_before_send", "本机记录保存失败，消息未发送。可以重新发送。");
        }

        try
        {
            ManagedToolResult started = await ManagedTask.RunAsync(start, payload, SshTimeout);
            string state = HasAcknowledgement(started, request.TurnId) ? "pending" : "unknown";
            SaveOutput(request.TurnId, new(state, "", []));
            return View(record);
        }
        catch (Exception ex) when (ex is IOException or Win32Exception or UnauthorizedAccessException or InvalidOperationException)
        {
            throw new BridgeError("unknown", "发送结果待确认。请查询原消息。");
        }
    }

    private async Task<object> Refresh(ChatConversationRecord? record)
    {
        if (record is null) return View(null);
        var last = record.Turns[^1];
        bool design = IsDesign(request.SessionId);
        var lineage = design ? ReadDesignLineage(record) : null;
        var node = lineage?.Turns[last.TaskId];
        var prior = ReadOutput(last.TaskId);
        if (prior.State is ("failed" or "stopped") || (prior.State == "complete" && last.ThreadId.HasValue))
            return View(record, lineage);

        Guid? expected = ExpectedThread(record, lineage);
        if (node is not null && settings.Provider is ("antigravity" or "claude"))
            expected = DesignSessionKey(node.Root);
        Func<Guid, bool>? allowsThread = node is null ? null : thread => lineage!.AllowsThread(node, thread);

        using var pin = HoldPins(out var connection);
        string receipt = Path.Combine(directory, last.Receipt);
        var statusStart = Prepare(connection, receipt, ManagedTaskAction.Status);
        if (IsStreaming(last.TaskId))
        {
            statusStart.ArgumentList.Add("--chat-snapshot");
            var observed = await ManagedTask.RunAsync(statusStart, null, SshTimeout);
            var update = CodexStream.Read(observed, last.TaskId, settings.Provider == "antigravity" && !design ? record.Id : expected,
                prior, design, settings.Provider, allowsThread);
            if (update.Thread.HasValue && update.Thread != last.ThreadId)
            {
                last.ThreadId = update.Thread;
                await SaveConversation(record, connection);
            }
            if (update.Output.State != prior.State || update.Output.Reply != prior.Reply ||
                !update.Output.Activity.SequenceEqual(prior.Activity) || update.Output.SteerReady != prior.SteerReady ||
                !SameSteering(update.Output.Steering, prior.Steering) || update.Output.Model != prior.Model ||
                 update.Output.Effort != prior.Effort || update.Output.ContextUsage != prior.ContextUsage ||
                 update.Output.SubscriptionLimits != prior.SubscriptionLimits ||
                 update.Output.FailureCode != prior.FailureCode || update.Output.ExitCode != prior.ExitCode ||
                 !(update.Output.Approvals ?? []).SequenceEqual(prior.Approvals ?? []))
                SaveOutput(last.TaskId, update.Output);
            return View(record, lineage);
        }
        // One read attempt keeps polling bounded. The caller can query the same receipt again.
        statusStart.ArgumentList.Add("--attempts");
        statusStart.ArgumentList.Add("1");
        var response = await ManagedTask.RunAsync(statusStart, null, SshTimeout);
        var status = OutputProjection.ReadStatus(response, last.TaskId);
        if (status.State is "running" or "finished")
        {
            string? captured = null;
            if (status.Captured)
            {
                var output = await ManagedTask.RunAsync(
                    Prepare(connection, receipt, ManagedTaskAction.Output), null, SshTimeout);
                if (!output.Uncertain && output.ExitCode == 0)
                    captured = output.Output;
            }

            Guid? thread = captured is null ? null : ChatBackends.Completed(settings.Provider, captured,
                status.State == "finished", status.ExitCode, status.Truncated, expected);
            if (thread == Guid.Empty || (thread.HasValue && allowsThread?.Invoke(thread.Value) == false)) thread = null;
            string state = status.State == "running" ? "running" :
                status.ExitCode != 0 ? "failed" : thread.HasValue ? "complete" : "unknown";
            var projection = captured is null ? prior with { State = state } :
                OutputProjection.Project(settings.Provider, captured, expected, state, allowsThread, design);
            if (state == "failed")
            {
                projection = projection with { FailureCode = "remote_exit", ExitCode = status.ExitCode };
                if (design && settings.Provider == "claude" && status.Captured)
                {
                    const string storageError = "未启动 Claude API 请求。请挂载该 VPS 用户的 LUKS2 加密家目录，并配置权限为 0600 的 API 凭据。";
                    var error = await ManagedTask.RunAsync(Prepare(connection, receipt, ManagedTaskAction.ErrorOutput), null, SshTimeout);
                    if (!error.Uncertain && error.ExitCode == 0 && error.Output.Split('\n').Any(line => line.TrimEnd('\r') == storageError))
                        projection = projection with { FailureCode = "api_credential_storage",
                            Activity = [.. projection.Activity.Take(8), new Activity("Claude API 凭据存储", storageError)] };
                }
            }
            SaveOutput(last.TaskId, projection);
            if (thread.HasValue)
            {
                last.ThreadId = thread;
                await SaveConversation(record, connection);
            }
        }
        else
        {
            string state = status.State == "launch_failed" ? "failed" : "unknown";
            SaveOutput(last.TaskId, prior with { State = state, FailureCode = state == "failed" ? "launch_failed" : null });
        }
        return View(record, lineage);
    }

    private static bool SameSteering(SteerObservation[]? next, SteerObservation[]? prior) =>
        next is null ? prior is null : prior is not null && next.SequenceEqual(prior);

    private async Task<object> Stop(ChatConversationRecord? record)
    {
        ChatTurnRecord? turn = record?.Turns[^1];
        if (turn is null || turn.TaskId != request.TurnId || !IsStreaming(turn.TaskId))
            throw new BridgeError("stop_unavailable", "此消息没有可停止的当前轮次。");
        if (ReadOutput(turn.TaskId).State is "complete" or "stopped" or "failed")
            return new { ok = true, outcome = "settled" };

        using var pin = HoldPins(out var connection);
        var start = Prepare(connection, Path.Combine(directory, turn.Receipt), ManagedTaskAction.Status);
        start.ArgumentList.Add("--chat-stop");
        var response = await ManagedTask.RunAsync(start, null, SshTimeout);
        var outcome = CodexStream.StopOutcome(response, turn.TaskId) ??
            throw new BridgeError("stop_unknown", "停止请求结果待确认。请查询原任务。");
        return new { ok = true, outcome };
    }

    private async Task<object> DecideApproval(ChatConversationRecord? record)
    {
        ChatTurnRecord? turn = record?.Turns[^1];
        if (settings.Provider != "antigravity" || turn is null || turn.TaskId != request.TurnId || !IsStreaming(turn.TaskId))
            throw new BridgeError("approval_unavailable", "这条工具请求已离开当前轮次。");

        var output = ReadOutput(turn.TaskId);
        var card = output.Approvals?.FirstOrDefault(item => item.Id == request.ApprovalId);
        if (card is null || output.State != "running" || (request.Decision == "allow" && !card.CanAllow))
            throw new BridgeError("approval_unavailable", "这项工具审批已不可用。请查询当前轮次。");
        if (card.State != "pending")
        {
            if (card.Decision == request.Decision) return new { ok = true, outcome = card.State };
            throw new BridgeError("approval_unavailable", "这项工具审批已有处理记录。");
        }

        using var pin = HoldPins(out var connection);
        var start = Prepare(connection, Path.Combine(directory, turn.Receipt), ManagedTaskAction.Status);
        start.ArgumentList.Add("--chat-approval");
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new { id = request.ApprovalId, decision = request.Decision },
            BridgeProtocol.Json);
        var response = await ManagedTask.RunAsync(start, payload, SshTimeout);
        var outcome = CodexStream.ApprovalOutcome(response, turn.TaskId, request.ApprovalId);
        if (outcome == "rejected")
            throw new BridgeError("approval_rejected", "VPS 未接受这项工具审批。请查询原轮次。");
        if (outcome is null)
            throw new BridgeError("approval_uncertain", "工具审批结果待确认。正在查询原轮次。");
        return new { ok = true, outcome };
    }

    private static bool HasAcknowledgement(ManagedToolResult result, Guid expected)
    {
        if (result.Uncertain || result.ExitCode != 0) return false;
        try
        {
            using var document = JsonDocument.Parse(result.Output);
            var value = document.RootElement;
            return BridgeProtocol.Text(value, "outcome") == "accepted" &&
                Guid.TryParseExact(BridgeProtocol.Text(value, "task_id"), "D", out var id) && id == expected;
        }
        catch (JsonException) { return false; }
    }

    private static ProcessStartInfo Prepare(Connection connection, string? receipt, ManagedTaskAction action, Guid? id = null)
    {
        string? python = Environment.GetEnvironmentVariable("DSH_VPS_CHAT_PYTHON");
        if (python is not null && (!Path.IsPathFullyQualified(python) || !File.Exists(python)))
            throw new BridgeError("storage_unavailable", "本机 Python 助手不可用。");
        return ManagedTask.Build(connection, receipt, null, action, id, AppDirectory, python ?? "python.exe");
    }

    private async Task SaveConversation(ChatConversationRecord record, Connection connection)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                ChatStore.Save(record, connection, directory);
                return;
            }
            catch (IOException ex) when (attempt < 2 && (ex.HResult & 0xFFFF) is 32 or 33)
            {
                // Core readers may briefly deny the Windows replace while projecting the history.
                await Task.Delay(TimeSpan.FromMilliseconds(25));
            }
        }
    }

    private void ReserveClaim()
    {
        // Caller-generated turn IDs are exclusive across all VPS settings within this state root.
        string path = Path.Combine(stateRoot, $"claim-{request.TurnId:D}");
        try
        {
            using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
            file.Write(Encoding.UTF8.GetBytes($"{request.SessionId:D}\n{request.TargetId}\n"));
            file.Flush(flushToDisk: true);
        }
        catch (IOException) when (File.Exists(path))
        {
            throw new BridgeError("turn_conflict", "此消息标识已保留。可以查询原会话。");
        }
    }

    private static bool MatchesDigest(string path, byte[]? digest)
    {
        if (!File.Exists(path)) return digest is null;
        if (digest is null) return false;
        using var file = OpenSnapshot(path, 32);
        return BridgeProtocol.ReadBounded(file, 32).AsSpan().SequenceEqual(digest);
    }

    private FileStream HoldPins(out Connection connection, bool create = true)
    {
        string path = Path.Combine(directory, "known_hosts");
        if (create && !File.Exists(path))
        {
            try { SaveSnapshot(path, settings.HostPins, replace: false); }
            catch (IOException) when (File.Exists(path)) { }
        }
        var file = OpenSnapshot(path, BridgeProtocol.MaxHostPinBytes);
        try
        {
            if (!BridgeProtocol.ReadBounded(file, BridgeProtocol.MaxHostPinBytes).AsSpan().SequenceEqual(settings.HostPins))
                throw new BridgeError("invalid_settings", "主机指纹文件已变化，请重新确认 VPS 设置。");
            connection = settings.Connection with { KnownHostsPath = path };
            return file;
        }
        catch
        {
            file.Dispose();
            throw;
        }
    }

    private static FileStream OpenSnapshot(string path, int limit, FileShare share = FileShare.Read)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Invalid workbench snapshot.");
        var file = new FileStream(path, FileMode.Open, FileAccess.Read, share);
        if (file.Length <= limit) return file;
        file.Dispose();
        throw new IOException("Workbench snapshot is too large.");
    }

    private void SaveOutput(Guid id, TurnOutput output) =>
        SaveSnapshot(CachePath(id), JsonSerializer.SerializeToUtf8Bytes(output, BridgeProtocol.Json), replace: true);

    private static void SaveSnapshot(string path, byte[] bytes, bool replace)
    {
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Invalid workbench snapshot.");
        string temp = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                file.Write(bytes);
                file.Flush(flushToDisk: true);
            }
            File.Move(temp, path, overwrite: replace);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
}
