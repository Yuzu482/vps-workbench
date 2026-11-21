using System.Text;
Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
Console.TreatControlCAsInput = true;
Console.Write("\x1b[32mLOCAL-SSH-READY\x1b[0m\r\n");
Console.WriteLine("这是本机 SSH 测试终端，不是 Codex。可输入中文后回车；keys 测试方向键；size 显示尺寸；quit 退出。");
string? mockState = MockStatePath();
if (mockState is not null && File.Exists(mockState)) Console.WriteLine("MOCK-SESSION-RESUMED");
while (true)
{
    Console.Write("demo> ");
    string line = ReadInputLine();
    if (line == "quit") return 0;
    if (line == "fail") return 23;
    if (line == "size") { Console.WriteLine($"MOCK-SIZE:{Console.WindowWidth}x{Console.WindowHeight}"); continue; }
    if (line == "/drop-test") { Console.WriteLine("MOCK-DROP-SSH-REQUEST"); continue; }
    if (line.StartsWith("/remember ", StringComparison.Ordinal))
    {
        string value = line[10..];
        if (mockState is null || value.Length is 0 or > 200) { Console.WriteLine("MOCK-MEMORY-UNAVAILABLE"); continue; }
        int count = 0;
        if (File.Exists(mockState) && new FileInfo(mockState).Length <= 1024)
        {
            string[] prior = File.ReadAllText(mockState).Split('\n', 2);
            if (prior.Length == 2) int.TryParse(prior[0], out count);
        }
        File.WriteAllText(mockState, $"{count + 1}\n{value}", new UTF8Encoding(false));
        Console.WriteLine($"MOCK-MEMORY-SAVED:{count + 1}");
        continue;
    }
    if (line == "/recall")
    {
        if (mockState is null || !File.Exists(mockState) || new FileInfo(mockState).Length > 1024)
            Console.WriteLine("MOCK-MEMORY-UNAVAILABLE");
        else
        {
            string[] saved = File.ReadAllText(mockState).Split('\n', 2);
            Console.WriteLine(saved.Length == 2 ? $"MOCK-MEMORY:{saved[1]}:COUNT={saved[0]}" : "MOCK-MEMORY-UNAVAILABLE");
        }
        continue;
    }
    if (line == "/privacy")
    {
        bool clean = !Environment.GetEnvironmentVariables().Keys.Cast<string>()
            .Any(name => name.StartsWith("SSH_", StringComparison.OrdinalIgnoreCase));
        Console.WriteLine("MOCK-SSH-ENV-CLEAN:" + clean.ToString().ToLowerInvariant());
        continue;
    }
    if (line == "keys")
    {
        Console.WriteLine("MOCK-PERMISSION: 允许 | 拒绝（模拟，不执行任何操作）");
        bool deny = false;
        while (true)
        {
            var key = Console.ReadKey(true);
            if (key.Key == ConsoleKey.RightArrow) { deny = true; Console.WriteLine("MOCK-SELECTION:DENY"); }
            else if (key.Key == ConsoleKey.LeftArrow) { deny = false; Console.WriteLine("MOCK-SELECTION:ALLOW"); }
            else if (key.Key == ConsoleKey.Tab) Console.WriteLine("MOCK-TAB");
            else if (key.Key == ConsoleKey.Enter) { Console.WriteLine("MOCK-DECISION:" + (deny ? "DENY" : "ALLOW")); break; }
        }
    }
    else Console.WriteLine("MOCK-ECHO:" + line);
}

static string ReadInputLine()
{
    // A raw console application, like an interactive CLI, handles Ctrl+C itself.
    // Console.ReadLine can return EOF on Ctrl+C before its cancellation callback.
    var line = new StringBuilder();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.KeyChar == '\x03') { Console.WriteLine("\r\nMOCK-CTRL-C"); return ""; }
        if (key.Key == ConsoleKey.Enter) { Console.WriteLine(); return line.ToString(); }
        if (key.Key == ConsoleKey.Backspace)
        {
            if (line.Length > 0) { line.Length--; Console.Write("\b \b"); }
        }
        else if (!char.IsControl(key.KeyChar)) { line.Append(key.KeyChar); Console.Write(key.KeyChar); }
    }
}

static string? MockStatePath()
{
    string? path = Environment.GetEnvironmentVariable("DSH_SSH_SIM_SESSION_FILE");
    string? temp = Environment.GetEnvironmentVariable("TEMP");
    if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(temp)) return null;
    try
    {
        string expected = Path.Combine(Path.GetFullPath(temp), "dsh-mock-session.txt");
        return string.Equals(Path.GetFullPath(path), expected, StringComparison.OrdinalIgnoreCase) ? expected : null;
    }
    catch (Exception e) when (e is ArgumentException or IOException or NotSupportedException) { return null; }
}
