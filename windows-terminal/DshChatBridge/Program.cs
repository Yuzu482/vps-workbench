using System.ComponentModel;
using System.Text.Json;

namespace DshVpsChat;

internal static class Program
{
    private const int MaxRequestBytes = 128 * 1024;
    private const int MaxResponseBytes = 2 * 1024 * 1024;

    public static async Task Main(string[] args)
    {
        object response;
        try
        {
            if (args.Length != 1 || args[0].Length > 1024 || !Path.IsPathFullyQualified(args[0]))
                throw new BridgeError("storage_unavailable", "工作台记录目录不可用。");
            string stateRoot = Path.GetFullPath(args[0]);
            using var input = Console.OpenStandardInput();
            var bytes = BridgeProtocol.ReadBounded(input, DesignContext.MaxRequestBytes);
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
            var request = document.RootElement;
            if (BridgeProtocol.Text(request, "op") == "preset" && BridgeProtocol.HasFields(request, "op"))
            {
                if (bytes.Length > MaxRequestBytes)
                    throw new BridgeError("invalid_request", "输入内容超出大小限制。");
                response = ChatBridge.ReadPreset(stateRoot);
            }
            else
            {
                var parsed = BridgeProtocol.Parse(request);
                if (bytes.Length > MaxRequestBytes && parsed.Context is null && parsed.WorkflowFiles is null)
                    throw new BridgeError("invalid_request", "输入内容超出大小限制。");
                response = await new ChatBridge(stateRoot, parsed).Execute();
            }
        }
        catch (BridgeError ex)
        {
            response = new { ok = false, code = ex.Code, message = ex.Message };
        }
        catch (Exception ex) when (ex is JsonException or FormatException)
        {
            response = new { ok = false, code = "invalid_request", message = "工作台请求格式无效。" };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception
                                      or ArgumentException or InvalidOperationException)
        {
            response = new { ok = false, code = "storage_unavailable", message = "工作台暂时无法读取或保存本机记录。" };
        }

        byte[] result = JsonSerializer.SerializeToUtf8Bytes(response, BridgeProtocol.Json);
        if (result.Length > MaxResponseBytes)
            result = JsonSerializer.SerializeToUtf8Bytes(new
                { ok = false, code = "unknown", message = "返回内容超出限制。可以重新查看原对话。" }, BridgeProtocol.Json);
        using var output = Console.OpenStandardOutput();
        await output.WriteAsync(result);
    }
}
