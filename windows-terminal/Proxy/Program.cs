using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using RemoteSsh;

try
{
    if (args.Length != 3 || !int.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out int proxyPort) ||
        proxyPort is < 1 or > 65535 || !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out int targetPort))
        throw new ArgumentException("Invalid SOCKS bridge parameters.");
    Connection.ValidateTarget(args[1], targetPort);
    using var socket = new TcpClient(AddressFamily.InterNetwork);
    await socket.ConnectAsync(IPAddress.Loopback, proxyPort).WaitAsync(TimeSpan.FromSeconds(8));
    using var stream = socket.GetStream();
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
    await stream.WriteAsync(new byte[] { 5, 1, 0 }, timeout.Token);
    byte[] answer = new byte[2];
    await stream.ReadExactlyAsync(answer, timeout.Token);
    if (answer[0] != 5 || answer[1] != 0) throw new IOException("SOCKS5 no-auth negotiation failed.");
    byte kind;
    byte[] host;
    if (IPAddress.TryParse(args[1], out var ip))
    {
        if (ip.AddressFamily == AddressFamily.InterNetworkV6 && ip.ScopeId != 0) throw new ArgumentException("Scoped address not supported.");
        kind = ip.AddressFamily == AddressFamily.InterNetwork ? (byte)1 : (byte)4;
        host = ip.GetAddressBytes();
    }
    else
    {
        kind = 3;
        var name = Encoding.ASCII.GetBytes(args[1]);
        if (name.Length is < 1 or > 253) throw new ArgumentException("Invalid host.");
        host = [(byte)name.Length, .. name];
    }
    byte[] request = [5, 1, 0, kind, .. host, (byte)(targetPort >> 8), (byte)targetPort];
    await stream.WriteAsync(request, timeout.Token);
    byte[] header = new byte[4];
    await stream.ReadExactlyAsync(header, timeout.Token);
    if (header[0] != 5 || header[1] != 0 || header[2] != 0) throw new IOException("SOCKS5 connection refused.");
    int size = header[3] switch { 1 => 4, 4 => 16, 3 => -1, _ => throw new IOException("Invalid SOCKS5 reply.") };
    if (size < 0)
    {
        byte[] length = new byte[1]; await stream.ReadExactlyAsync(length, timeout.Token); size = length[0];
    }
    await stream.ReadExactlyAsync(new byte[size + 2], timeout.Token);
    using var cancelled = new CancellationTokenSource();
    async Task Upload()
    {
        await Console.OpenStandardInput().CopyToAsync(stream, cancelled.Token);
        try { socket.Client.Shutdown(SocketShutdown.Send); } catch (SocketException) { }
    }
    var upload = Upload();
    var download = stream.CopyToAsync(Console.OpenStandardOutput(), cancelled.Token);
    if (await Task.WhenAny(upload, download) == upload)
    {
        await upload;
        await download;
    }
    else
    {
        await download;
        cancelled.Cancel();
        try { await upload.WaitAsync(TimeSpan.FromSeconds(2)); } catch (OperationCanceledException) { } catch (TimeoutException) { }
    }
    return 0;
}
catch (Exception ex) when (ex is ArgumentException or IOException or SocketException or TimeoutException or OperationCanceledException)
{
    Console.Error.WriteLine("SOCKS5 relay failed; no direct connection was attempted.");
    return 1;
}
