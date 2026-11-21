using System.Text.Json;
using RemoteSsh;

// Test-only harness. The Python fixture supplies an ephemeral loopback SSH
// server, pinned test key, and disposable Linux state directory.
if (args.Length != 1) throw new ArgumentException("Expected one test fixture configuration path.");
using var fixture = JsonDocument.Parse(File.ReadAllText(args[0]));
var f = fixture.RootElement;
string Text(string name) => f.GetProperty(name).GetString() ?? throw new ArgumentException("Missing fixture field");
var connection = new Connection(Text("host"), f.GetProperty("port").GetInt32(), "loopback", Authentication.Key,
    Text("identity"), Text("known"));
string receipt = Text("receipt"), root = Text("state_root"), app = Text("app"), python = Text("python");
string sideEffect = Text("side_effect");
string code = "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); " +
              "p.open('a',encoding='utf-8').write('once\\n'); time.sleep(2); " +
              "print('managed-stdout'); print('managed-stderr',file=sys.stderr)";
var request = new ManagedTaskRequest(["/usr/bin/python3", "-c", code, sideEffect], "/tmp", true);
byte[] payload = ManagedTask.EncodeRequest(request);
Guid id = ManagedTask.ReserveReceipt(connection, receipt, root);
var start = ManagedTask.Build(connection, receipt, root, ManagedTaskAction.Start, id, app, python);
var result = await ManagedTask.RunAsync(start, payload, TimeSpan.FromSeconds(30));
if (result.ExitCode != 2 || !ManagedTask.Describe(ManagedTaskAction.Start, result, id).Contains("无法确认"))
    throw new Exception("Lost acknowledgement did not remain uncertain.");
Console.WriteLine("PASS: lost start acknowledgement remains unknown");
if (f.TryGetProperty("prepare_only", out var prepare) && prepare.ValueKind == JsonValueKind.True)
{
    Console.WriteLine("PASS: prepared original receipt for manager GUI recovery");
    return;
}
try { ManagedTask.ReserveReceipt(connection, receipt, root); throw new Exception("Receipt was reused"); }
catch (IOException) { Console.WriteLine("PASS: existing receipt cannot start a new operation"); }
bool completed = false;
for (int attempt = 0; attempt < 20; attempt++)
{
    var status = ManagedTask.Build(connection, receipt, root, ManagedTaskAction.Status, null, app, python);
    var query = await ManagedTask.RunAsync(status, null, TimeSpan.FromSeconds(55));
    if (query.ExitCode == 0)
    {
        using var json = JsonDocument.Parse(query.Output);
        var record = json.RootElement;
        if (record.GetProperty("task_id").GetString() != id.ToString("D")) throw new Exception("Task ID changed");
        if (record.GetProperty("state").GetString() == "finished")
        {
            if (record.GetProperty("exit_code").GetInt32() != 0) throw new Exception("Task failed");
            completed = true; break;
        }
    }
    await Task.Delay(1000);
}
if (!completed) throw new Exception("Task did not finish during the test");
Console.WriteLine("PASS: fresh SSH query finds the original completed task");
foreach (var pair in new[] { (ManagedTaskAction.Output, "managed-stdout"), (ManagedTaskAction.ErrorOutput, "managed-stderr") })
{
    var info = ManagedTask.Build(connection, receipt, root, pair.Item1, null, app, python);
    var captured = await ManagedTask.RunAsync(info, null, TimeSpan.FromSeconds(25));
    if (captured.ExitCode != 0 || captured.Output.Trim() != pair.Item2) throw new Exception("Captured stream did not match");
}
Console.WriteLine("PASS: standard output and standard error are separate");
