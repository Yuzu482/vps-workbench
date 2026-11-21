using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using RemoteSsh;

Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);
int code = 1;
Process? child = null;
// Ctrl+C belongs to the SSH terminal while a child is running. Closing the
// terminal still closes the process job, terminating its SSH child.
ConsoleCancelEventHandler cancel = (_, e) => { if (child is not null) e.Cancel = true; };
Console.CancelKeyPress += cancel;
try
{
    if (args.Length < 2 || args.Length > 10 || args.Length % 2 != 0 || args[0] != "--connection")
        throw new ArgumentException("请从 Remote SSH 连接管理器启动，或使用有效的 --connection 配置参数。");
    var connection = ConnectionCodec.Decode(args[1]);
    var options = new Dictionary<string, string>(StringComparer.Ordinal);
    for (int index = 2; index < args.Length; index += 2)
        if (!new[] { "--privacy-ipv4", "--privacy-ipv6", "--socks-port", "--expected-ssh-source" }.Contains(args[index]) ||
            !options.TryAdd(args[index], args[index + 1])) throw new ArgumentException("隐私启动参数无效。");
    PrivacyOptions? privacy = null;
    if (options.Count > 0)
    {
        if (!options.TryGetValue("--privacy-ipv4", out var ipv4)) throw new ArgumentException("缺少预期 IPv4 出口。");
        int? port = null;
        if (options.TryGetValue("--socks-port", out var value))
        {
            if (!int.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parsed))
                throw new ArgumentException("SOCKS5 端口无效。");
            port = parsed;
        }
        privacy = new PrivacyOptions(ipv4, options.GetValueOrDefault("--privacy-ipv6"), port, options.GetValueOrDefault("--expected-ssh-source")).Validated();
    }
    var start = privacy is null ? SshCommand.Build(connection) : PrivacyCommand.BuildSsh(connection, privacy, AppContext.BaseDirectory);
    Console.WriteLine($"Remote SSH · {connection.User}@{connection.Host}:{connection.Port}");
    Console.WriteLine(privacy is null ? "正在连接。认证提示由 OpenSSH 显示；登录后进入远端项目目录并运行 codex。" :
        privacy.SocksPort is null ? "正在连接并检查远端代理、出口和路由。通过后才会启动 Codex。" :
        "正在通过本机 SOCKS5 中继连接；远端来源不匹配时不会启动 Codex。认证提示由 OpenSSH 显示。");
    using var job = new ChildProcessJob();
    child = Process.Start(start) ?? throw new IOException("OpenSSH 未能启动。");
    try { job.Add(child); }
    catch { if (!child.HasExited) child.Kill(entireProcessTree: true); throw; }
    await child.WaitForExitAsync();
    code = child.ExitCode;
    Console.WriteLine($"\nSSH 已退出，退出码 {code}。");
    if (code != 0)
    {
        Console.Error.WriteLine("请检查上方 OpenSSH 错误。主机密钥错误需重新核对指纹；Permission denied 请检查用户名和认证方式；连接超时请检查地址、端口和网络。");
        Console.Error.WriteLine("断线时最后的输入和远端任务状态可能未知；程序不会自动重发或重连。请在管理器重新打开终端后先检查远端状态。");
    }
}
catch (Exception ex) when (ex is ArgumentException or FormatException or System.Text.Json.JsonException or InvalidOperationException or IOException or UnauthorizedAccessException or Win32Exception)
{
    Console.Error.WriteLine("无法建立 SSH 会话：" + ex.Message);
}
finally
{
    if (child is not null)
    {
        try { if (!child.HasExited) child.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        child.Dispose(); child = null;
    }
    Console.CancelKeyPress -= cancel;
}
if (code != 0 && !Console.IsInputRedirected)
{
    Console.WriteLine("按任意键关闭此终端。");
    try { Console.ReadKey(intercept: true); } catch (InvalidOperationException) { }
}
return code;
