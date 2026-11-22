using System.Text.Json;
using System.Text.RegularExpressions;
using RemoteSsh;

namespace DshVpsChat;

internal sealed record BackendSetupRequest(string Kind, Guid InstallId, string[] Providers)
{
    private static readonly string[] BackendProviders = ["codex", "claude", "claude-sdk", "antigravity"];

    internal static bool HasFields(JsonElement value) => BridgeProtocol.Text(value, "kind") switch
    {
        "probe" => BridgeProtocol.HasFields(value, "op", "settings", "targetId", "kind"),
        "status" => BridgeProtocol.HasFields(value, "op", "settings", "targetId", "kind", "installId"),
        "start" => BridgeProtocol.HasFields(value, "op", "settings", "targetId", "kind", "installId", "providers"),
        _ => false
    };

    internal static BackendSetupRequest Parse(JsonElement value, string provider)
    {
        BridgeError Invalid() => new("invalid_request", "后端安装请求格式无效。");
        if (provider != "codex") throw Invalid(); // Canonical connection scope, independent of the selected runtime.
        string kind = BridgeProtocol.Text(value, "kind")!;
        if (kind == "probe") return new(kind, Guid.Empty, []);
        string? identifier = BridgeProtocol.Text(value, "installId");
        if (!Guid.TryParseExact(identifier, "D", out var id) || id == Guid.Empty || id.ToString("D") != identifier)
            throw Invalid();
        if (kind == "status") return new(kind, id, []);
        var array = value.GetProperty("providers");
        if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() is < 1 or > 4) throw Invalid();
        var providers = array.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null).ToArray();
        if (providers.Any(item => !BackendProviders.Contains(item)) || providers.Distinct().Count() != providers.Length)
            throw Invalid();
        return new(kind, id, BackendProviders.Where(providers.Contains).ToArray());
    }

    internal static bool Provider(string value) => BackendProviders.Contains(value);
}

internal sealed record BackendRuntimeResult(string Runtime, string? Code, bool? OnSshPath);
internal sealed record BackendInstallation(Guid Id, string[] Providers, string State,
    Dictionary<string, BackendRuntimeResult> Results, string? Code = null)
{
    internal bool Terminal => State is "succeeded" or "failed";
}

internal sealed partial class ChatBridge
{
    private const int BackendReceiptLimit = 8 * 1024;
    private const int BackendArchiveLimit = 256 * 1024;
    private static readonly Regex BackendToken = new(@"\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\z", RegexOptions.CultureInvariant);
    private string BackendDirectory => Path.Combine(directory, "backend-installs");
    private string BackendReceipt(Guid id) => Path.Combine(BackendDirectory, $"{id:D}.json");
    private string BackendLatest => Path.Combine(BackendDirectory, "latest");

