using System.Reflection;
using System.Text.Json;
using RemoteSsh;

internal sealed class HiddenChat(Connection connection, string directory, string appDirectory)
    : ChatForm(connection, directory, appDirectory: appDirectory)
{
    protected override bool ShowWithoutActivation => true;
}

internal static class Program
{
    static int exitCode = 1;
    static T Field<T>(ChatForm form, string name) where T : class =>
        (T)(typeof(ChatForm).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(form)
            ?? throw new Exception("Missing field " + name));
    static bool Busy(ChatForm form) => (bool)(typeof(ChatForm).GetField("busy", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(form) ?? false);
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Fire(Button button)
    {
        Check(button.Enabled, "Button disabled: " + button.Text);
        typeof(Button).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(button, [EventArgs.Empty]);
    }
    static async Task Wait(ChatForm form)
    {
        for (int i = 0; i < 700 && Busy(form); i++) await Task.Delay(100);
        Check(!Busy(form), "Chat request timed out");
    }

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length != 1) throw new ArgumentException("Expected fixture configuration");
        ApplicationConfiguration.Initialize();
        using var config = JsonDocument.Parse(File.ReadAllText(args[0])); var value = config.RootElement;
        string Get(string name) => value.GetProperty(name).GetString()!;
        var connection = new Connection(Get("host"), value.GetProperty("port").GetInt32(), Get("user"),
            Authentication.Key, Get("identity"), Get("known"));
        string receipts = Get("receipts"), app = Get("app"), outputDirectory = Path.GetDirectoryName(args[0])!;
        var context = new ApplicationContext();
        var timer = new System.Windows.Forms.Timer { Interval = 10 };
        timer.Tick += async (_, _) =>
        {
            timer.Stop();
            try
            {
                Guid authSession = Guid.NewGuid();
                var authResult = await ManagedTask.RunAsync(ClaudeSubscription.BuildStatus(connection, authSession, app), null, TimeSpan.FromSeconds(30));
                Check(!authResult.Uncertain && authResult.ExitCode == 0, "Subscription SSH status did not complete");
                using (var authJson = JsonDocument.Parse(authResult.Output))
                {
                    var root = authJson.RootElement;
                    Check(root.EnumerateObject().Count() == 2 && root.GetProperty("session").GetString() == authSession.ToString("D") &&
                          root.GetProperty("status").GetString() is "unavailable" or "not_logged_in" or "cli_missing", "Subscription SSH status exposed unexpected data or accepted an empty profile");
                }
                Console.WriteLine("PASS: native subscription status over local SSH with sanitized response");
                Guid sourceSession = Guid.NewGuid(), childSession = Guid.NewGuid();
                var sharedResult = await ManagedTask.RunAsync(ClaudeSubscription.BuildStatus(connection, childSession, app, sourceSession), null, TimeSpan.FromSeconds(30));
                Check(!sharedResult.Uncertain && sharedResult.ExitCode == 0 && ClaudeSubscription.Status(sharedResult, childSession) == "unavailable",
                      "Shared subscription status did not fail closed with the synthetic non-CLI executable");
                Console.WriteLine("PASS: shared account guard and separate history prepared over local SSH");
                Guid nativeSession = Guid.NewGuid();
                var nativeResult = await ManagedTask.RunAsync(ClaudeSubscription.BuildStatus(connection, nativeSession, app, nativeProfile: true), null, TimeSpan.FromSeconds(30));
                Check(!nativeResult.Uncertain && nativeResult.ExitCode == 0 && ClaudeSubscription.Status(nativeResult, nativeSession) == "unavailable",
                      "Native account status did not fail closed with the synthetic non-CLI executable");
                Console.WriteLine("PASS: common native account status over local SSH with sanitized response");
                using (var chat = new HiddenChat(connection, receipts, app)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show();
                    Field<TextBox>(chat, "workspace").Text = "/tmp/fake-project";
                    Field<TextBox>(chat, "ipv4").Text = "203.0.113.4";
                    Field<TextBox>(chat, "composer").Text = "本地回环任务";
                    Check(!Field<Button>(chat, "send").Enabled, "Output capture consent was not required");
                    Field<CheckBox>(chat, "capture").Checked = true; Field<CheckBox>(chat, "outerOnly").Checked = true;
                    Fire(Field<Button>(chat, "send")); await Wait(chat);
                    Check(Directory.GetFiles(receipts, "task-*.json").Length == 1, "Receipt was not persisted once");
                    Check(!Field<Button>(chat, "send").Enabled, "Selected task could be resent");
                    Check(Field<RichTextBox>(chat, "transcript").Text.Contains("执行中"), "Running output was not visible");
                    for (int i = 0; i < 20 && !Field<RichTextBox>(chat, "transcript").Text.Contains("回环回复"); i++)
                    {
                        await Task.Delay(500); if (Field<Button>(chat, "refresh").Enabled) Fire(Field<Button>(chat, "refresh"));
                        await Wait(chat);
                    }
                    Check(Field<RichTextBox>(chat, "transcript").Text.Contains("回环回复"), "Final output was not shown");
                    string attachment = Path.Combine(outputDirectory, "upload-fixture.txt"); File.WriteAllText(attachment, "attachment over ssh");
                    Field<List<ChatAttachment>>(chat, "attachments").Add(ChatAttachments.Read(attachment, 1));
                    Field<TextBox>(chat, "composer").Text = "本地回环第二轮";
                    // A reply can arrive before the process and final event are
                    // confirmed; only query the original task until continuation is safe.
                    for (int i = 0; i < 20 && !Field<Button>(chat, "send").Enabled; i++)
                    {
                        await Task.Delay(500); if (Field<Button>(chat, "refresh").Enabled) Fire(Field<Button>(chat, "refresh"));
                        await Wait(chat);
                    }
                    Check(Field<Button>(chat, "send").Enabled, "Original turn did not reach confirmed completion");
                    Fire(Field<Button>(chat, "send")); await Wait(chat);
                    for (int i = 0; i < 20 && !Field<RichTextBox>(chat, "transcript").Text.Contains("第二轮回复"); i++)
                    {
                        await Task.Delay(500); if (Field<Button>(chat, "refresh").Enabled) Fire(Field<Button>(chat, "refresh"));
                        await Wait(chat);
                    }
                    Check(Field<RichTextBox>(chat, "transcript").Text.Contains("第二轮回复"), "Second turn was not shown");
                    Check(Directory.GetFiles(receipts, "task-*.json").Length == 2, "Second turn did not get its own receipt");
                    using var bitmap = new Bitmap(chat.Width, chat.Height);
                    chat.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(Path.Combine(outputDirectory, "chat-loopback.png"));
                }
                using (var chat = new HiddenChat(connection, receipts, app)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); var history = Field<ListBox>(chat, "history");
                    Check(history.Items.Count == 1, "Saved receipt was not reloaded"); history.SelectedIndex = 0;
                    await Wait(chat);
                    Check(Field<RichTextBox>(chat, "transcript").Text.Contains("回环回复") &&
                          Field<RichTextBox>(chat, "transcript").Text.Contains("第二轮回复") &&
                          Field<RichTextBox>(chat, "transcript").Text.Contains("本地回环第二轮"), "Reopened conversation did not recover both turns");
                }
                Console.WriteLine("PASS: two-turn chat via local SSH, attachment upload, lost acknowledgements and receipt recovery");
                exitCode = 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); }
            finally { timer.Dispose(); context.ExitThread(); }
        };
        timer.Start(); Application.Run(context); Environment.ExitCode = exitCode;
    }
}
