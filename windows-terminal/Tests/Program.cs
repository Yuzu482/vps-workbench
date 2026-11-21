using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using RemoteSsh;

if (args.SequenceEqual(new[] { "--check-desktop-dependencies" }))
{
    Console.WriteLine("Windows Terminal: " + WindowsTerminalLocator.ResolveCurrent());
    if (!File.Exists(SshCommand.Executable)) throw new Exception("System OpenSSH missing");
    Console.WriteLine("System OpenSSH: " + SshCommand.Executable);
    return;
}

int passed = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception(name); passed++; }
void Reject(Action action, string name)
{
    try { action(); } catch (Exception ex) when (ex is ArgumentException or FormatException or System.Text.Json.JsonException or IOException) { passed++; return; }
    throw new Exception("Accepted invalid input: " + name);
}
var connection = new Connection("example.test", 2222, "domain\\alice", Authentication.Key,
    @"C:\keys with spaces\中文;key", @"C:\keys with spaces\中文;known_hosts");
var token = ConnectionCodec.Encode(connection);
Check(ConnectionCodec.Decode(token) == connection, "Unicode/space/semicolon profile roundtrip");
Check(!token.Contains(';') && !token.Contains(' ') && !token.Contains('"'), "single WT-safe argument");
Reject(() => ConnectionCodec.Decode(token + ";new-tab"), "WT separator");
Reject(() => ConnectionCodec.FromJson(ConnectionCodec.ToJson(connection).Replace("\"Host\":", "\"Host\":\"other\",\"Host\":")), "duplicate JSON");
Reject(() => ConnectionCodec.FromJson(ConnectionCodec.ToJson(connection).Replace("\"Host\":", "\"Unknown\":0,\"Host\":")), "unknown JSON");
foreach (string host in new[] { "-oProxyCommand=x", "host;bad", "host\nother", "a..b", "a b" })
    Reject(() => (connection with { Host = host }).Validate(false), "host");
foreach (string path in new[] { "relative", @"C:\key%h", @"C:\keys\..\key", @"C:\key:stream", @"C:\keys\${USER}" })
    Reject(() => (connection with { IdentityPath = path }).Validate(false), "path");
Check(ConnectionCodec.Decode(ConnectionCodec.Encode(connection with { Host = "::1" })).Host == "::1", "IPv6");
var ssh = SshCommand.Build(connection, false);
Check(ssh.ArgumentList.Last() == connection.Host && !ssh.ArgumentList.Contains("codex") && !ssh.ArgumentList.Contains("claude"), "shell only, no remote command");
Check(ssh.ArgumentList.Contains("BatchMode=no") && ssh.ArgumentList.Contains("PreferredAuthentications=publickey"), "key passphrase prompts");
Check(ssh.ArgumentList.Contains("StrictHostKeyChecking=yes") && ssh.ArgumentList.Contains("UpdateHostKeys=no"), "pinned trust");
Check(ssh.ArgumentList.Contains("IdentityAgent=none") && ssh.ArgumentList.Contains("ForwardAgent=no") && ssh.ArgumentList.Contains("ClearAllForwardings=yes"), "isolated SSH");
Check(ssh.ArgumentList.Contains("ServerAliveInterval=30") && ssh.ArgumentList.Contains("ServerAliveCountMax=3"), "SSH keepalive policy");
var password = SshCommand.Build(connection with { Authentication = Authentication.Password, IdentityPath = "" }, false);
Check(password.ArgumentList.Contains("PubkeyAuthentication=no") && password.ArgumentList.Contains("PasswordAuthentication=yes"), "password mode");
string helperRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
var privacyOptions = new PrivacyOptions("203.0.113.4", null);
var protectedSsh = PrivacyCommand.BuildSsh(connection, privacyOptions, helperRoot, false);
Check(protectedSsh.ArgumentList[^2] == connection.Host && protectedSsh.ArgumentList[^1].Contains("--expected-ipv4 203.0.113.4"), "privacy SSH fixed command");
var relayOptions = new PrivacyOptions("203.0.113.4", null, 7897, "198.51.100.8");
var relaySsh = PrivacyCommand.BuildSsh(connection, relayOptions, helperRoot, false);
Check(relaySsh.ArgumentList.Count(arg => arg.StartsWith("ProxyCommand=", StringComparison.Ordinal)) == 1 &&
      relaySsh.ArgumentList.Any(arg => arg.Contains("RemoteSsh.Proxy.exe\" 7897 example.test 2222", StringComparison.Ordinal)) &&
      relaySsh.ArgumentList[^1].Contains("--expected-ssh-source 198.51.100.8", StringComparison.Ordinal), "relay uses only the configured SOCKS bridge and expected remote peer");
