using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace RemoteSsh;

public enum ManagedTaskAction { Start, Status, Output, ErrorOutput, Catalog, SetupCheck, WorkflowArtifacts, BackendSetup }
public sealed record ManagedTaskRequest(string[] Command, string? WorkingDirectory, bool CaptureOutput);
public sealed record ManagedToolResult(int? ExitCode, string Output, bool Uncertain);
public sealed record ManagedReceipt(Guid TaskId, string? StateDirectory);

// The receipt is the durable identity of a single logical operation. Create it
// exclusively and flush it before starting any child process or SSH connection.
public static class ManagedTask
{
    private const int MaxRequestBytes = 32768;
    private const int MaxOutputChars = 262144;
    private static readonly JsonSerializerOptions JsonOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static void ValidateRemoteDirectory(string? value)
    {
        if (value is not null && (value.Length is 0 or > 2048 || !value.StartsWith('/') || value.Contains('\0')))
            throw new ArgumentException("远端目录必须是以 / 开头的完整 Linux 路径。");
    }

    public static byte[] EncodeRequest(ManagedTaskRequest request)
    {
        ValidateRemoteDirectory(request.WorkingDirectory);
        if (request.Command is null || request.Command.Length is 0 or > 64 ||
            string.IsNullOrEmpty(request.Command[0]) ||
            request.Command.Any(arg => arg is null || arg.Length > 12288 || arg.Contains('\0')))
            throw new ArgumentException("请输入可执行程序和有效参数，最多 64 项。");
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            command = request.Command, cwd = request.WorkingDirectory, capture = request.CaptureOutput
        }, JsonOptions);
        if (payload.Length > MaxRequestBytes) throw new ArgumentException("任务参数过长。");
        return payload;
    }

    public static Guid ReserveReceipt(Connection connection, string receiptPath, string? stateDirectory, Guid? proposedId = null)
    {
        connection.Validate();
        if (connection.Authentication != Authentication.Key)
            throw new ArgumentException("托管任务需要无需交互的 SSH 私钥认证。");
        ValidateRemoteDirectory(stateDirectory);
        if (string.IsNullOrWhiteSpace(receiptPath) || receiptPath.Length > 2048 ||
            !Path.IsPathFullyQualified(receiptPath) || receiptPath.Contains('\0'))
            throw new ArgumentException("回执必须是完整的本机文件路径。");
        var id = proposedId ?? Guid.NewGuid();
        if (id == Guid.Empty) throw new ArgumentException("任务 ID 无效。");
        var record = new
        {
            version = 1, task_id = id.ToString("D"), host = connection.Host.ToLowerInvariant(),
            port = connection.Port, user = connection.User, state_dir = stateDirectory
        };
        byte[] data = JsonSerializer.SerializeToUtf8Bytes(record, JsonOptions);
        using var file = new FileStream(receiptPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read,
            bufferSize: 4096, options: FileOptions.WriteThrough);
        file.Write(data);
        file.Flush(flushToDisk: true);
        return id;
    }

    public static ManagedReceipt ReadReceipt(Connection connection, string receiptPath)
    {
        connection.Validate();
        if (string.IsNullOrWhiteSpace(receiptPath) || receiptPath.Length > 2048 || !Path.IsPathFullyQualified(receiptPath))
            throw new ArgumentException("回执必须是完整的本机文件路径。");
        var info = new FileInfo(receiptPath);
        if (!info.Exists || info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new ArgumentException("回执不是有效的普通文件。");
        using var stream = new FileStream(receiptPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length > 4096) throw new ArgumentException("回执过大。");
        byte[] bytes = new byte[4097]; int count = 0, part;
        while (count < bytes.Length && (part = stream.Read(bytes, count, bytes.Length - count)) > 0) count += part;
        if (count > 4096) throw new ArgumentException("回执过大。");
        using var document = JsonDocument.Parse(bytes.AsMemory(0, count));
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new ArgumentException("回执格式无效。");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in root.EnumerateObject())
            if (!names.Add(field.Name)) throw new ArgumentException("回执字段重复。");
        if (!names.SetEquals(["version", "task_id", "host", "port", "user", "state_dir"]) ||
            root.GetProperty("version").ValueKind != JsonValueKind.Number || !root.GetProperty("version").TryGetInt32(out int version) || version != 1 ||
            root.GetProperty("task_id").ValueKind != JsonValueKind.String ||
            !Guid.TryParse(root.GetProperty("task_id").GetString(), out var id) ||
            root.GetProperty("host").ValueKind != JsonValueKind.String ||
            !string.Equals(root.GetProperty("host").GetString(), connection.Host, StringComparison.OrdinalIgnoreCase) ||
            root.GetProperty("port").ValueKind != JsonValueKind.Number || !root.GetProperty("port").TryGetInt32(out int port) || port != connection.Port ||
            root.GetProperty("user").ValueKind != JsonValueKind.String ||
            !string.Equals(root.GetProperty("user").GetString(), connection.User, StringComparison.Ordinal))
            throw new ArgumentException("回执与当前连接不匹配或格式无效。");
        var state = root.GetProperty("state_dir");
        if (state.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)) throw new ArgumentException("回执状态目录无效。");
        string? stateDirectory = state.ValueKind == JsonValueKind.Null ? null : state.GetString();
        ValidateRemoteDirectory(stateDirectory);
        return new(id, stateDirectory);
    }

    public static ProcessStartInfo Build(Connection connection, string? receiptPath, string? stateDirectory,
        ManagedTaskAction action, Guid? id, string appDirectory, string pythonExecutable = "python.exe")
    {
        connection.Validate();
        if (connection.Authentication != Authentication.Key) throw new ArgumentException("托管任务需要 SSH 私钥认证。");
        ValidateRemoteDirectory(stateDirectory);
        bool probe = action is ManagedTaskAction.Catalog or ManagedTaskAction.SetupCheck or ManagedTaskAction.BackendSetup;
        if (!probe && (string.IsNullOrWhiteSpace(receiptPath) || !Path.IsPathFullyQualified(receiptPath) || receiptPath.Length > 2048))
            throw new ArgumentException("回执必须是完整的本机文件路径。");
        if (probe && (id is null || id == Guid.Empty || stateDirectory is not null || receiptPath is not null))
            throw new ArgumentException("查询标识无效。");
        if (action == ManagedTaskAction.Start && id is null) throw new ArgumentException("启动任务必须指定回执中的任务 ID。");
        string script = Path.Combine(appDirectory, action switch
        {
            ManagedTaskAction.Start => "RemoteTaskStart.py",
            ManagedTaskAction.BackendSetup => "VpsBackendClient.py",
            _ => "RemoteTaskStatus.py"
        });
        if (!File.Exists(script)) throw new FileNotFoundException("任务脚本缺失，请重新构建完整发布目录。", script);
        var start = new ProcessStartInfo(pythonExecutable)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = appDirectory,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false, false), StandardErrorEncoding = new UTF8Encoding(false, false)
        };
        void Add(params string[] values) { foreach (var value in values) start.ArgumentList.Add(value); }
        Add("-E", "-s", "-B", script, "--host", connection.Host, "--port", connection.Port.ToString(CultureInfo.InvariantCulture),
            "--user", connection.User, "--identity", connection.IdentityPath, "--known-hosts", connection.KnownHostsPath);
        if (probe)
        {
            Add("--id", id!.Value.ToString("D"));
            if (action == ManagedTaskAction.Catalog) Add("--chat-models");
            if (action == ManagedTaskAction.SetupCheck) Add("--setup-check");
        }
        else Add("--receipt", receiptPath!);
        if (stateDirectory is not null) Add("--state-dir", stateDirectory);
        if (action == ManagedTaskAction.Start) Add("--id", id!.Value.ToString("D"), "--request-stdin");
        if (action == ManagedTaskAction.Output) Add("--output");
        if (action == ManagedTaskAction.ErrorOutput) Add("--stderr");
        if (action == ManagedTaskAction.WorkflowArtifacts) Add("--workflow-artifacts");
        return start;
    }

    public static async Task<ManagedToolResult> RunAsync(ProcessStartInfo start, byte[]? payload, TimeSpan timeout)
    {
        using var process = Process.Start(start) ?? throw new IOException("无法启动本机 Python。");
        async Task<(string Text, bool Overflow)> ReadLimited(StreamReader reader, int limit)
        {
            var result = new StringBuilder(); var buffer = new char[4096]; bool overflow = false;
            int count;
            while ((count = await reader.ReadAsync(buffer)) != 0)
            {
                int keep = Math.Min(count, Math.Max(0, limit - result.Length));
                if (keep > 0) result.Append(buffer, 0, keep);
                if (keep < count) overflow = true;
            }
            return (result.ToString(), overflow);
        }
        async Task Send()
        {
            try
            {
                if (payload is not null) await process.StandardInput.BaseStream.WriteAsync(payload);
                process.StandardInput.Close();
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }
        var stdout = ReadLimited(process.StandardOutput, start.ArgumentList.LastOrDefault() == "--workflow-artifacts"
            ? 1536 * 1024 : MaxOutputChars);
        var stderr = ReadLimited(process.StandardError, MaxOutputChars);
        var input = Send();
        bool timedOut = false;
        try { await process.WaitForExitAsync().WaitAsync(timeout); }
        catch (TimeoutException)
        {
            timedOut = true;
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); } catch (TimeoutException) { }
        }
        try
        {
            await Task.WhenAll(stdout, stderr, input).WaitAsync(TimeSpan.FromSeconds(5));
            var output = await stdout; var errors = await stderr;
            if (timedOut || output.Overflow || errors.Overflow || !process.HasExited)
                return new(null, "", true);
            return new(process.ExitCode, output.Text, false);
        }
        catch (TimeoutException) { return new(null, "", true); }
        catch (IOException) { return new(null, "", true); }
    }

    public static string Describe(ManagedTaskAction action, ManagedToolResult result, Guid? expectedId = null)
    {
        const string unknown = "结果无法确认。请保留回执并查询原任务；不要创建新任务重试。";
        if (result.Uncertain) return unknown;
        if (action is ManagedTaskAction.Output or ManagedTaskAction.ErrorOutput)
            return result.ExitCode == 0 ? result.Output : "输出不可用；请先查询任务状态。";
        try
        {
            using var document = JsonDocument.Parse(result.Output);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return unknown;
            if (!root.TryGetProperty("task_id", out var idValue) || idValue.ValueKind != JsonValueKind.String ||
                !Guid.TryParse(idValue.GetString(), out var actualId) || (expectedId is not null && actualId != expectedId))
                return unknown;
            string suffix = $"\n任务 ID：{actualId:D}";
            if (action == ManagedTaskAction.Start)
            {
                string? outcome = root.TryGetProperty("outcome", out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
                if (result.ExitCode == 0 && outcome == "accepted") return "已接收启动请求，实际运行结果以状态查询为准。" + suffix;
                if (result.ExitCode == 3 && outcome == "already_exists") return "任务 ID 已存在；未再次启动。请查询原任务。" + suffix;
                return unknown + suffix;
            }
            string? state = root.TryGetProperty("state", out var status) && status.ValueKind == JsonValueKind.String ? status.GetString() : null;
            if (result.ExitCode != 0 && state != "unknown") return unknown + suffix;
            return state switch
            {
                "running" => "任务运行中（以本次查询为准）。" + suffix,
                "finished" when root.TryGetProperty("exit_code", out var exit) && exit.TryGetInt32(out var code) =>
                    $"直接启动的进程已退出，退出码：{code}。外部操作及子进程需另行确认。" + suffix,
                "launch_failed" => "直接进程未能启动；保留回执，不会自动重试。" + suffix,
                "not_found" => "未找到任务记录；不能据此认定没有执行。请检查服务器、用户和状态目录。" + suffix,
                _ => unknown + suffix
            };
        }
        catch (JsonException) { return unknown; }
        catch (InvalidOperationException) { return unknown; }
    }
}