    private async Task<object> ExecuteBackendSetup(BackendSetupRequest action)
    {
        EnsureDirectory(BackendDirectory, create: true);
        try
        {
            using var guard = new FileStream(Path.Combine(BackendDirectory, "lock"), FileMode.OpenOrCreate,
                FileAccess.Write, FileShare.None);
            if ((File.GetAttributes(guard.Name) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Invalid backend lock.");
            return await ExecuteBackendSetupLocked(action);
        }
        catch (IOException ex) when ((ex.HResult & 0xFFFF) is 32 or 33)
        {
            throw new BridgeError("backend_busy", "安装记录正在更新。请稍后查询原任务。");
        }
    }

    private async Task<object> ExecuteBackendSetupLocked(BackendSetupRequest action)
    {
        if (action.Kind == "probe")
        {
            var previous = ReadLatestBackend();
            var reply = await RunBackendSetup(action);
            if (reply is { } probe && probe.GetProperty("ok").ValueKind == JsonValueKind.True &&
                probe.TryGetProperty("platform", out var platform) && platform.ValueKind == JsonValueKind.Object)
                return new { ok = true, targetId = request.TargetId, platform = SafeBackendPlatform(platform), install = previous };
            string probeError = reply is { } rejected && rejected.GetProperty("ok").ValueKind == JsonValueKind.False
                ? BackendProbeError(BackendSafeToken(rejected, "code"))
                : "暂时无法读取 VPS 系统。请检查 SSH 指纹、登录和中继后重试。";
            if (previous is { Terminal: false })
                return new { ok = true, targetId = request.TargetId, platform = (object?)null, probeError, install = previous };
            throw new BridgeError("backend_probe_unavailable", probeError);
        }

        var existing = ReadBackendReceipt(action.InstallId);
        if (existing is not null)
        {
            if (action.Kind == "start" && !existing.Providers.SequenceEqual(action.Providers))
                throw new BridgeError("backend_conflict", "此安装标识已与另一组执行端绑定。请查询原任务。");
            if (existing.Terminal) return BackendReply(existing);
            // A repeated start can only observe the already reserved installation.
            return BackendReply(await ObserveBackend(existing, action with { Kind = "status" }));
        }
        if (action.Kind == "status")
            throw new BridgeError("backend_receipt_missing", "没有此 VPS 安装的本机回执，请重新检查目标。");
        if (ReadLatestBackend() is { Terminal: false })
            throw new BridgeError("backend_pending", "当前 VPS 的安装结果尚未确认。请查询原安装回执。");
        CheckBackendPackage();
        using var pin = HoldPins(out var connection);
        var start = Prepare(connection, null, ManagedTaskAction.BackendSetup, action.InstallId);
        var reserved = new BackendInstallation(action.InstallId, action.Providers, "unknown", [], "awaiting_receipt");
        WriteBackendReceipt(reserved, replace: false);
        SaveSnapshot(BackendLatest, System.Text.Encoding.ASCII.GetBytes(action.InstallId.ToString("D")), replace: true);
        return BackendReply(await ObserveBackend(reserved, action, start));
    }

    private static void CheckBackendPackage()
    {
        try
        {
            using var archive = OpenSnapshot(Path.Combine(AppDirectory, "vps-backend.tar.gz"), BackendArchiveLimit);
            using var digest = OpenSnapshot(Path.Combine(AppDirectory, "vps-backend.sha256"), 256);
            using var helper = OpenSnapshot(Path.Combine(AppDirectory, "RemoteVpsBackend.py"), 64 * 1024);
            string expected = System.Text.Encoding.ASCII.GetString(BridgeProtocol.ReadBounded(digest, 256)).Trim();
            if (archive.Length == 0 || helper.Length == 0 ||
                !string.Equals(expected, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(archive)), StringComparison.Ordinal))
                throw new IOException("Invalid backend package.");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new BridgeError("backend_package_unavailable", "当前桌面包的 VPS 后端安装文件缺失或校验失败。");
        }
    }

    private BackendInstallation? ReadLatestBackend()
    {
        if (!File.Exists(BackendLatest)) return null;
        using var file = OpenSnapshot(BackendLatest, 36);
        string value = System.Text.Encoding.ASCII.GetString(BridgeProtocol.ReadBounded(file, 36));
        if (!Guid.TryParseExact(value, "D", out var id) || id == Guid.Empty || value != id.ToString("D"))
            throw BackendReceiptUnavailable();
        return ReadBackendReceipt(id) ?? throw BackendReceiptUnavailable();
    }

    private BackendInstallation? ReadBackendReceipt(Guid id)
    {
        string path = BackendReceipt(id);
        if (!File.Exists(path)) return null;
        using var file = OpenSnapshot(path, BackendReceiptLimit);
        using var document = JsonDocument.Parse(BridgeProtocol.ReadBounded(file, BackendReceiptLimit));
        return ParseBackendInstallation(document.RootElement, id) ?? throw BackendReceiptUnavailable();
    }

    private static BridgeError BackendReceiptUnavailable() =>
        new("backend_receipt_unavailable", "VPS 安装回执无法读取。请保留记录并核对原任务。");

    private void WriteBackendReceipt(BackendInstallation receipt, bool replace) =>
        SaveSnapshot(BackendReceipt(receipt.Id), JsonSerializer.SerializeToUtf8Bytes(receipt, BridgeProtocol.Json), replace);

    private object BackendReply(BackendInstallation job) => new { ok = true, targetId = request.TargetId, install = job };

    private async Task<BackendInstallation> ObserveBackend(BackendInstallation receipt, BackendSetupRequest action,
        System.Diagnostics.ProcessStartInfo? start = null)
    {
        JsonElement? response = await RunBackendSetup(action, start);
        var next = response is { } observed && observed.GetProperty("ok").ValueKind == JsonValueKind.True &&
            observed.TryGetProperty("install", out var install)
            ? ParseBackendInstallation(install, receipt.Id) : null;
        if (next is null || !receipt.Providers.SequenceEqual(next.Providers))
            next = receipt with { State = "unknown", Code = "awaiting_receipt" };
        WriteBackendReceipt(next, replace: true);
        return next;
    }

    private async Task<JsonElement?> RunBackendSetup(BackendSetupRequest action, System.Diagnostics.ProcessStartInfo? start = null)
    {
        if (start is not null) return await RunBackendCommand(action, start);
        using var pin = HoldPins(out var connection);
        return await RunBackendCommand(action, Prepare(connection, null, ManagedTaskAction.BackendSetup,
            action.Kind == "probe" ? Guid.NewGuid() : action.InstallId));
    }

    private async Task<JsonElement?> RunBackendCommand(BackendSetupRequest action, System.Diagnostics.ProcessStartInfo start)
    {
        var fields = new Dictionary<string, object?> { ["kind"] = action.Kind, ["targetId"] = request.TargetId };
        if (action.Kind is "probe" or "start") fields["workspace"] = settings.Workspace;
        if (action.Kind is "start" or "status") fields["installId"] = action.InstallId.ToString("D");
        if (action.Kind == "start") fields["providers"] = action.Providers;
        var result = await ManagedTask.RunAsync(start, JsonSerializer.SerializeToUtf8Bytes(fields, BridgeProtocol.Json),
            TimeSpan.FromSeconds(52));
        if (result.Uncertain || result.ExitCode != 0) return null;
        try
        {
            using var document = JsonDocument.Parse(result.Output, new JsonDocumentOptions { MaxDepth = 8 });
            var reply = document.RootElement;
            if (reply.ValueKind != JsonValueKind.Object || !reply.TryGetProperty("ok", out var ok) ||
                ok.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                BridgeProtocol.Text(reply, "targetId") != request.TargetId)
                return null;
            return reply.Clone();
        }
        catch (JsonException) { return null; }
    }

    private static string BackendProbeError(string? code) => code switch
    {
        "non_root_user_required" => "SSH 已连通。请改用运行模型的普通 VPS 用户。",
        "invalid_home" or "unsafe_directory" => "SSH 已连通。请核对 VPS 用户家目录及权限。",
        "unsafe_ssh_path" => "SSH 已连通。请核对 VPS 非交互 PATH 中的目录和权限。",
        "invalid_workspace" => "SSH 已连通。请核对 VPS 工作目录的完整路径。",
        _ => "SSH 已连通，但 VPS 未能完成后端预检。请核对运行环境。"
    };

    private static string? BackendSafeToken(JsonElement item, string key) =>
        BridgeProtocol.Text(item, key) is { } value && BackendToken.IsMatch(value) ? value : null;

    private static bool? BackendOnPath(JsonElement item) => item.TryGetProperty("onSshPath", out var field) &&
        field.ValueKind is JsonValueKind.True or JsonValueKind.False ? field.GetBoolean() : null;

    private static object SafeBackendPlatform(JsonElement item)
    {
        var missing = new List<string>();
        if (item.TryGetProperty("missing", out var values) && values.ValueKind == JsonValueKind.Array)
        {
            foreach (var value in values.EnumerateArray().Take(12))
                if (value.ValueKind == JsonValueKind.String && value.GetString() is
                    ("python3" or "bubblewrap" or "curl" or "ip" or "/usr/bin" or "/usr/sbin" or "/usr/lib"))
                    missing.Add(value.GetString()!);
        }
        var providers = new Dictionary<string, object>();
        if (item.TryGetProperty("providers", out var entries) && entries.ValueKind == JsonValueKind.Object)
        {
            foreach (var entry in entries.EnumerateObject())
                if (BackendSetupRequest.Provider(entry.Name) && BackendSafeToken(entry.Value, "runtime") is
                    ("found" or "missing" or "sdk_missing" or "profile_not_configured") and var state)
                    providers[entry.Name] = new { runtime = state, onSshPath = BackendOnPath(entry.Value) };
        }
        return new
        {
            system = BackendSafeToken(item, "system"),
            distribution = BackendSafeToken(item, "distribution"),
            distributionVersion = BackendSafeToken(item, "distributionVersion"),
            architecture = BackendSafeToken(item, "architecture"),
            packageManager = BackendSafeToken(item, "packageManager"),
            blocker = BackendSafeToken(item, "blocker"),
            sandbox = BackendSafeToken(item, "sandbox"),
            workspace = BackendSafeToken(item, "workspace"),
            missing, providers
        };
    }

    private static BackendInstallation? ParseBackendInstallation(JsonElement item, Guid id)
    {
        if (item.ValueKind != JsonValueKind.Object || BridgeProtocol.Text(item, "id") != id.ToString("D") ||
            BackendSafeToken(item, "state") is not ("running" or "succeeded" or "failed" or "unknown") ||
            !item.TryGetProperty("providers", out var providers) || providers.ValueKind != JsonValueKind.Array ||
            providers.GetArrayLength() is < 1 or > 4 || !item.TryGetProperty("results", out var results) ||
            results.ValueKind != JsonValueKind.Object)
            return null;
        string[] names = providers.EnumerateArray().Select(value => value.ValueKind == JsonValueKind.String ? value.GetString()! : "").ToArray();
        if (names.Any(name => !BackendSetupRequest.Provider(name)) || names.Distinct().Count() != names.Length)
            return null;
        var clean = new Dictionary<string, BackendRuntimeResult>();
        foreach (var entry in results.EnumerateObject())
        {
            if (!names.Contains(entry.Name) || clean.ContainsKey(entry.Name) ||
                BackendSafeToken(entry.Value, "runtime") is not ("installed" or "existing" or "failed"))
                return null;
            clean.Add(entry.Name, new BackendRuntimeResult(BackendSafeToken(entry.Value, "runtime")!,
                BackendSafeToken(entry.Value, "code"), BackendOnPath(entry.Value)));
        }
        string state = BackendSafeToken(item, "state")!;
        if (state == "succeeded" && (clean.Count != names.Length || clean.Values.Any(result => result.Runtime == "failed")))
            return null;
        return new BackendInstallation(id, names, state, clean, BackendSafeToken(item, "code"));
    }
}