Reject(() => new PrivacyOptions("203.0.113.4", null, 7897, null).Validated(), "relay source required");
Reject(() => new PrivacyOptions("203.0.113.4", null, 7897, "198.51.100.8;bad").Validated(), "relay source injection");
Reject(() => SshCommand.Build(connection, false, new SshCommand.SocksRelay(7897, @"C:\bad&dir\RemoteSsh.Proxy.exe")), "relay path shell metacharacter");
Reject(() => SshCommand.Build(connection with { Host = "fe80::1%1" }, false, new SshCommand.SocksRelay(7897, @"C:\safe\RemoteSsh.Proxy.exe")), "relay host percent expansion");
Reject(() => PrivacyCommand.WrapManaged(["codex"], relayOptions, helperRoot), "managed relay unsupported");
Reject(() => PrivacyCommand.BuildSsh(connection, new PrivacyOptions("203.0.113.4;bad", null), helperRoot, false), "privacy argument injection");
Reject(() => new PrivacyOptions("203.0.113.4", "fe80::1%4").Validated(), "scoped IPv6");
var wrapped = PrivacyCommand.WrapManaged(["/home/user/.local/bin/codex", "exec", "test"], privacyOptions, helperRoot);
Check(wrapped[0] == "python3" && wrapped[3].Length <= 8192 && wrapped[^3].EndsWith("/codex") && wrapped[^1] == "test", "managed privacy wraps original argv");
var compressedMatch = Regex.Match(wrapped[3], @"b64decode\('([A-Za-z0-9+/=]+)'\)");
using (var compressed = new MemoryStream(Convert.FromBase64String(compressedMatch.Groups[1].Value)))
using (var zlib = new ZLibStream(compressed, CompressionMode.Decompress))
using (var restored = new MemoryStream())
{
    zlib.CopyTo(restored);
    Check(compressedMatch.Success && restored.ToArray().SequenceEqual(File.ReadAllBytes(Path.Combine(helperRoot, "RemoteCodexPrivacy.py"))), "managed privacy wrapper carries the exact helper");
}
Check(ManagedTask.EncodeRequest(new ManagedTaskRequest(wrapped, "/tmp", true)).Length < 16384, "managed privacy payload fits existing limits");
var isolationWrapped = PrivacyCommand.WrapManaged(["/home/user/.local/bin/codex", "exec", "test"], privacyOptions, helperRoot, "/tmp/project");
int isolationIndex = Array.IndexOf(isolationWrapped, "--isolation-code");
Check(isolationIndex > 0 && isolationWrapped[isolationIndex + 1].Length <= 12288 && isolationWrapped.Contains("--isolation-workspace"), "isolated task carries bounded helper and workspace");
using (var compressed = new MemoryStream(Convert.FromBase64String(isolationWrapped[isolationIndex + 1])))
using (var zlib = new ZLibStream(compressed, CompressionMode.Decompress))
using (var restored = new MemoryStream())
{
    zlib.CopyTo(restored);
    Check(restored.ToArray().SequenceEqual(File.ReadAllBytes(Path.Combine(helperRoot, "RemoteCodexIsolate.py"))), "isolated task carries exact sandbox helper");
}
Check(ManagedTask.EncodeRequest(new ManagedTaskRequest(isolationWrapped, "/tmp/project", true)).Length < 32768, "isolated task fits bounded payload limit");
Reject(() => PrivacyCommand.WrapManaged(["codex", "exec"], privacyOptions, helperRoot, "relative"), "isolated workspace path");
Check(ManagedTask.EncodeRequest(new ManagedTaskRequest(["program", new string('x', 12288)], "/tmp", false)).Length < 32768, "bounded large argument accepted");
Reject(() => ManagedTask.EncodeRequest(new ManagedTaskRequest(["program", new string('x', 12289)], "/tmp", false)), "oversized managed argument");
Reject(() => ManagedTask.EncodeRequest(new ManagedTaskRequest(["program", new string('x', 12288), new string('x', 12288), new string('x', 12288)], "/tmp", false)), "oversized total payload");
Check(PrivacyCommand.IsDirectCodex("/home/user/.local/bin/codex") && !PrivacyCommand.IsDirectCodex("/usr/bin/python3"), "direct Codex detection");
var outerOnly = PrivacyCommand.UseOuterSandboxOnly(["/home/user/.local/bin/codex", "exec", "--json", "prompt"]);
Check(outerOnly.SequenceEqual(["/home/user/.local/bin/codex", "exec", "--sandbox", "danger-full-access", "--json", "prompt"]), "outer-only mode explicitly selects the Codex inner policy");
Reject(() => PrivacyCommand.UseOuterSandboxOnly(["codex", "exec", "--sandbox", "read-only", "prompt"]), "outer-only rejects a conflicting sandbox");
Reject(() => PrivacyCommand.UseOuterSandboxOnly(["codex", "exec", "--config=sandbox_mode='read-only'", "prompt"]), "outer-only rejects configuration overrides");
Reject(() => PrivacyCommand.UseOuterSandboxOnly(["codex", "exec", "--yolo", "prompt"]), "outer-only rejects combined approval bypass");
Reject(() => PrivacyCommand.UseOuterSandboxOnly(["python3", "exec", "prompt"]), "outer-only requires Codex");
var chatRequest = CodexChat.BuildRequest("-s 你好\n请检查", "/tmp/project", privacyOptions, false, helperRoot);
Check(chatRequest.CaptureOutput && chatRequest.WorkingDirectory == "/tmp/project" &&
      chatRequest.Command.TakeLast(4).SequenceEqual(["--sandbox", "read-only", "--", "-s 你好\n请检查"]), "chat uses one isolated read-only request and treats prompt as data");
