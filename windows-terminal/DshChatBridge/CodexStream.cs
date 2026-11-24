using System.IO.Compression;
using System.Text;
using System.Text.Json;
using RemoteSsh;

namespace DshVpsChat;

internal sealed record StreamReply(TurnOutput Output, Guid? Thread);
internal sealed record ContextUsage(long UsedTokens, long? ContextWindow,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? Kind = null)
{
    private const long MaxSafeInteger = 9_007_199_254_740_991;
    internal bool Valid => UsedTokens is >= 0 and <= MaxSafeInteger &&
        (ContextWindow is null or (> 0 and <= MaxSafeInteger)) &&
        (Kind is null or "request_input" || Kind == "turn_input" && ContextWindow is null);
}
internal sealed record SubscriptionWindow(double UsedPercent, long ResetsAt)
{
    internal bool Valid => UsedPercent is >= 0 and <= 100 && ResetsAt is > 0 and <= 253402300799;
}
internal sealed record SubscriptionLimits(SubscriptionWindow? FiveHour, SubscriptionWindow? Weekly)
{
    internal bool Valid => (FiveHour is not null || Weekly is not null) &&
        (FiveHour?.Valid ?? true) && (Weekly?.Valid ?? true);
}
internal sealed record CatalogModel(string Id, string DisplayName, bool IsDefault, string[] Efforts, string? DefaultEffort);

internal static class CodexStream
{
    internal const int MaxChatReply = 8192;
    internal const int MaxDesignReply = 16384;
    private const int MaxArgument = 12288;
    private const int MaxStreamHelper = 56 * 1024; // Also enforced by Antigravity's support loader.
    private const int MaxAntigravityHelper = 46 * 1024;
    private const int MaxApprovals = 16;
    private const string Loader = "import base64,sys,zlib;exec(zlib.decompress(base64.b64decode(sys.argv[1]+sys.argv.pop(2))),{'__name__':'__main__'})";

