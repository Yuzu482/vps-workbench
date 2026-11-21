using System.Text;
using TerminalBridge.Bridge;
using TerminalBridge.PtyCore;
using RemoteSsh;

// Test-only harness: two fixed executables, no arbitrary command injection API.
string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../.."));
string executable;
string[] arguments;
if (args.Length == 2 && args[0] == "console")
{
    var connection = ConnectionCodec.Decode(args[1]);
    if (connection.Host != "127.0.0.1") return 2;
    executable = Path.Combine(root, "artifacts/app/RemoteSsh.Console.exe");
    arguments = ["--connection", args[1]];
}
else if (args.Length == 1 && args[0] == "fixture")
{
    executable = Path.Combine(root, "TestFixture/bin/Release/net10.0-windows/TestFixture.exe");
    arguments = [];
}
else return 2;
using var pty = ConPty.Start(executable, string.Join(" ", new[] { executable }.Concat(arguments).Select(Quote)), 100, 30);
Console.Error.WriteLine("TEST_CHILD_PID=" + pty.ProcessId);
return await Session.RunAsync(pty, Console.OpenStandardInput(), TerminalBridge.Bridge.Program.RawOutput());

static string Quote(string text)
{
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char ch in text)
    {
        if (ch == '\\') { slashes++; continue; }
        result.Append('\\', slashes * (ch == '"' ? 2 : 1) + (ch == '"' ? 1 : 0)); result.Append(ch); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
}