var outerChat = CodexChat.BuildRequest("检查", "/tmp/project", privacyOptions, true, helperRoot);
Check(outerChat.Command.Contains("--isolation-code") && outerChat.Command.Contains("danger-full-access"), "chat outer-only still uses outer isolation");
Reject(() => CodexChat.BuildRequest(" ", "/tmp/project", privacyOptions, false, helperRoot), "blank chat prompt");
Reject(() => CodexChat.BuildRequest("检查", "relative", privacyOptions, false, helperRoot), "chat requires absolute project directory");
string events = "IPv4 出口：4/4 与预期一致\n" +
    "{\"type\":\"item.started\",\"item\":{\"id\":\"1\",\"type\":\"command_execution\",\"command\":\"echo hi\"}}\n" +
    "{\"type\":\"item.completed\",\"item\":{\"id\":\"1\",\"type\":\"command_execution\",\"command\":\"echo hi\",\"status\":\"failed\",\"exit_code\":1,\"aggregated_output\":\"denied\"}}\n" +
    "{\"type\":\"item.completed\",\"item\":{\"id\":\"2\",\"type\":\"agent_message\",\"text\":\"已检查\"}}\n" +
    "{\"type\":\"item.completed\",\"item\":";
var rendered = CodexChat.ParseOutput(events, false);
Check(rendered.Count(item => item.Kind == ChatItemKind.Command) == 1 && rendered.Any(item => item.Title.Contains("失败") && item.Text.Contains("denied")), "chat collapses command updates and preserves failures");
Check(rendered.Any(item => item.Kind == ChatItemKind.Assistant && item.Text == "已检查"), "chat displays completed assistant output");
Check(CodexChat.ParseOutput(events, false).SequenceEqual(rendered), "repeated output snapshots do not duplicate messages");
Guid conversationId = Guid.NewGuid(), turnId = Guid.NewGuid(), nativeId = Guid.NewGuid();
var image = new ChatAttachment("图.png", "f1.png", [137, 80, 78, 71, 13, 10, 26, 10], "", true);
image = image with { Sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(image.Content)).ToLowerInvariant() };
var firstTurn = ChatBackends.Build("codex", "第一轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [image]);
var nextTurn = ChatBackends.Build("codex", "-s 第二轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, Guid.NewGuid(), nativeId, []);
Check(firstTurn.Command.Contains("--chat-session") && firstTurn.Command.Contains("--chat-turn") &&
      firstTurn.Command.Any(x => x.StartsWith("--image=/attachments/")) && !firstTurn.Command.Contains("--ephemeral"), "Codex first turn persists native session with image");
Check(nextTurn.Command.Contains("resume") && nextTurn.Command.Contains(nativeId.ToString("D")) && nextTurn.Command.TakeLast(2).SequenceEqual(["--", "-s 第二轮"]), "Codex resume uses observed thread and literal prompt");
string completedCodex = $"{{\"type\":\"thread.started\",\"thread_id\":\"{nativeId:D}\"}}\n{{\"type\":\"turn.completed\"}}\n";
Check(ChatBackends.Completed("codex", completedCodex, true, 0, false) == nativeId &&
      ChatBackends.Completed("codex", completedCodex, true, 0, false, Guid.NewGuid()) is null &&
      ChatBackends.Completed("codex", completedCodex, true, 0, true) is null &&
      ChatBackends.Completed("codex", completedCodex.Replace("turn.completed", "turn.failed"), true, 0, false) is null, "Codex continuation requires matching complete untruncated native events");
var claudeFirst = ChatBackends.Build("claude", "第一轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [image]);
var claudeNext = ChatBackends.Build("claude", "第二轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, Guid.NewGuid(), conversationId, []);
var subscriptionTurn = ChatBackends.Build("claude", "订阅第一轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], "subscription");
Guid sharedSourceId = Guid.NewGuid();
var sharedTurn = ChatBackends.Build("claude", "共享账号第一轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], "subscription", sharedSourceId);
var nativeCodex = ChatBackends.Build("codex", "第一轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], nativeProfile: true);
var nativeClaude = ChatBackends.Build("claude", "第一轮", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], "subscription", nativeProfile: true);
foreach (var nativeRequest in new[] { nativeCodex, nativeClaude })
{
    int nativeIndex = Array.IndexOf(nativeRequest.Command, "--isolation-code");
    using var compressed = new MemoryStream(Convert.FromBase64String(nativeRequest.Command[nativeIndex + 1]));
    using var zlib = new ZLibStream(compressed, CompressionMode.Decompress);
    using var restored = new MemoryStream(); zlib.CopyTo(restored);
    byte[] expected = File.ReadAllBytes(Path.Combine(helperRoot, "RemoteCodexIsolate.py")).Concat([(byte)'\n']).Concat(File.ReadAllBytes(Path.Combine(helperRoot, "RemoteNativeSafety.py"))).Concat([(byte)'\n']).Concat(File.ReadAllBytes(Path.Combine(helperRoot, "RemoteNativeSession.py"))).ToArray();
    Check(restored.ToArray().SequenceEqual(expected) && !nativeRequest.Command.Contains("--chat-auth-source"), "native conversation uses the bounded common profile without account-source mapping");
}
Reject(() => ChatBackends.Build("claude", "x", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], "api_key", nativeProfile: true), "native Claude profile requires native subscription login");
Reject(() => ChatBackends.Build("claude", "x", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], "subscription", sharedSourceId, true), "native profile cannot select a legacy account source");
Check(sharedTurn.Command.Contains("--chat-auth-source") && sharedTurn.Command.Contains(sharedSourceId.ToString("D")) &&
      sharedTurn.Command.Contains("--session-id") && sharedTurn.Command.Contains(conversationId.ToString("D")), "shared account keeps a distinct native session ID");
int sharedIsolation = Array.IndexOf(sharedTurn.Command, "--isolation-code");
using (var compressed = new MemoryStream(Convert.FromBase64String(sharedTurn.Command[sharedIsolation + 1])))
using (var zlib = new ZLibStream(compressed, CompressionMode.Decompress))
using (var restored = new MemoryStream())
{
    zlib.CopyTo(restored);
    byte[] expected = File.ReadAllBytes(Path.Combine(helperRoot, "RemoteClaudeShared.py")).Concat([(byte)'\n']).Concat(File.ReadAllBytes(Path.Combine(helperRoot, "RemoteCodexIsolate.py"))).ToArray();
    Check(restored.ToArray().SequenceEqual(expected), "subscription isolation carries the exact shared guard");
}
Reject(() => ChatBackends.Build("claude", "x", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], "subscription", conversationId), "account source cannot equal its child");
Reject(() => ChatBackends.Build("codex", "x", "/tmp/project", privacyOptions, false, helperRoot, conversationId, turnId, null, [], "api_key", sharedSourceId), "Codex cannot accept a Claude account source");
Check(subscriptionTurn.Command.Contains("claude-subscription") && subscriptionTurn.Command.Contains("--chat-auth") &&
      subscriptionTurn.Command.Contains("subscription") && !claudeFirst.Command.Contains("--chat-auth"), "Claude subscription has an explicit isolated provider and leaves API-key mode unchanged");
Check(ClaudeSubscription.Status(new ManagedToolResult(0, $"{{\"session\":\"{conversationId:D}\",\"status\":\"ready\"}}", false), conversationId) == "ready" &&
      ClaudeSubscription.Status(new ManagedToolResult(0, $"{{\"session\":\"{conversationId:D}\",\"status\":\"wrong_auth\"}}", false), conversationId) == "wrong_auth" &&
      ClaudeSubscription.Status(new ManagedToolResult(0, $"{{\"session\":\"{conversationId:D}\",\"status\":\"wrong_profile\"}}", false), conversationId) == "wrong_profile" &&
      ClaudeSubscription.Status(new ManagedToolResult(0, $"{{\"session\":\"{conversationId:D}\",\"status\":\"ready\",\"email\":\"private\"}}", false), conversationId) == "unavailable" &&
      ClaudeSubscription.Status(new ManagedToolResult(null, "", true), conversationId) == "unavailable", "subscription status accepts only a bounded, matching sanitized response");
Check(ClaudeSubscription.LoginCommand(conversationId).Contains("env -i") && !ClaudeSubscription.LoginCommand(conversationId).Contains("token"), "native login command contains no credential");
Check(claudeFirst.Command.Contains("--provider") && claudeFirst.Command.Contains("claude") && claudeFirst.Command.Contains("--chat-image") &&
      claudeFirst.Command.Contains("--session-id") && claudeFirst.Command.Contains("Read,Glob,Grep") && !claudeFirst.Command.Contains("--dangerously-skip-permissions"), "Claude uses isolated native image and read-only tools");
Check(claudeNext.Command.Contains("--resume") && claudeNext.Command.Contains(conversationId.ToString("D")), "Claude resumes its own session");
string completedClaude = $"{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{conversationId:D}\"}}\n" +
    $"{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"{conversationId:D}\",\"result\":\"答复\"}}\n";
Check(ChatBackends.Completed("claude", completedClaude, true, 0, false, conversationId) == conversationId &&
      ChatBackends.Completed("claude", completedClaude.Replace("\"is_error\":false", "\"is_error\":true"), true, 0, false) is null &&
      ChatBackends.Parse("claude", completedClaude, true).Any(x => x.Kind == ChatItemKind.Assistant && x.Text == "答复"), "Claude result and session identity are validated");
Check(ChatAttachments.Encode([image]).Length > image.Content.Length, "attachment payload frames metadata and bytes");
// Ask the actual system SSH parser to validate effective settings without a connection.
ssh.ArgumentList.Insert(0, "-G"); ssh.RedirectStandardOutput = true; ssh.RedirectStandardError = true;
// Windows OpenSSH writes UTF-8 to redirected pipes even when the parent is
// Windows PowerShell / CMD on code page 936. Never use the console's code page
// to decode the SSH parser output (it corrupts paths containing Chinese).
ssh.StandardOutputEncoding = new UTF8Encoding(false, true);
ssh.StandardErrorEncoding = new UTF8Encoding(false, true);
using (var probe = Process.Start(ssh)!)
{
    var output = await probe.StandardOutput.ReadToEndAsync(); var errors = await probe.StandardError.ReadToEndAsync();
    await probe.WaitForExitAsync();
    Check(probe.ExitCode == 0, "ssh -G parse: " + errors);
    Check(output.Contains("userknownhostsfile C:/keys with spaces/中文;known_hosts", StringComparison.Ordinal), "quoted OpenSSH path");
    Check(output.Contains("batchmode no") && output.Contains("stricthostkeychecking true") && output.Contains("requesttty force"), "effective interactive SSH settings");
    Check(output.Contains("serveraliveinterval 30") && output.Contains("serveralivecountmax 3"), "effective SSH keepalive policy");
}
// These are actual loopback sockets; TCP success is deliberately not called SSH authentication.
using (var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0))
{
    listener.Start();
    var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
    var samples = await ConnectivityProbe.RunAsync("127.0.0.1", port, 2, TimeSpan.FromSeconds(2), TimeSpan.Zero);
    Check(samples.Count == 2 && samples.All(sample => sample.Connected?.Equals(System.Net.IPAddress.Loopback) == true && sample.ConnectMilliseconds is >= 0), "TCP loopback probe success");
    var resolved = await ConnectivityProbe.RunAsync("localhost", port, 1, TimeSpan.FromSeconds(3), TimeSpan.Zero);
    Check(resolved[0].Resolved.Contains(System.Net.IPAddress.Loopback) && resolved[0].Connected?.Equals(System.Net.IPAddress.Loopback) == true, "DNS resolution and address fallback");
    listener.Stop();
    var failed = await ConnectivityProbe.RunAsync("127.0.0.1", port, 1, TimeSpan.FromSeconds(2), TimeSpan.Zero);
    Check(failed.Count == 1 && failed[0].Connected is null && failed[0].Error is not null, "TCP refusal reported");
}
using (var cancelled = new CancellationTokenSource())
{
    cancelled.Cancel();
    try { await ConnectivityProbe.RunAsync("127.0.0.1", 22, 1, TimeSpan.FromSeconds(1), TimeSpan.Zero, cancelled.Token); throw new Exception("Probe ignored cancellation"); }
    catch (OperationCanceledException) { passed++; }
}
// A stalled first address must not prevent a reachable later address from being
// tested. The delegate simulates the network deterministically without traffic.
var stalledAddress = System.Net.IPAddress.Parse("2001:db8::1");
var reachableAddress = System.Net.IPAddress.Loopback;
int stalledAttemptFinished = 0;
var fallback = await ConnectivityProbe.ProbeAddressesAsync([stalledAddress, reachableAddress], 22,
    TimeSpan.FromSeconds(2), async (address, _, cancellationToken) =>
    {
        if (address.Equals(stalledAddress))
        {
            try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); }
            finally { Interlocked.Exchange(ref stalledAttemptFinished, 1); }
        }
        else await Task.Delay(10, cancellationToken);
    });
