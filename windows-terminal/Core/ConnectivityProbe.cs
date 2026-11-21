using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace RemoteSsh;

public sealed record ConnectivitySample(IReadOnlyList<IPAddress> Resolved, IPAddress? Connected,
    long? ConnectMilliseconds, string? Error);

// A bounded TCP reachability sample, not an SSH login or a measurement of an
// established session. No target other than the supplied host and port is used.
public static class ConnectivityProbe
{
    public static async Task<IReadOnlyList<ConnectivitySample>> RunAsync(string host, int port,
        int count, TimeSpan timeout, TimeSpan interval, CancellationToken cancellationToken = default)
    {
        Connection.ValidateTarget(host, port);
        if (count is < 1 or > 10 || timeout <= TimeSpan.Zero || timeout > TimeSpan.FromSeconds(15) ||
            interval < TimeSpan.Zero || interval > TimeSpan.FromSeconds(30))
            throw new ArgumentOutOfRangeException(nameof(count), "无效的诊断参数。");

        var samples = new List<ConnectivitySample>();
        for (int index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (index > 0 && interval > TimeSpan.Zero) await Task.Delay(interval, cancellationToken);
            using var dnsDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            dnsDeadline.CancelAfter(timeout);
            IPAddress[] addresses;
            try
            {
                addresses = IPAddress.TryParse(host, out var literal) ? [literal] :
                    (await Dns.GetHostAddressesAsync(host, dnsDeadline.Token)).Distinct().Take(8).ToArray();
                if (addresses.Length == 0) { samples.Add(new([], null, null, "DNS 未返回地址")); continue; }
            }
            catch (SocketException) { samples.Add(new([], null, null, "DNS 查询失败")); continue; }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            { samples.Add(new([], null, null, "DNS 查询超时")); continue; }

            samples.Add(await ProbeAddressesAsync(addresses, port, timeout, ConnectAsync, cancellationToken));
        }
        return samples;
    }

    // Stagger candidate connections so an unresponsive address cannot consume
    // the entire deadline before another address is attempted. Every socket is
    // disposed and pending attempts are cancelled when a result is selected.
    internal static async Task<ConnectivitySample> ProbeAddressesAsync(IReadOnlyList<IPAddress> addresses,
        int port, TimeSpan timeout, Func<IPAddress, int, CancellationToken, Task> connect,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        var stagger = TimeSpan.FromMilliseconds(Math.Min(250, timeout.TotalMilliseconds / Math.Max(2, addresses.Count * 2)));
        async Task<(IPAddress Address, long? Elapsed, bool TimedOut)> Attempt(IPAddress address, int index)
        {
            try
            {
                if (index > 0) await Task.Delay(stagger * index, deadline.Token);
                var watch = Stopwatch.StartNew();
                await connect(address, port, deadline.Token);
                return (address, watch.ElapsedMilliseconds, false);
            }
            catch (SocketException) { return (address, null, false); }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            { return (address, null, true); }
        }

        var attempts = addresses.Select((address, index) => Attempt(address, index)).ToArray();
        var pending = attempts.ToList();
        bool timedOut = false;
        try
        {
            while (pending.Count > 0)
            {
                var finished = await Task.WhenAny(pending);
                pending.Remove(finished);
                var attempt = await finished;
                cancellationToken.ThrowIfCancellationRequested();
                if (attempt.Elapsed is not null)
                    return new(addresses, attempt.Address, attempt.Elapsed, null);
                timedOut |= attempt.TimedOut;
            }
            return new(addresses, null, null, timedOut ? "TCP 连接超时" : "TCP 连接失败");
        }
        finally
        {
            deadline.Cancel();
            try { await Task.WhenAll(attempts); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        }
    }

    private static async Task ConnectAsync(IPAddress address, int port, CancellationToken cancellationToken)
    {
        using var client = new TcpClient(address.AddressFamily);
        await client.ConnectAsync(address, port, cancellationToken);
    }
}
