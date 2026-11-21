using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RemoteSsh;

public sealed record ChatAttachment(string DisplayName, string RemoteName, byte[] Content, string Sha256, bool Image)
{
    public long Size => Content.LongLength;
}

public static class ChatAttachments
{
    public const int MaxFileBytes = 5 * 1024 * 1024;
    public const int MaxTotalBytes = 20 * 1024 * 1024;

    public static ChatAttachment Read(string path, int index)
    {
        if (index is < 1 or > 4 || !Path.IsPathFullyQualified(path)) throw new ArgumentException("附件路径无效。");
        var info = new FileInfo(path);
        if (!info.Exists || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || info.Length > MaxFileBytes)
            throw new ArgumentException("附件必须是普通文件，单个文件不超过 5 MiB。");
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (file.Length > MaxFileBytes) throw new ArgumentException("附件过大。");
        using var data = new MemoryStream(); byte[] buffer = new byte[65536]; int part;
        while ((part = file.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (data.Length + part > MaxFileBytes) throw new ArgumentException("附件过大。");
            data.Write(buffer, 0, part);
        }
        byte[] bytes = data.ToArray();
        string ext = Path.GetExtension(info.Name).ToLowerInvariant();
        if (ext.Length > 11 || ext.Length < 2 || !ext[1..].All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9')) ext = "";
        bool image = ext switch
        {
            ".png" => bytes.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }),
            ".jpg" or ".jpeg" => bytes.AsSpan().StartsWith(new byte[] { 0xff, 0xd8, 0xff }),
            ".webp" => bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8),
            _ => false
        };
        if ((ext is ".png" or ".jpg" or ".jpeg" or ".webp") && !image)
            throw new ArgumentException("图片内容与文件扩展名不匹配。");
        string display = new(info.Name.Where(c => !char.IsControl(c)).Take(160).ToArray());
        if (display.Length == 0) display = "附件";
        return new(display, "f" + index + ext, bytes, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), image);
    }

    public static byte[] Encode(IReadOnlyList<ChatAttachment> attachments)
    {
        if (attachments.Count is < 1 or > 4 || attachments.Sum(a => a.Size) > MaxTotalBytes)
            throw new ArgumentException("每轮最多 4 个附件、合计 20 MiB。");
        for (int i = 0; i < attachments.Count; i++)
        {
            var item = attachments[i];
            if (item.Size > MaxFileBytes || !Regex.IsMatch(item.RemoteName, @"\Af" + (i + 1) + @"(?:\.[a-z0-9]{1,10})?\z", RegexOptions.CultureInvariant) ||
                item.Sha256 != Convert.ToHexString(SHA256.HashData(item.Content)).ToLowerInvariant())
                throw new ArgumentException("附件内容无效。");
        }
        byte[] header = JsonSerializer.SerializeToUtf8Bytes(new { files = attachments.Select(a => new { name = a.RemoteName, size = a.Size, sha256 = a.Sha256 }) },
            new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        if (header.Length > 8192) throw new ArgumentException("附件信息过大。");
        using var result = new MemoryStream(); Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(length, header.Length); result.Write(length); result.Write(header);
        foreach (var item in attachments) result.Write(item.Content);
        return result.ToArray();
    }

    public static System.Diagnostics.ProcessStartInfo BuildUpload(Connection connection, Guid conversation, Guid turn, string appDirectory)
    {
        if (connection.Authentication != Authentication.Key) throw new ArgumentException("附件传输需要 SSH 私钥认证。");
        byte[] source = File.ReadAllBytes(Path.Combine(appDirectory, "RemoteChatFiles.py"));
        if (source.Length is 0 or > 12000) throw new ArgumentException("附件传输程序大小无效。");
        using var compressed = new MemoryStream();
        using (var z = new ZLibStream(compressed, CompressionLevel.SmallestSize, true)) z.Write(source);
        string encoded = Convert.ToBase64String(compressed.ToArray());
        string command = $"python3 -B -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode(\"{encoded}\")))' --session {conversation:D} --turn {turn:D}";
        var start = SshCommand.Build(connection);
        int tty = start.ArgumentList.IndexOf("-tt"), batch = start.ArgumentList.IndexOf("BatchMode=no");
        if (tty < 0 || batch < 0) throw new InvalidOperationException("SSH 配置无效。");
        start.ArgumentList[tty] = "-T"; start.ArgumentList[batch] = "BatchMode=yes";
        start.ArgumentList.Add(command);
        start.CreateNoWindow = true; start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.StandardOutputEncoding = new UTF8Encoding(false, false); start.StandardErrorEncoding = new UTF8Encoding(false, false);
        return start;
    }

    public static bool Confirmed(ManagedToolResult result, Guid conversation, Guid turn, IReadOnlyList<ChatAttachment> attachments)
    {
        if (result.Uncertain || result.ExitCode != 0) return false;
        try
        {
            using var doc = JsonDocument.Parse(result.Output); var root = doc.RootElement;
            if (root.GetProperty("outcome").GetString() != "staged" ||
                root.GetProperty("session").GetString() != conversation.ToString("D") ||
                root.GetProperty("turn").GetString() != turn.ToString("D")) return false;
            var files = root.GetProperty("files"); if (files.GetArrayLength() != attachments.Count) return false;
            int i = 0;
            foreach (var file in files.EnumerateArray())
            {
                var expected = attachments[i++];
                if (file.GetProperty("name").GetString() != expected.RemoteName ||
                    file.GetProperty("size").GetInt64() != expected.Size || file.GetProperty("sha256").GetString() != expected.Sha256) return false;
            }
            return true;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException) { return false; }
    }
}