    internal static byte[] BuildPayload(BridgeRequest request, Guid? thread, string directory)
    {
        var settings = request.Settings;
        var egress = settings.Egress;
        var input = new Dictionary<string, object?>
        {
            ["sessionId"] = request.SessionId,
            ["taskId"] = request.TurnId,
            ["threadId"] = thread,
            ["workspace"] = settings.Workspace,
            ["expectedIpv4"] = egress.ExpectedIpv4,
            ["expectedIpv6"] = egress.ExpectedIpv6,
            ["prompt"] = request.Prompt,
            ["design"] = request.Design,
            ["designContext"] = request.Context,
        };
        if (request.Model is not null) input.Add("model", request.Model);
        if (request.Effort is not null) input.Add("effort", request.Effort);
        if (request.WorkspaceAccess is not null) input.Add("workspaceAccess", request.WorkspaceAccess);
        if (request.MemoryIsolation) input.Add("memoryIsolation", true);
        if (request.MemoryExtraction) input.Add("memoryExtraction", true);
        if (request.MemoryScope is not null) input.Add("memoryScope", request.MemoryScope);
        if (request.Advanced is not null) input.Add("advanced", request.Advanced);
        if (request.WorkflowFiles is not null)
        {
            input.Add("workflowFiles", request.WorkflowFiles);
            input.Add("workflowHelper", Helper(directory, "RemoteWorkflowFiles.py"));
        }
        if (request.Extensions is not null)
        {
            input.Add("extensions", request.Extensions);
            input.Add("extensionsHelper", Helper(directory, "RemoteDshExtensions.py"));
        }
        bool sdk = settings.Provider == "claude-sdk";
        bool antigravity = settings.Provider == "antigravity";
        if (antigravity) input.Add("support", Helper(directory, "RemoteDshCodexStream.py"));
        if (sdk)
        {
            input.Add("sdk", new
            {
                launcher = Helper(directory, "RemoteDshClaudeSdk.py"),
                worker = Helper(directory, "dsh-claude-sdk-worker.mjs"),
                safety = Helper(directory, "RemoteNativeSafety.py"),
                session = Helper(directory, "RemoteNativeSession.py"),
                paths = Helper(directory, "sessions.py"),
            });
        }
        string launcher = Helper(directory, antigravity ? "RemoteDshAntigravity.py" : "RemoteDshCodexStream.py");
        input.Add("privacyHelper", Helper(directory, "RemoteCodexPrivacy.py"));
        int split = Math.Min(MaxArgument, launcher.Length);
        string[] command = [
            "python3", "-I", "-B", "-c", Loader,
            launcher[..split], launcher[split..],
            "-",
            Helper(directory, "RemoteCodexIsolate.py"),
        ];

        // Inputs travel over SSH stdin separately from the bounded command.
        _ = ManagedTask.EncodeRequest(new(command, settings.Workspace, CaptureOutput: true));
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            command,
            cwd = settings.Workspace,
            capture = true,
            chatInput = input
        }, BridgeProtocol.Json);
        if (payload.Length > DesignContext.MaxRequestBytes) throw new ArgumentException("Design input is too large.");
        return payload;
    }

    private static string Helper(string directory, string name)
    {
        using var source = File.OpenRead(Path.Combine(directory, name));
        int limit = name switch
        {
            "RemoteDshCodexStream.py" => MaxStreamHelper,
            "RemoteDshAntigravity.py" => MaxAntigravityHelper,
            _ => 32768
        };
        byte[] bytes = BridgeProtocol.ReadBounded(source, limit);
        return Compress(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("\r\n", "\n", StringComparison.Ordinal)));
    }

    private static string Compress(byte[] bytes)
    {
        using var output = new MemoryStream();
        using (var compressor = new ZLibStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            compressor.Write(bytes);
        return Convert.ToBase64String(output.ToArray());
    }

    internal static string? StopOutcome(ManagedToolResult response, Guid id)
    {
        using var packet = ReadPacket(response, id);
        string? outcome = packet is null ? null : BridgeProtocol.Text(packet.RootElement, "outcome");
        return outcome is "requested" or "settled" ? outcome : null;
    }

    internal static string? SteerOutcome(ManagedToolResult response, Guid id, Guid steer)
    {
        using var packet = ReadPacket(response, id);
        if (packet is null || !Guid.TryParseExact(BridgeProtocol.Text(packet.RootElement, "steer_id"), "D", out var observed) ||
            observed != steer) return null;
        string? state = BridgeProtocol.Text(packet.RootElement, "outcome");
        return IsSteerState(state) ? state : null;
    }

    internal static bool IsSteerState(string? state) => state is "queued" or "submitted" or "delivered" or "rejected" or "unknown";

    internal static string? ApprovalOutcome(ManagedToolResult response, Guid turn, Guid approval)
    {
        using var packet = ReadPacket(response, turn);
        if (packet is null || !Guid.TryParseExact(BridgeProtocol.Text(packet.RootElement, "approval_id"), "D", out var id) ||
            id != approval) return null;
        string? state = BridgeProtocol.Text(packet.RootElement, "outcome");
        return state is "queued" or "dispatching" or "submitted" or "unknown" or "closed" or "rejected" ? state : null;
    }

    internal static bool ValidApprovals(ApprovalNote[] rows) => rows.Length <= MaxApprovals &&
        rows.All(row => row is { Valid: true }) && rows.Select(row => row.Id).Distinct().Count() == rows.Length;

    private static ApprovalNote[]? ReadApprovals(JsonElement packet)
    {
        if (!packet.TryGetProperty("approvals", out var rows) || rows.ValueKind != JsonValueKind.Array ||
            rows.GetArrayLength() > MaxApprovals) return null;
        var notes = new List<ApprovalNote>(rows.GetArrayLength());
        foreach (var row in rows.EnumerateArray())
        {
            if (!BridgeProtocol.HasFields(row, "id", "title", "detail", "kind", "canAllow", "state", "decision") ||
                !Guid.TryParseExact(BridgeProtocol.Text(row, "id"), "D", out var id) ||
                BridgeProtocol.Text(row, "title") is not { } title ||
                BridgeProtocol.Text(row, "detail") is not { } detail ||
                BridgeProtocol.Text(row, "kind") is not { } kind ||
                BridgeProtocol.Text(row, "state") is not { } state ||
                row.GetProperty("canAllow").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                row.GetProperty("decision").ValueKind is not (JsonValueKind.String or JsonValueKind.Null)) return null;
            notes.Add(new(id, OutputProjection.Visible(title, 240), OutputProjection.Visible(detail, 512),
                OutputProjection.Visible(kind, 32), row.GetProperty("canAllow").GetBoolean(), state,
                BridgeProtocol.Text(row, "decision")));
        }
        var result = notes.ToArray();
        return ValidApprovals(result) ? result : null;
    }

    internal static CatalogModel[]? ReadModels(ManagedToolResult response, Guid id)
    {
        using var packet = ReadPacket(response, id);
        if (packet is null || !packet.RootElement.TryGetProperty("models", out var rows) ||
            rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() is < 1 or > 64) return null;
        var models = new List<CatalogModel>(rows.GetArrayLength());
        foreach (var row in rows.EnumerateArray())
        {
            if (!BridgeProtocol.HasFields(row, "id", "displayName", "isDefault", "efforts", "defaultEffort")) return null;
            string? name = BridgeProtocol.Text(row, "id");
            string? label = BridgeProtocol.Text(row, "displayName");
            var isDefault = row.GetProperty("isDefault").ValueKind;
            var entries = row.GetProperty("efforts");
            var selectedEffort = row.GetProperty("defaultEffort");
            if (!BridgeProtocol.IsModelId(name) || string.IsNullOrWhiteSpace(label) || label.Length > 80 ||
                label.Any(char.IsControl) || isDefault is not (JsonValueKind.True or JsonValueKind.False) ||
                entries.ValueKind != JsonValueKind.Array || entries.GetArrayLength() > 8 ||
                selectedEffort.ValueKind is not (JsonValueKind.Null or JsonValueKind.String) ||
                models.Any(model => model.Id == name)) return null;
            var efforts = new List<string>(entries.GetArrayLength());
            foreach (var effort in entries.EnumerateArray())
            {
                if (effort.ValueKind != JsonValueKind.String || effort.GetString() is not string choice ||
                    !BridgeProtocol.IsEffort(choice) || efforts.Contains(choice)) return null;
                efforts.Add(choice);
            }
            string? fallback = selectedEffort.GetString();
            if (fallback is not null && !efforts.Contains(fallback)) return null;
            models.Add(new CatalogModel(name!, label, isDefault == JsonValueKind.True, efforts.ToArray(), fallback));
        }
        return models.ToArray();
    }

    private static SubscriptionLimits? ReadSubscriptionLimits(JsonElement stream)
    {
        if (!stream.TryGetProperty("subscription_limits", out var limits) || limits.ValueKind != JsonValueKind.Object)
            return null;
        SubscriptionWindow? Read(string key)
        {
            if (!limits.TryGetProperty(key, out var window) || !BridgeProtocol.HasFields(window, "usedPercent", "resetsAt") ||
                window.GetProperty("usedPercent").ValueKind != JsonValueKind.Number ||
                !window.GetProperty("usedPercent").TryGetDouble(out double used) ||
                window.GetProperty("resetsAt").ValueKind != JsonValueKind.Number ||
                !window.GetProperty("resetsAt").TryGetInt64(out long resets))
                return null;
            var result = new SubscriptionWindow(used, resets);
            return result.Valid ? result : null;
        }
        var result = new SubscriptionLimits(Read("fiveHour"), Read("weekly"));
        return result.Valid ? result : null;
    }

    private static ContextUsage? ReadContextUsage(JsonElement stream)
    {
        if (!stream.TryGetProperty("context_usage", out var context) ||
            (!BridgeProtocol.HasFields(context, "usedTokens", "contextWindow") &&
             !BridgeProtocol.HasFields(context, "usedTokens", "contextWindow", "kind")) ||
            context.GetProperty("usedTokens").ValueKind != JsonValueKind.Number ||
            !context.GetProperty("usedTokens").TryGetInt64(out long used)) return null;
        var value = context.GetProperty("contextWindow");
        long? window = null;
        if (value.ValueKind != JsonValueKind.Null)
        {
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out long reported)) return null;
            window = reported;
        }
        string? kind = BridgeProtocol.Text(context, "kind");
        if (context.TryGetProperty("kind", out _) && kind is null) return null;
        var usage = new ContextUsage(used, window, kind);
        return usage.Valid ? usage : null;
    }

    private static SteerObservation[]? ReadSteering(JsonElement packet)
    {
        if (!packet.TryGetProperty("steering", out var rows) || rows.ValueKind != JsonValueKind.Array ||
            rows.GetArrayLength() > BridgeProtocol.MaxSteers) return null;
        var items = new List<SteerObservation>(rows.GetArrayLength());
        foreach (var row in rows.EnumerateArray())
        {
            string? state = BridgeProtocol.Text(row, "state");
            if (!BridgeProtocol.HasFields(row, "id", "state") || !IsSteerState(state) ||
                !Guid.TryParseExact(BridgeProtocol.Text(row, "id"), "D", out var id) || id == Guid.Empty ||
                items.Any(item => item.Id == id)) return null;
            items.Add(new SteerObservation(id, state!));
        }
        return items.ToArray();
    }

    internal static StreamReply Read(ManagedToolResult response, Guid id, Guid? expected, TurnOutput prior,
        bool design, string provider, Func<Guid, bool>? allowsThread = null)
    {
        StreamReply Unknown() => new(prior with { State = "unknown", SteerReady = false }, null);
        using var packet = ReadPacket(response, id);
        if (packet is null) return Unknown();
        var root = packet.RootElement;
        string? remoteState = BridgeProtocol.Text(root, "state");
        if (remoteState == "launch_failed")
            return new(Failed(prior with { FailureCode = "launch_failed", ExitCode = null }), null);
        if (remoteState is not ("pending" or "running" or "finished")) return Unknown();

        bool stopping = root.TryGetProperty("stop_requested", out var stop) && stop.ValueKind == JsonValueKind.True;
        string transportState = stopping ? "stopping" : remoteState;
        if (!root.TryGetProperty("stream", out var stream) || stream.ValueKind != JsonValueKind.Object)
            return remoteState == "finished" ? Unknown() : new(prior with { State = transportState, SteerReady = false }, null);

        if (!MatchesTask(stream, id) || !stream.TryGetProperty("thread_id", out var nativeThread))
            return Unknown();
        Guid? thread = null;
        if (nativeThread.ValueKind != JsonValueKind.Null)
        {
            if (nativeThread.ValueKind != JsonValueKind.String || !Guid.TryParseExact(nativeThread.GetString(), "D", out var actual) ||
                actual == Guid.Empty || (expected.HasValue && actual != expected) || allowsThread?.Invoke(actual) == false)
                return Unknown();
            thread = actual;
        }
        string? outcome = BridgeProtocol.Text(stream, "state");
        bool terminalWithoutThread = provider == "antigravity" && remoteState == "finished" &&
            outcome is ("failed" or "stopped" or "unknown");
        string? reply = BridgeProtocol.Text(stream, "reply");
        if (reply is null || (thread is null && reply.Length != 0 && !terminalWithoutThread) ||
            !stream.TryGetProperty("checks", out var checks) || checks.ValueKind != JsonValueKind.Array ||
            checks.GetArrayLength() > 4 || checks.EnumerateArray().Any(line => line.ValueKind != JsonValueKind.String))
            return Unknown();
        var activity = checks.EnumerateArray().Select(line => new Activity("连接检查", OutputProjection.Visible(line.GetString()!, 320))).ToArray();
        var steering = design || provider == "antigravity" ? ReadSteering(root) : null;
        var approvals = provider == "antigravity" ? ReadApprovals(root) : null;
        bool steerReady = remoteState == "running" && !stopping && thread.HasValue && steering is not null &&
            stream.TryGetProperty("steer_ready", out var flag) && flag.ValueKind == JsonValueKind.True;
        string? reportedModel = BridgeProtocol.Text(stream, "model");
        string? reportedEffort = BridgeProtocol.Text(stream, "effort");
        var current = new TurnOutput(transportState,
            OutputProjection.Visible(reply, design ? MaxDesignReply : MaxChatReply), activity,
            steerReady, steering ?? prior.Steering,
            BridgeProtocol.IsModelId(reportedModel) ? reportedModel : prior.Model,
            BridgeProtocol.IsEffort(reportedEffort) ? reportedEffort : prior.Effort,
            ReadContextUsage(stream) ?? prior.ContextUsage, approvals ?? prior.Approvals,
            ReadSubscriptionLimits(stream) ?? prior.SubscriptionLimits);
        if (remoteState != "finished") return new(current, null);

        if (!root.TryGetProperty("exit_code", out var code) || code.ValueKind != JsonValueKind.Number || !code.TryGetInt32(out int exit))
            return Unknown();
        string? reason = BridgeProtocol.Text(stream, "reason");
        if (outcome == "failed" && exit != 0)
        {
            string failure = reason switch
            {
                "oauth_org_not_allowed" or "sdk_setup" when provider == "claude-sdk" => reason,
                "egress" => reason,
                "agy_auth" or "agy_setup" or "agy_acp" or "agy_options" when provider == "antigravity" => reason,
                "mcp_setup" => reason,
                _ => "remote_exit"
            };
            current = current with { FailureCode = failure, ExitCode = exit };
        }
        return outcome switch
        {
            "complete" when exit == 0 && thread.HasValue => new(current with { State = "complete" }, thread),
            "stopped" when exit == 0 => new(current with { State = "stopped" }, thread),
            "failed" when exit != 0 && provider == "claude-sdk" && reason == "oauth_org_not_allowed" => new(Failed(current,
                "Claude 拒绝了当前订阅的 Claude Code 请求。请在 VPS 上核对 Claude 订阅状态。"), null),
            "failed" when exit != 0 && provider == "antigravity" && reason == "agy_setup" => new(Failed(current,
                "请在 VPS 上安装 agy，登录 Antigravity 专用配置，并配置服务域名。"), null),
            "failed" when exit != 0 && provider == "antigravity" && reason == "agy_auth" => new(Failed(current,
                "Antigravity ACP 需要登录。请在「VPS 设置 → 账号」完成 Antigravity 登录后再发送。"), null),
            "failed" when exit != 0 && provider == "antigravity" && reason == "agy_acp" => new(Failed(current,
                "Antigravity ACP 无法启动或恢复会话。请检查 VPS 上的 ACP 版本和会话配置。"), null),
            "failed" when exit != 0 && provider == "antigravity" && reason == "agy_options" => new(Failed(current,
                "Antigravity 的模型或思考档位不可用。请重新读取模型目录或恢复默认选项。"), null),
            "failed" when exit != 0 && provider == "antigravity" && reason == "agy_limit" => new(Failed(current,
                "Antigravity 达到本轮输出或工具调用限制，已保留收到的内容。"), null),
            "failed" when exit != 0 && provider == "antigravity" && reason == "agy_workflow_mode" => new(Failed(current,
                "当前 VPS 上的 Antigravity ACP 不支持工作流输出模式。"), null),
            "failed" when exit != 0 && provider == "antigravity" && reason == "agy_rejected" => new(Failed(current,
                "Antigravity CLI 拒绝了本轮。请在 VPS 上检查登录状态和 CLI 版本。"), null),
            "failed" when exit != 0 && reason == "mcp_setup" => new(Failed(current,
                "VPS 的 MCP 服务准备失败。请检查已启用服务的名称、权限和脚本。"), null),
            "failed" when exit != 0 => new(Failed(current), null),
            _ => new(current with { State = "unknown" }, null)
        };
    }

    private static TurnOutput Failed(TurnOutput current,
        string message = "请检查 VPS 执行端的登录、运行环境和出口设置。") =>
        current with
        {
            State = "failed",
            SteerReady = false,
            Activity = [.. current.Activity.Take(8), new Activity("VPS 执行失败", message)]
        };

    private static bool MatchesTask(JsonElement packet, Guid id) =>
        Guid.TryParseExact(BridgeProtocol.Text(packet, "task_id"), "D", out var observed) && observed == id;

    private static JsonDocument? ReadPacket(ManagedToolResult response, Guid id)
    {
        if (response.Uncertain || response.ExitCode != 0) return null;
        try
        {
            var document = JsonDocument.Parse(response.Output, new JsonDocumentOptions { MaxDepth = 8 });
            if (MatchesTask(document.RootElement, id)) return document;
            document.Dispose();
        }
        catch (JsonException) { }
        return null;
    }
}