Check(fallback.Connected?.Equals(reachableAddress) == true && fallback.Error is null,
    "stalled first address does not block reachable fallback");
Check(stalledAttemptFinished == 1, "successful fallback cancels and drains other attempts");
var refusals = await ConnectivityProbe.ProbeAddressesAsync([stalledAddress, reachableAddress], 22,
    TimeSpan.FromSeconds(1), (_, _, _) => Task.FromException(new System.Net.Sockets.SocketException(
        (int)System.Net.Sockets.SocketError.ConnectionRefused)));
Check(refusals.Connected is null && refusals.Error == "TCP 连接失败", "all refusals are reported");
var timeouts = await ConnectivityProbe.ProbeAddressesAsync([stalledAddress, reachableAddress], 22,
    TimeSpan.FromMilliseconds(200), (_, _, cancellationToken) => Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken));
Check(timeouts.Connected is null && timeouts.Error == "TCP 连接超时", "stalled attempts time out");
using (var activeCancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(80)))
{
    try
    {
        await ConnectivityProbe.ProbeAddressesAsync([stalledAddress, reachableAddress], 22,
            TimeSpan.FromSeconds(2), (_, _, cancellationToken) => Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken), activeCancellation.Token);
        throw new Exception("Active probe ignored cancellation");
    }
    catch (OperationCanceledException) when (activeCancellation.IsCancellationRequested) { passed++; }
}
// Exercise the GUI task client against a closed loopback port. No real remote
// operation is sent, and the receipt must survive an uncertain result.
string taskTemp = Path.Combine(Path.GetTempPath(), "remote-manager-task-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(taskTemp);
try
{
    string key = Path.Combine(taskTemp, "fixture-key"), known = Path.Combine(taskTemp, "fixture-known");
    File.WriteAllText(key, "test only"); File.WriteAllText(known, "test only");
    string receipt = Path.Combine(taskTemp, "receipt.json");
    var target = new Connection("127.0.0.1", 1, "fixture", Authentication.Key, key, known);
    var request = new ManagedTaskRequest(["fixture-program", "private-command-中文 ; $()"], "/tmp/test space", true);
    byte[] payload = ManagedTask.EncodeRequest(request);
    Guid taskId = ManagedTask.ReserveReceipt(target, receipt, "/tmp/task state");
    Check(ManagedTask.ReadReceipt(target, receipt) == new ManagedReceipt(taskId, "/tmp/task state"), "receipt restores original ID and state directory");
    Reject(() => ManagedTask.ReadReceipt(target with { Host = "other.test" }, receipt), "receipt target mismatch");
    string invalidReceipt = Path.Combine(taskTemp, "duplicate.json");
    File.WriteAllText(invalidReceipt, File.ReadAllText(receipt).Replace("\"version\":1", "\"version\":1,\"version\":1"));
    Reject(() => ManagedTask.ReadReceipt(target, invalidReceipt), "duplicate receipt fields");
    using (var stored = JsonDocument.Parse(File.ReadAllText(receipt)))
    {
        Check(stored.RootElement.GetProperty("task_id").GetString() == taskId.ToString("D") &&
              stored.RootElement.GetProperty("host").GetString() == target.Host &&
              !File.ReadAllText(receipt).Contains("private-command", StringComparison.Ordinal), "receipt persists target and ID, not command");
    }
    Reject(() => ManagedTask.ReserveReceipt(target, receipt, "/tmp/task state"), "existing receipt cannot launch again");
    Reject(() => ManagedTask.EncodeRequest(new ManagedTaskRequest([""], null, false)), "empty executable");
    Reject(() => ManagedTask.EncodeRequest(new ManagedTaskRequest(["tool"], "relative", false)), "relative remote directory");
    string sourceDirectory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
    string python = Path.GetFullPath(Path.Combine(sourceDirectory, "..", ".venv-ssh-loopback", "Scripts", "python.exe"));
    var startInfo = ManagedTask.Build(target, receipt, "/tmp/task state", ManagedTaskAction.Start, taskId, sourceDirectory, python);
    Check(startInfo.ArgumentList.Contains("--request-stdin") && !startInfo.ArgumentList.Any(x => x.Contains("private-command")) &&
          !startInfo.UseShellExecute, "command is sent through stdin without a shell or process argument");
    var statusInfo = ManagedTask.Build(target, receipt, "/tmp/task state", ManagedTaskAction.Status, null, sourceDirectory, python);
    Check(statusInfo.ArgumentList.Any(x => x.EndsWith("RemoteTaskStatus.py")) &&
          !statusInfo.ArgumentList.Contains("--request-stdin"), "reconnect uses status helper only");
    if (File.Exists(python))
    {
        var uncertain = await ManagedTask.RunAsync(startInfo, payload, TimeSpan.FromSeconds(25));
        Check(!uncertain.Uncertain && uncertain.ExitCode == 2 &&
              ManagedTask.Describe(ManagedTaskAction.Start, uncertain, taskId).Contains("无法确认") && File.Exists(receipt),
              "failed loopback start stays unknown and keeps the receipt");
        var statusResult = await ManagedTask.RunAsync(statusInfo, null, TimeSpan.FromSeconds(25));
        Check(statusResult.ExitCode == 2 && ManagedTask.Describe(ManagedTaskAction.Status, statusResult).Contains("无法确认"),
              "unreachable status remains unknown");
    }
    else Console.WriteLine("SKIP: managed helper subprocess checks require the local Python test environment");
    string finishedJson = $"{{\"task_id\":\"{taskId:D}\",\"state\":\"finished\",\"exit_code\":0}}";
    Check(ManagedTask.Describe(ManagedTaskAction.Status, new ManagedToolResult(0, finishedJson, false)).Contains("退出码：0"),
          "finished means a direct process exit");
    Check(ManagedTask.Describe(ManagedTaskAction.Start, new ManagedToolResult(0, "{invalid", false), taskId).Contains("无法确认"),
          "invalid start response never becomes success");
    string raced = Path.Combine(taskTemp, "race.json");
    int reserved = 0;
    Parallel.For(0, 8, _ =>
    {
        try { ManagedTask.ReserveReceipt(target, raced, null); Interlocked.Increment(ref reserved); }
        catch (IOException) { }
    });
    Check(reserved == 1, "concurrent windows cannot reserve the same receipt twice");
    Guid chatTask = Guid.NewGuid(), chatConversation = Guid.NewGuid();
    string chatReceipt = Path.Combine(taskTemp, "task-fixture.json");
    Check(ManagedTask.ReserveReceipt(target, chatReceipt, null, chatTask) == chatTask, "caller can reserve the validated turn ID");
    var conversation = new ChatConversationRecord { Id = chatConversation, Host = target.Host, Port = target.Port, User = target.User,
        Workspace = "/tmp/project", ExpectedIpv4 = "203.0.113.4", Turns = [new ChatTurnRecord { TaskId = chatTask, Receipt = "task-fixture.json", Prompt = "saved fixture", ThreadId = nativeId }] };
    using (var held = ChatStore.Lock(taskTemp, chatConversation))
    {
        ChatStore.Save(conversation, target, taskTemp);
        Check(ChatStore.Read(ChatStore.PathFor(taskTemp, chatConversation), target, taskTemp).Turns[0].ThreadId == nativeId, "conversation retains its original receipt and thread");
        Reject(() => ChatStore.Lock(taskTemp, chatConversation), "one local window owns a conversation");
    }
    string conversationPath = ChatStore.PathFor(taskTemp, chatConversation), originalConversation = File.ReadAllText(conversationPath);
    File.WriteAllText(conversationPath, originalConversation.Replace("\"ClaudeAuthMode\":\"api_key\",", ""));
    Check(ChatStore.Read(conversationPath, target, taskTemp).ClaudeAuthMode == "api_key" && !ChatStore.Read(conversationPath, target, taskTemp).NativeProfile,
          "old conversation records retain legacy execution and API-key defaults");
    File.WriteAllText(conversationPath, originalConversation);
    Guid draftId = Guid.NewGuid();
    var draft = new ChatConversationRecord { Id = draftId, Provider = "claude", ClaudeAuthMode = "subscription", Host = target.Host, Port = target.Port,
        User = target.User, Workspace = "/tmp/project", ExpectedIpv4 = "203.0.113.4" };
    ChatStore.Save(draft, target, taskTemp);
    Check(ChatStore.Read(ChatStore.PathFor(taskTemp, draftId), target, taskTemp).Turns.Count == 0, "subscription draft has no fabricated task receipt");
    Guid nativeDraftId = Guid.NewGuid();
    var nativeDraft = new ChatConversationRecord { Id = nativeDraftId, Provider = "claude", ClaudeAuthMode = "subscription", NativeProfile = true,
        Host = target.Host, Port = target.Port, User = target.User, Workspace = "/tmp/project", ExpectedIpv4 = "203.0.113.4" };
    ChatStore.Save(nativeDraft, target, taskTemp);
    Check(ChatStore.Read(ChatStore.PathFor(taskTemp, nativeDraftId), target, taskTemp).NativeProfile, "native profile flag survives reload");
    nativeDraft.ClaudeAccountSourceId = draftId;
    Reject(() => ChatStore.Save(nativeDraft, target, taskTemp), "native profile cannot be combined with legacy account source");
    Guid childId = Guid.NewGuid();
    var child = new ChatConversationRecord { Id = childId, Provider = "claude", ClaudeAuthMode = "subscription", ClaudeAccountSourceId = draftId,
        Host = target.Host, Port = target.Port, User = target.User, Workspace = "/tmp/project", ExpectedIpv4 = "203.0.113.4" };
    ChatStore.Save(child, target, taskTemp);
    Check(ClaudeSubscription.ValidateSource(ChatStore.Read(ChatStore.PathFor(taskTemp, childId), target, taskTemp), target, taskTemp) == draftId,
          "shared conversation resolves its original account on the same connection");
    var chained = new ChatConversationRecord { Id = Guid.NewGuid(), Provider = "claude", ClaudeAuthMode = "subscription", ClaudeAccountSourceId = childId,
        Host = target.Host, Port = target.Port, User = target.User, Workspace = "/tmp/project", ExpectedIpv4 = "203.0.113.4" };
    Reject(() => ClaudeSubscription.ValidateSource(chained, target, taskTemp), "shared account cannot chain through another child");
    child.ClaudeAccountSourceId = childId;
    Reject(() => ChatStore.Save(child, target, taskTemp), "shared account cannot point to itself");
    draft.Provider = "codex";
    Reject(() => ChatStore.Save(draft, target, taskTemp), "subscription mode cannot be used with Codex");
    File.WriteAllText(conversationPath, originalConversation.Replace("\"Version\":1", "\"Version\":1,\"Version\":1"));
    Reject(() => ChatStore.Read(conversationPath, target, taskTemp), "duplicate conversation fields");
    File.WriteAllText(conversationPath, originalConversation);
    Reject(() => ChatStore.Read(conversationPath, target with { Host = "other.test" }, taskTemp), "conversation target mismatch");
    var uploadInfo = ChatAttachments.BuildUpload(target, chatConversation, chatTask, sourceDirectory);
    Check(uploadInfo.ArgumentList.Contains("-T") && uploadInfo.ArgumentList.Contains("BatchMode=yes") && uploadInfo.ArgumentList.Contains("StrictHostKeyChecking=yes") &&
          !uploadInfo.ArgumentList.Any(x => x.Contains("saved fixture")), "attachment upload keeps pinned SSH and content out of argv");
    var authInfo = ClaudeSubscription.BuildStatus(target, childId, sourceDirectory, draftId);
    Check(authInfo.ArgumentList.Contains("-T") && authInfo.ArgumentList.Contains("BatchMode=yes") &&
          authInfo.ArgumentList.Contains("StrictHostKeyChecking=yes") && authInfo.ArgumentList[^1].EndsWith($" --session {childId:D} --source {draftId:D}"),
          "shared account status uses the pinned connection and original source ID");
    var nativeAuth = ClaudeSubscription.BuildStatus(target, nativeDraftId, sourceDirectory, nativeProfile: true);
    Check(nativeAuth.ArgumentList[^1].EndsWith($" --session {nativeDraftId:D} --native") && ClaudeSubscription.LoginCommand(nativeDraftId, true).StartsWith("env -i HOME=") &&
          ClaudeSubscription.LoginCommand(nativeDraftId, true).EndsWith("claude auth login"),
          "native status and login use the shared remote CLI account");
}
finally { Directory.Delete(taskTemp, recursive: true); }
Console.WriteLine($"PASS: {passed} configuration, task recovery and system OpenSSH assertions");
