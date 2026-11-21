using System.Reflection;
using System.Text.Json;
using RemoteSsh;

internal sealed class NonActivatingTaskManagerForm(Connection connection, Func<string?> picker) : TaskManagerForm(connection, picker)
{
    protected override bool ShowWithoutActivation => true;
}
internal sealed class NonActivatingConnectionForm(Connection connection, Action<TaskManagerForm> open, Action<string> error, Action<ChatForm>? chat = null)
    : ConnectionForm(connection, open, error, chat)
{
    protected override bool ShowWithoutActivation => true;
}
internal sealed class NonActivatingChatForm(Connection connection, string directory, ChatTaskRunner runner, string appDirectory, ChatUploadRunner? uploader = null,
    ChatAuthRunner? authRunner = null, Action<string>? loginHelp = null)
    : ChatForm(connection, directory, runner, appDirectory, uploader, authRunner, loginHelp)
{
    protected override bool ShowWithoutActivation => true;
}

internal static class Program
{
    static int exitCode = 1;
    static T Field<T>(object instance, string name) where T : class =>
        (T)(typeof(TaskManagerForm).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(instance)
            ?? throw new Exception("Missing field: " + name));
    static T ConnectionField<T>(object instance, string name) where T : class =>
        (T)(typeof(ConnectionForm).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(instance)
            ?? throw new Exception("Missing connection field: " + name));
    static T ChatField<T>(object instance, string name) where T : class =>
        (T)(typeof(ChatForm).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(instance)
            ?? throw new Exception("Missing chat field: " + name));
    static bool Busy(TaskManagerForm form) => (bool)(typeof(TaskManagerForm).GetField("busy", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(form) ?? false);
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Fire(Button button)
    {
        Check(button.Enabled, "Button disabled: " + button.Text);
        typeof(Button).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(button, [EventArgs.Empty]);
    }
    static async Task WaitFor(TaskManagerForm form)
    {
        for (int i = 0; i < 600 && Busy(form); i++) await Task.Delay(100);
        Check(!Busy(form), "Button request timed out");
    }
    static void Layout(TaskManagerForm form, string path)
    {
        form.PerformLayout();
        var grid = (TableLayoutPanel)form.Controls[0]; grid.PerformLayout();
        foreach (Control control in grid.Controls)
            Check(control.Left >= 0 && control.Top >= 0 && control.Right <= grid.ClientSize.Width && control.Bottom <= grid.ClientSize.Height,
                  $"Control outside grid: {control.Text}");
        var actions = grid.Controls.OfType<FlowLayoutPanel>().Single(panel => panel.Controls.Contains(Field<Button>(form, "start"))); actions.PerformLayout();
        foreach (Control control in actions.Controls)
            Check(control.Left >= 0 && control.Top >= 0 && control.Right <= actions.ClientSize.Width && control.Bottom <= actions.ClientSize.Height,
                  "Action button is clipped: " + control.Text);
        Check(Field<TextBox>(form, "output").Height >= 75, "Output area too small");
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
        bitmap.Save(path);
    }
    static void ConnectionLayout(ConnectionForm form, string path)
    {
        form.PerformLayout();
        var grid = (TableLayoutPanel)form.Controls[0]; grid.PerformLayout();
        foreach (Control control in grid.Controls)
            Check(control.Left >= 0 && control.Top >= 0 && control.Right <= grid.ClientSize.Width && control.Bottom <= grid.ClientSize.Height,
                  "Connection control outside grid: " + control.Text);
        foreach (var actions in grid.Controls.OfType<FlowLayoutPanel>())
        {
            actions.PerformLayout();
            foreach (Control control in actions.Controls)
                Check(control.Left >= 0 && control.Top >= 0 && control.Right <= actions.ClientSize.Width && control.Bottom <= actions.ClientSize.Height,
                      "Connection action is clipped: " + control.Text);
        }
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
        bitmap.Save(path);
    }
    static bool ChatBusy(ChatForm form) => (bool)(typeof(ChatForm).GetField("busy", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(form) ?? false);
    static async Task WaitForChat(ChatForm form)
    {
        for (int i = 0; i < 600 && ChatBusy(form); i++) await Task.Delay(100);
        Check(!ChatBusy(form), "Chat request timed out");
    }
    static void ChatLayout(ChatForm form, string path)
    {
        form.PerformLayout();
        var root = (TableLayoutPanel)form.Controls[0]; root.PerformLayout();
        foreach (var table in root.Controls.OfType<TableLayoutPanel>())
        {
            table.PerformLayout();
            foreach (Control control in table.Controls)
                Check(control.Left >= 0 && control.Top >= 0 && control.Right <= table.ClientSize.Width && control.Bottom <= table.ClientSize.Height,
                      $"Chat control outside panel: {control.GetType().Name} {control.Text} bounds={control.Bounds} panel={table.ClientSize}");
        }
        Check(ChatField<RichTextBox>(form, "transcript").Height >= 100, "Chat output area too small");
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(path);
    }
    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length is < 1 or > 2) throw new ArgumentException("Expected fixture ready.json and optional --start");
        bool startInWindow = args.Length == 2 && args[1] == "--start";
        if (args.Length == 2 && !startInWindow) throw new ArgumentException("Unexpected test mode");
        ApplicationConfiguration.Initialize();
        using var config = JsonDocument.Parse(File.ReadAllText(args[0]));
        var data = config.RootElement;
        string Text(string key) => data.GetProperty(key).GetString()!;
        var connection = new Connection(Text("host"), data.GetProperty("port").GetInt32(), Text("user"),
            Authentication.Key, Text("identity"), Text("known"));
        string receipt = Text("receipt"), state = Text("state_dir"), directory = Path.GetDirectoryName(args[0])!;
        var selectedReceipts = new Queue<string>();
        using var form = new NonActivatingTaskManagerForm(connection, () => selectedReceipts.Dequeue())
        {
            StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false
        };
        // Show only off-screen and without activation so children render without interrupting other work.
        form.Show();
        var context = new ApplicationContext();
        var timer = new System.Windows.Forms.Timer { Interval = 10 };
        timer.Tick += async (_, _) =>
        {
            timer.Stop();
            try
            {
                int opened = 0, chatOpened = 0; string? taskError = null;
                using (var manager = new NonActivatingConnectionForm(connection, _ => opened++, message => taskError = message, _ => chatOpened++)
                {
                    StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false
                })
                {
                    manager.Show();
                    ConnectionLayout(manager, Path.Combine(directory, "offscreen-connection-default.png"));
                    using (var dialog = new PrivacyOptionsForm { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                    {
                        dialog.Show(); dialog.PerformLayout();
                        var relayBox = (CheckBox)typeof(PrivacyOptionsForm).GetField("relay", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(dialog)!;
                        var relayAddress = (TextBox)typeof(PrivacyOptionsForm).GetField("relaySource", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(dialog)!;
                        Check(relayBox.Checked && string.IsNullOrEmpty(relayAddress.Text), "Relay mode must start enabled without assuming an exit address");
                        var privacyGrid = (TableLayoutPanel)dialog.Controls[0]; privacyGrid.PerformLayout();
                        foreach (Control control in privacyGrid.Controls)
                            Check(control.Left >= 0 && control.Top >= 0 && control.Right <= privacyGrid.ClientSize.Width && control.Bottom <= privacyGrid.ClientSize.Height,
                                "Privacy dialog control outside grid: " + control.Text);
                        using var bitmap = new Bitmap(dialog.Width, dialog.Height);
                        dialog.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                        bitmap.Save(Path.Combine(directory, "offscreen-privacy-dialog.png"));
                        dialog.Close();
                    }
                    var tasks = ConnectionField<Button>(manager, "tasks");
                    var chatButton = ConnectionField<Button>(manager, "chat");
                    var verified = ConnectionField<CheckBox>(manager, "verified");
                    Fire(ConnectionField<Button>(manager, "privacy"));
                    Check(ConnectionField<Label>(manager, "status").Text.Contains("指纹"), "Privacy button bypassed host verification");
                    Fire(tasks);
                    Check(opened == 0 && taskError?.Contains("核对主机指纹") == true, "Unverified host opened task window");
                    Fire(chatButton);
                    Check(chatOpened == 0 && taskError?.Contains("核对主机指纹") == true, "Unverified host opened chat window");
                    verified.Checked = true; Fire(tasks); Fire(chatButton);
                    Check(opened == 1, "Verified connection did not open the task window");
                    Check(chatOpened == 1, "Verified connection did not open the chat window");
                    ConnectionField<TextBox>(manager, "host").Text = "localhost";
                    Check(!verified.Checked, "Changing target did not clear host verification");
                    Console.WriteLine("PASS: manager task button requires and resets host verification");
                    manager.Size = manager.MinimumSize;
                    ConnectionLayout(manager, Path.Combine(directory, "offscreen-connection-minimum.png"));
                    Console.WriteLine("PASS: connection window layout controls and buttons fit");
                }
                string chatDirectory = Path.Combine(directory, "chat-receipts");
                int chatStarts = 0, chatQueries = 0, chatOutputs = 0, uploads = 0; Guid nativeId = Guid.NewGuid(), malformedId = Guid.Empty;
                Guid? observedSharedSource = null, observedAuthSource = null;
                string? sentAttachmentPrompt = null;
                var observed = new Dictionary<Guid, (Guid Session, bool Claude)>(); var queries = new Dictionary<Guid, int>();
                ChatUploadRunner upload = (conversation, turn, files) =>
                {
                    uploads++;
                    return Task.FromResult(new ManagedToolResult(0, JsonSerializer.Serialize(new { outcome = "staged", session = conversation.ToString("D"), turn = turn.ToString("D"), files = files.Select(f => new { name = f.RemoteName, size = f.Size, sha256 = f.Sha256 }) }), false));
                };
                ChatTaskRunner fake = (action, path, root, id, payload) =>
                {
                    Guid task = ManagedTask.ReadReceipt(connection, path).TaskId;
                    if (action == ManagedTaskAction.Start)
                    {
                        chatStarts++; Check(id is not null && File.Exists(path) && payload is not null, "Chat did not reserve before submission");
                        using var request = JsonDocument.Parse(payload!);
                        Check(request.RootElement.GetProperty("capture").GetBoolean(), "Chat did not require captured output");
                        var argv = request.RootElement.GetProperty("command").EnumerateArray().Select(x => x.GetString()!).ToArray();
                        string json = System.Text.Encoding.UTF8.GetString(payload!); int sessionIndex = Array.IndexOf(argv, "--chat-session");
                        Check(json.Contains("--isolation-code") && sessionIndex >= 0, "Chat skipped selected isolation policy");
                        bool claude = argv.Contains("--chat-prompt");
                        if (argv.Contains("--chat-turn"))
                            sentAttachmentPrompt = claude ? argv[Array.IndexOf(argv, "--chat-prompt") + 1] : argv[^1];
                        int sourceIndex = Array.IndexOf(argv, "--chat-auth-source");
                        if (sourceIndex >= 0) observedSharedSource = Guid.Parse(argv[sourceIndex + 1]);
                        Guid session = claude ? Guid.Parse(argv[sessionIndex + 1]) : nativeId;
                        if (chatStarts == 2) Check(argv.Contains("resume") && argv.Contains(nativeId.ToString("D")), "Second turn did not resume first native session");
                        observed[task] = (session, claude); queries[task] = 0;
                        Check(!File.ReadAllText(path).Contains("演示任务"), "Chat stored prompt in receipt");
                        return Task.FromResult(new ManagedToolResult(null, "", true)); // Lost acknowledgement.
                    }
                    if (action == ManagedTaskAction.Status)
                    {
                        chatQueries++; queries[task]++;
                        string stateName = queries[task] == 1 ? "running" : "finished";
                        bool malformed = malformedId == task; if (malformed) malformedId = Guid.Empty;
                        string extra = stateName == "finished" && !malformed ? ",\"exit_code\":0,\"output_captured\":true" : "";
                        return Task.FromResult(new ManagedToolResult(0, $"{{\"task_id\":\"{task:D}\",\"state\":\"{stateName}\"{extra}}}", false));
                    }
                    if (action == ManagedTaskAction.Output)
                    {
                        chatOutputs++;
                        var (session, claude) = observed[task]; bool finished = queries[task] > 1;
                        string output = claude ? $"{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{session:D}\"}}\n" +
                            (finished ? $"{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"{session:D}\",\"result\":\"Claude 模拟回复\"}}\n" : "") :
                            $"{{\"type\":\"thread.started\",\"thread_id\":\"{session:D}\"}}\n" +
                            (finished ? "{\"type\":\"item.completed\",\"item\":{\"id\":\"2\",\"type\":\"agent_message\",\"text\":\"模拟回复\"}}\n{\"type\":\"turn.completed\"}\n" :
                            "{\"type\":\"item.started\",\"item\":{\"id\":\"1\",\"type\":\"command_execution\",\"command\":\"echo test\"}}\n");
                        return Task.FromResult(new ManagedToolResult(0, output, false));
                    }
                    return Task.FromResult(new ManagedToolResult(0, "模拟诊断", false));
                };
                using (var chat = new NonActivatingChatForm(connection, chatDirectory, fake, AppContext.BaseDirectory, upload)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); ChatLayout(chat, Path.Combine(directory, "offscreen-chat-default.png"));
                    ChatField<TextBox>(chat, "workspace").Text = "/tmp/project";
                    ChatField<TextBox>(chat, "ipv4").Text = "203.0.113.4";
                    ChatField<TextBox>(chat, "composer").Text = "演示任务";
                    Check(!ChatField<Button>(chat, "send").Enabled, "Chat capture must be explicitly selected");
                    ChatField<CheckBox>(chat, "capture").Checked = true;
                    Check(!ChatField<CheckBox>(chat, "outerOnly").Checked, "Chat must not default to outer-only");
                    ChatField<CheckBox>(chat, "outerOnly").Checked = true;
                    Check(ChatField<Label>(chat, "taskStatus").Text.Contains("认证信息"), "Outer-only mode did not expose credential access");
                    Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Check(chatStarts == 1 && chatQueries >= 1 && chatOutputs >= 1, "Chat failed to query the original task after lost acknowledgement");
                    Check(!ChatField<Button>(chat, "send").Enabled && ChatField<RichTextBox>(chat, "transcript").Text.Contains("执行中"), "Chat allowed replay or missed progress");
                    ChatField<TextBox>(chat, "composer").Text = "等待中的草稿";
                    Check(ChatField<TextBox>(chat, "composer").Enabled && !ChatField<Button>(chat, "send").Enabled, "Running task should allow drafting but not sending");
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(chatStarts == 1 && ChatField<RichTextBox>(chat, "transcript").Text.Contains("模拟回复") && ChatField<TextBox>(chat, "composer").Text == "等待中的草稿", "Chat failed to recover the original result and keep the draft");
                    string attachmentPath = Path.Combine(directory, "fixture-attachment.txt"); File.WriteAllText(attachmentPath, "fixture attachment");
                    ChatField<List<ChatAttachment>>(chat, "attachments").Add(ChatAttachments.Read(attachmentPath, 1));
                    const string typed = "  继续第二轮  ";
                    ChatField<TextBox>(chat, "composer").Text = typed;
                    Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Check(chatStarts == 2 && uploads == 1 && !ChatField<Button>(chat, "send").Enabled, "Second turn did not upload once or allowed replay");
                    Check(sentAttachmentPrompt?.StartsWith(typed + "\n\n本轮附加文件", StringComparison.Ordinal) == true, "Explicit attachment prompt lost the original spaces");
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(ChatField<RichTextBox>(chat, "transcript").Text.Contains("继续第二轮"), "Second turn was not shown");
                    malformedId = observed.Keys.Last();
                    chat.Size = chat.MinimumSize; ChatLayout(chat, Path.Combine(directory, "offscreen-chat-minimum.png"));
                }
                using (var chat = new NonActivatingChatForm(connection, chatDirectory, fake, AppContext.BaseDirectory, upload)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); var list = ChatField<ListBox>(chat, "history");
                    Check(list.Items.Count == 1, "Chat did not reload its conversation"); list.SelectedIndex = 0;
                    await WaitForChat(chat);
                    Check(ChatField<Label>(chat, "taskStatus").Text.Contains("无法确认") && !ChatField<Button>(chat, "send").Enabled, "Malformed finished status was accepted");
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(chatStarts == 2 && ChatField<RichTextBox>(chat, "transcript").Text.Contains("继续第二轮"), "Reopened chat did not recover both turns without replay");
                    ChatField<TextBox>(chat, "composer").Text = "Codex 未发送草稿";
                    ChatField<List<ChatAttachment>>(chat, "attachments").Add(ChatAttachments.Read(Path.Combine(directory, "fixture-attachment.txt"), 1));
                    Fire(ChatField<Button>(chat, "fresh")); Check(!ChatField<CheckBox>(chat, "outerOnly").Checked, "New conversation retained elevated mode");
                    ChatField<ComboBox>(chat, "provider").SelectedIndex = 1;
                    ChatField<ComboBox>(chat, "claudeAuth").SelectedIndex = 0;
                    Check(ChatField<TextBox>(chat, "composer").Text == "" && ChatField<List<ChatAttachment>>(chat, "attachments").Count == 0, "Codex draft leaked into Claude");
                    ChatField<TextBox>(chat, "composer").Text = "Claude 未发送草稿";
                    ChatField<ComboBox>(chat, "claudeAuth").SelectedIndex = 1;
                    Check(ChatField<TextBox>(chat, "composer").Text == "", "Claude API draft leaked into subscription mode");
                    ChatField<TextBox>(chat, "composer").Text = "Claude 订阅草稿";
                    ChatField<ComboBox>(chat, "claudeAuth").SelectedIndex = 0;
                    Check(ChatField<TextBox>(chat, "composer").Text == "Claude 未发送草稿", "Claude API draft was not restored after switching auth mode");
                    list.SelectedIndex = 0; await WaitForChat(chat);
                    Check(ChatField<TextBox>(chat, "composer").Text == "Codex 未发送草稿" && ChatField<List<ChatAttachment>>(chat, "attachments").Count == 1 && chatStarts == 2,
                        "Switching conversations lost the Codex draft or repeated a task");
                    Fire(ChatField<Button>(chat, "fresh")); ChatField<ComboBox>(chat, "provider").SelectedIndex = 1;
                    Check(ChatField<TextBox>(chat, "composer").Text == "Claude 未发送草稿" && ChatField<List<ChatAttachment>>(chat, "attachments").Count == 0,
                        "Claude draft was lost or inherited Codex attachments");
                    ChatField<CheckBox>(chat, "outerOnly").Checked = false; ChatField<CheckBox>(chat, "capture").Checked = true;
                    ChatField<List<ChatAttachment>>(chat, "attachments").Add(ChatAttachments.Read(Path.Combine(directory, "fixture-attachment.txt"), 1));
                    ChatField<TextBox>(chat, "composer").Clear(); Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(chatStarts == 3 && ChatField<RichTextBox>(chat, "transcript").Text.Contains("Claude 模拟回复"), "Claude backend was not rendered");
                    Check(uploads == 2 && sentAttachmentPrompt?.StartsWith("逐份查看附件。列出文件名和一个要点，标明无法读取的附件。\n\n本轮附加文件", StringComparison.Ordinal) == true,
                          "Attachment-only turn did not use the default review prompt");
                    Check(ChatField<ComboBox>(chat, "provider").SelectedIndex == 1 && ChatField<ComboBox>(chat, "provider").Text == "Claude", "Selected Claude backend was not retained");
                    Check(ChatField<Label>(chat, "selectedProvider").Visible && ChatField<Label>(chat, "selectedProvider").Text == "Claude", "Selected backend label was not visible");
                    Check(ChatField<Label>(chat, "selectedClaudeAuth").Visible && ChatField<Label>(chat, "selectedClaudeAuth").Text == "API 密钥", "Selected Claude API mode label was not visible");
                    Check(ChatField<CheckBox>(chat, "outerOnly").Text.Contains("跳过 Claude 权限"), "Claude outer-only warning was not specific");
                    chat.Size = chat.MinimumSize; ChatLayout(chat, Path.Combine(directory, "offscreen-chat-claude-minimum.png"));
                }
                string subscriptionDirectory = Path.Combine(directory, "chat-subscription");
                string authState = "cli_missing", helpCommand = ""; int authChecks = 0;
                ChatAuthRunner auth = (id, source) => { authChecks++; observedAuthSource = source; return Task.FromResult(new ManagedToolResult(0, $"{{\"session\":\"{id:D}\",\"status\":\"{authState}\"}}", false)); };
                Directory.CreateDirectory(subscriptionDirectory);
                var legacyDraft = new ChatConversationRecord { Id = Guid.NewGuid(), Provider = "claude", ClaudeAuthMode = "subscription", Host = connection.Host,
                    Port = connection.Port, User = connection.User, Workspace = "/tmp/project", ExpectedIpv4 = "203.0.113.4" };
                ChatStore.Save(legacyDraft, connection, subscriptionDirectory);
                using (var chat = new NonActivatingChatForm(connection, subscriptionDirectory, fake, AppContext.BaseDirectory, upload, auth, text => helpCommand = text)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); ChatField<ListBox>(chat, "history").SelectedIndex = 0; await WaitForChat(chat);
                    ChatField<CheckBox>(chat, "capture").Checked = true; ChatField<TextBox>(chat, "composer").Text = "订阅测试";
                    Check(!ChatField<Button>(chat, "send").Enabled, "Subscription sent before profile preparation");
                    Fire(ChatField<Button>(chat, "prepareLogin")); await WaitForChat(chat);
                    Check(helpCommand == "" && ChatField<Label>(chat, "taskStatus").Text.Contains("未找到 Claude Code") && !ChatField<Button>(chat, "send").Enabled,
                          "Missing CLI offered a nonfunctional login command");
                    authState = "not_logged_in"; Fire(ChatField<Button>(chat, "prepareLogin")); await WaitForChat(chat);
                    Check(helpCommand.EndsWith("auth login") && authChecks == 3 && !ChatField<Button>(chat, "send").Enabled &&
                          Directory.GetFiles(subscriptionDirectory, "task-*.json").Length == 0, "Unlogged subscription did not remain a draft");
                    Check(ChatField<TextBox>(chat, "composer").Enabled && ChatField<TextBox>(chat, "composer").Text == "订阅测试", "Preparing login lost the unsent draft");
                    Check(ChatField<Label>(chat, "selectedClaudeAuth").Visible && ChatField<Label>(chat, "selectedClaudeAuth").Text.Contains("订阅") &&
                          ChatField<RichTextBox>(chat, "transcript").Text.Contains("独立的远端登录目录"), "Subscription draft did not show its auth mode and next step");
                    chat.Size = chat.MinimumSize; ChatLayout(chat, Path.Combine(directory, "offscreen-chat-subscription-minimum.png"));
                }
                using (var chat = new NonActivatingChatForm(connection, subscriptionDirectory, fake, AppContext.BaseDirectory, upload, auth, _ => { })
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); var list = ChatField<ListBox>(chat, "history"); Check(list.Items.Count == 1, "Subscription draft was not saved");
                    authState = "ready"; list.SelectedIndex = 0; await WaitForChat(chat);
                    Check(ChatField<TextBox>(chat, "composer").Text == "", "Unsent draft should not persist after closing the workbench");
                    ChatField<CheckBox>(chat, "capture").Checked = true; ChatField<TextBox>(chat, "composer").Text = "订阅测试";
                    Check(ChatField<Button>(chat, "send").Enabled && authChecks >= 3, "Reopened draft did not automatically check native status");
                    Check(!ChatField<Button>(chat, "reuseAccount").Enabled && ChatField<Label>(chat, "taskStatus").Text.Contains("首轮"),
                          "Account reuse was allowed before the source profile had a completed turn");
                    authState = "wrong_profile"; Fire(ChatField<Button>(chat, "checkLogin")); await WaitForChat(chat);
                    Check(!ChatField<Button>(chat, "send").Enabled && ChatField<Label>(chat, "taskStatus").Text.Contains("配置目录不匹配"), "Mismatched native profile did not block sending");
                    authState = "ready"; Fire(ChatField<Button>(chat, "checkLogin")); await WaitForChat(chat);
                    authState = "unavailable"; int before = chatStarts; Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Check(chatStarts == before && Directory.GetFiles(subscriptionDirectory, "task-*.json").Length == 0 && !ChatField<Button>(chat, "send").Enabled,
                          "Failed pre-send status created or submitted a task");
                    authState = "ready"; Fire(ChatField<Button>(chat, "checkLogin")); await WaitForChat(chat);
                    Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat); Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(chatStarts == before + 1 && ChatField<RichTextBox>(chat, "transcript").Text.Contains("Claude 模拟回复"), "Subscription mock turn did not complete");
                    ChatField<TextBox>(chat, "composer").Text = "订阅第二轮"; Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(chatStarts == before + 2 && ChatField<RichTextBox>(chat, "transcript").Text.Contains("订阅第二轮"), "Subscription did not continue the original session");
                    Guid originalId = ChatStore.Read(Directory.GetFiles(subscriptionDirectory, "conversation-*.json").Single(), connection, subscriptionDirectory).Id;
                    ChatField<TextBox>(chat, "composer").Text = "原会话的草稿";
                    Check(ChatField<Button>(chat, "reuseAccount").Enabled, "Signed-in subscription did not offer account reuse");
                    Fire(ChatField<Button>(chat, "reuseAccount")); await WaitForChat(chat);
                    chat.Size = chat.MinimumSize; ChatLayout(chat, Path.Combine(directory, "offscreen-chat-reused-minimum.png"));
                    var records = Directory.GetFiles(subscriptionDirectory, "conversation-*.json").Select(path => ChatStore.Read(path, connection, subscriptionDirectory)).ToArray();
                    var child = records.Single(record => record.Id != originalId);
                    Check(child.ClaudeAccountSourceId == originalId && child.Turns.Count == 0 && observedAuthSource == originalId &&
                          ChatField<TextBox>(chat, "composer").Text == "" && !ChatField<CheckBox>(chat, "outerOnly").Checked &&
                          ChatField<TextBox>(chat, "workspace").Enabled && ChatField<TextBox>(chat, "ipv4").Enabled,
                          "Account reuse did not create an isolated draft with the original account");
                    ChatField<TextBox>(chat, "workspace").Text = "/tmp/other-project";
                    ChatField<TextBox>(chat, "ipv4").Text = "203.0.113.7";
                    string sourcePath = ChatStore.PathFor(subscriptionDirectory, originalId), sourceContent = File.ReadAllText(sourcePath);
                    int priorAuthChecks = authChecks; File.WriteAllText(sourcePath, "{invalid");
                    Fire(ChatField<Button>(chat, "checkLogin")); await WaitForChat(chat);
                    Check(authChecks == priorAuthChecks && !ChatField<Button>(chat, "send").Enabled && ChatField<Label>(chat, "taskStatus").Text.Contains("来源记录不可用"),
                          "Corrupted account source did not fail closed before the SSH status check");
                    File.WriteAllText(sourcePath, sourceContent);
                    authState = "shared_profile_changed"; Fire(ChatField<Button>(chat, "checkLogin")); await WaitForChat(chat);
                    ChatField<TextBox>(chat, "composer").Text = "共享账号第一轮";
                    Check(!ChatField<Button>(chat, "send").Enabled && ChatField<Label>(chat, "taskStatus").Text.Contains("暂停"), "Changed shared profile did not block sending");
                    authState = "ready"; Fire(ChatField<Button>(chat, "checkLogin")); await WaitForChat(chat);
                    Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat); Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(chatStarts == before + 3 && observedSharedSource == originalId && ChatField<RichTextBox>(chat, "transcript").Text.Contains("Claude 模拟回复"),
                          "Reused account did not retain a distinct native session");
                    var savedChild = ChatStore.Read(ChatStore.PathFor(subscriptionDirectory, child.Id), connection, subscriptionDirectory);
                    Check(savedChild.Workspace == "/tmp/other-project" && savedChild.ExpectedIpv4 == "203.0.113.7" && !ChatField<TextBox>(chat, "workspace").Enabled,
                          "Shared draft did not retain its own validated project and expected egress");
                    var history = ChatField<ListBox>(chat, "history"); history.SelectedIndex = 1; await WaitForChat(chat);
                    Check(ChatField<TextBox>(chat, "composer").Text == "原会话的草稿" && chatStarts == before + 3,
                          "Account reuse lost the source draft or replayed an existing task");
                }
                Console.WriteLine("PASS: subscription draft, native status checks and two mock turns without replay");
                string nativeDirectory = Path.Combine(directory, "chat-native-subscription");
                authState = "not_logged_in";
                using (var chat = new NonActivatingChatForm(connection, nativeDirectory, fake, AppContext.BaseDirectory, upload, auth, text => helpCommand = text)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); int before = chatStarts;
                    ChatField<TextBox>(chat, "workspace").Text = "/tmp/project"; ChatField<TextBox>(chat, "ipv4").Text = "203.0.113.4";
                    ChatField<ComboBox>(chat, "provider").SelectedIndex = 1;
                    Check(ChatField<ComboBox>(chat, "claudeAuth").SelectedIndex == 1, "New Claude conversations should use native login by default");
                    ChatField<CheckBox>(chat, "capture").Checked = true; ChatField<TextBox>(chat, "composer").Text = "原生账号第一轮";
                    Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Check(chatStarts == before && Directory.GetFiles(nativeDirectory, "task-*.json").Length == 0 &&
                          ChatField<TextBox>(chat, "composer").Text == "原生账号第一轮", "Unconfirmed native login created a receipt or lost the draft");
                    Check(!ChatField<Button>(chat, "reuseAccount").Visible && ChatField<Label>(chat, "taskStatus").Text.Contains("未检测到订阅登录"),
                          "Native account flow exposed legacy reuse or hid the login state");
                    authState = "ready"; Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    var first = ChatStore.Read(Directory.GetFiles(nativeDirectory, "conversation-*.json").Single(), connection, nativeDirectory);
                    Check(first.NativeProfile && first.ClaudeAccountSourceId is null && first.Turns.Count == 1 && chatStarts == before + 1,
                          "Native first conversation did not use its own persisted session");
                    ChatField<TextBox>(chat, "composer").Text = "第一会话草稿";
                    Fire(ChatField<Button>(chat, "fresh"));
                    ChatField<TextBox>(chat, "workspace").Text = "/tmp/other-project"; ChatField<TextBox>(chat, "ipv4").Text = "203.0.113.7";
                    ChatField<TextBox>(chat, "composer").Text = "原生账号第二个对话";
                    Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat); Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    var records = Directory.GetFiles(nativeDirectory, "conversation-*.json").Select(path => ChatStore.Read(path, connection, nativeDirectory)).ToArray();
                    var second = records.Single(record => record.Id != first.Id);
                    Check(records.Length == 2 && second.NativeProfile && second.ClaudeAccountSourceId is null && second.Turns.Count == 1 &&
                          second.Workspace == "/tmp/other-project" && second.ExpectedIpv4 == "203.0.113.7" && chatStarts == before + 2,
                          "New conversations did not reuse the native account with distinct IDs and settings");
                    chat.Size = chat.MinimumSize; ChatLayout(chat, Path.Combine(directory, "offscreen-native-account-minimum.png"));
                    ChatField<ListBox>(chat, "history").SelectedIndex = 1; await WaitForChat(chat);
                    Check(ChatField<TextBox>(chat, "composer").Text == "第一会话草稿" && chatStarts == before + 2,
                          "Switching native sessions lost the draft or repeated a task");
                }
                Console.WriteLine("PASS: native account reused by independent new conversations without replay");
                string largeAttachment = Path.Combine(directory, "draft-cap-fixture.txt");
                File.WriteAllBytes(largeAttachment, new byte[ChatAttachments.MaxFileBytes]);
                try
                {
                    using var chat = new NonActivatingChatForm(connection, Path.Combine(directory, "chat-draft-cap"), fake, AppContext.BaseDirectory)
                    { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false };
                    chat.Show(); int before = chatStarts;
                    chat.AddAttachmentPaths(Enumerable.Repeat(largeAttachment, 4));
                    ChatField<ComboBox>(chat, "provider").SelectedIndex = 1;
                    bool rejected = false;
                    try { chat.AddAttachmentPaths([Path.Combine(directory, "fixture-attachment.txt")]); }
                    catch (ArgumentException) { rejected = true; }
                    Check(rejected && ChatField<List<ChatAttachment>>(chat, "attachments").Count == 0 && chatStarts == before,
                        "Attachment cap across drafts was not enforced atomically");
                    ChatField<ComboBox>(chat, "provider").SelectedIndex = 0;
                    Check(ChatField<List<ChatAttachment>>(chat, "attachments").Count == 4, "Attachment cap discarded an existing draft");
                }
                finally { File.Delete(largeAttachment); }
                string longDirectory = Path.Combine(directory, "chat-many-turns"); Directory.CreateDirectory(longDirectory);
                Guid longId = Guid.NewGuid(), longThread = Guid.NewGuid(); var longTasks = new List<Guid>();
                var longConversation = new ChatConversationRecord { Id = longId, Provider = "codex", Host = connection.Host, Port = connection.Port,
                    User = connection.User, Workspace = "/tmp/project", ExpectedIpv4 = "203.0.113.4" };
                for (int i = 0; i < 5; i++)
                {
                    Guid id = Guid.NewGuid(); longTasks.Add(id); string path = Path.Combine(longDirectory, $"task-long-{i}.json");
                    ManagedTask.ReserveReceipt(connection, path, null, id);
                    longConversation.Turns.Add(new ChatTurnRecord { TaskId = id, Receipt = Path.GetFileName(path), Prompt = "历史 " + i, ThreadId = longThread });
                }
                ChatStore.Save(longConversation, connection, longDirectory);
                var restored = new List<Guid>(); int restoreStarts = 0;
                ChatTaskRunner restore = (action, path, _, _, _) =>
                {
                    Guid task = ManagedTask.ReadReceipt(connection, path).TaskId;
                    if (action == ManagedTaskAction.Start) { restoreStarts++; throw new Exception("Restore submitted a task"); }
                    if (action == ManagedTaskAction.Status)
                    {
                        restored.Add(task);
                        return Task.FromResult(new ManagedToolResult(0, $"{{\"task_id\":\"{task:D}\",\"state\":\"finished\",\"exit_code\":0,\"output_captured\":true}}", false));
                    }
                    return Task.FromResult(new ManagedToolResult(0, $"{{\"type\":\"thread.started\",\"thread_id\":\"{longThread:D}\"}}\n{{\"type\":\"turn.completed\"}}\n", false));
                };
                using (var chat = new NonActivatingChatForm(connection, longDirectory, restore, AppContext.BaseDirectory)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); ChatField<ListBox>(chat, "history").SelectedIndex = 0; await WaitForChat(chat);
                    Check(restored.SequenceEqual(longTasks.TakeLast(3)) && restoreStarts == 0 && ChatField<Label>(chat, "taskStatus").Text.Contains("较早消息"),
                        "Automatic restoration did not bound itself to the latest three original tasks");
                    ChatField<CheckBox>(chat, "capture").Checked = true; ChatField<TextBox>(chat, "composer").Text = "恢复后的草稿";
                    Check(ChatField<Button>(chat, "send").Enabled, "Confirmed latest native thread could not continue");
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(restored.Skip(3).SequenceEqual([longTasks[0], longTasks[1], longTasks[4]]) && restoreStarts == 0,
                        "Full history query failed or replayed a task");
                }
                Console.WriteLine("PASS: bounded automatic recovery, full history query and isolated in-memory drafts");
                string interruptedDirectory = Path.Combine(directory, "chat-upload-uncertain"); int forbiddenStarts = 0;
                ChatTaskRunner notSubmitted = (action, path, _, id, _) =>
                {
                    if (action == ManagedTaskAction.Start) { forbiddenStarts++; throw new Exception("Started after uncertain upload"); }
                    Guid task = ManagedTask.ReadReceipt(connection, path).TaskId;
                    return Task.FromResult(new ManagedToolResult(0, $"{{\"task_id\":\"{task:D}\",\"state\":\"not_found\"}}", false));
                };
                ChatUploadRunner uncertainUpload = (_, _, _) => Task.FromResult(new ManagedToolResult(null, "", true));
                using (var chat = new NonActivatingChatForm(connection, interruptedDirectory, notSubmitted, AppContext.BaseDirectory, uncertainUpload)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); ChatField<TextBox>(chat, "workspace").Text = "/tmp/project"; ChatField<TextBox>(chat, "ipv4").Text = "203.0.113.4";
                    ChatField<CheckBox>(chat, "capture").Checked = true;
                    ChatField<List<ChatAttachment>>(chat, "attachments").Add(ChatAttachments.Read(Path.Combine(directory, "fixture-attachment.txt"), 1));
                    ChatField<TextBox>(chat, "composer").Text = "附件传输中断"; Fire(ChatField<Button>(chat, "send")); await WaitForChat(chat);
                    Check(forbiddenStarts == 0 && ChatField<Label>(chat, "taskStatus").Text.Contains("未发送") && !ChatField<Button>(chat, "send").Enabled, "Unconfirmed upload started or replayed a task");
                }
                using (var chat = new NonActivatingChatForm(connection, interruptedDirectory, notSubmitted, AppContext.BaseDirectory, uncertainUpload)
                { StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false })
                {
                    chat.Show(); ChatField<ListBox>(chat, "history").SelectedIndex = 0; await WaitForChat(chat);
                    Fire(ChatField<Button>(chat, "refresh")); await WaitForChat(chat);
                    Check(forbiddenStarts == 0 && !ChatField<Button>(chat, "send").Enabled, "Unconfirmed upload was replayed after reopening");
                }
                Console.WriteLine("PASS: multi-turn chat, attachment consent, two backends and receipt recovery");
                Layout(form, Path.Combine(directory, "offscreen-layout-default.png"));
                Console.WriteLine("PASS: default layout controls and buttons fit");
                Field<TextBox>(form, "stateDirectory").Text = state;
                var start = Field<Button>(form, "start"); var query = Field<Button>(form, "query");
                var output = Field<TextBox>(form, "output");
                string protectedReceipt = Path.Combine(directory, "privacy-invalid.json");
                Field<TextBox>(form, "receipt").Text = protectedReceipt;
                Field<TextBox>(form, "executable").Text = "/usr/bin/codex";
                Check(Field<CheckBox>(form, "privacy").Checked, "Direct Codex did not select privacy check");
                Check(Field<CheckBox>(form, "isolation").Checked, "Direct Codex did not select process/network isolation");
                var outerOnly = Field<CheckBox>(form, "outerOnly");
                Check(outerOnly.Enabled && !outerOnly.Checked, "Outer-only mode must be an explicit choice");
                outerOnly.Checked = true;
                Field<CheckBox>(form, "isolation").Checked = false;
                Check(!outerOnly.Checked && !outerOnly.Enabled, "Disabling outer isolation must clear outer-only mode");
                Field<CheckBox>(form, "isolation").Checked = true;
                outerOnly.Checked = true;
                Field<TextBox>(form, "workingDirectory").Text = "/tmp";
                Field<TextBox>(form, "arguments").Text = string.Join(Environment.NewLine, "exec", "--sandbox", "read-only", "prompt");
                Field<TextBox>(form, "privacyIpv4").Text = "203.0.113.4";
                Fire(start); await WaitFor(form);
                Check(!File.Exists(protectedReceipt) && output.Text.Contains("不能与"), "Conflicting outer-only policy was not rejected before submission");
                outerOnly.Checked = false;
                Field<TextBox>(form, "arguments").Clear();
                Field<TextBox>(form, "workingDirectory").Clear();
                Field<TextBox>(form, "privacyIpv4").Clear();
                Fire(start); await WaitFor(form);
                Check(!File.Exists(protectedReceipt) && output.Text.Contains("任务尚未发送"), "Missing egress address must block before receipt and launch");
                Field<CheckBox>(form, "privacy").Checked = false;
                Fire(start); await WaitFor(form);
                Check(!File.Exists(protectedReceipt) && output.Text.Contains("必须检查"), "Direct Codex bypassed mandatory privacy check");
                Field<TextBox>(form, "executable").Text = "";
                selectedReceipts.Enqueue(receipt);
                Fire(Field<Button>(form, "browse"));
                Check(Field<TextBox>(form, "receipt").Text == receipt, "Receipt picker did not apply the selected path");
                if (startInWindow)
                {
                    Check(start.Enabled && !query.Enabled, "New receipt should enable start only");
                    Field<TextBox>(form, "workingDirectory").Text = "/tmp";
                    Field<TextBox>(form, "executable").Text = "/usr/bin/python3";
                    string code = "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); " +
                                  "p.open('a',encoding='utf-8').write('once\\n'); time.sleep(2); " +
                                  "print('managed-stdout'); print('managed-stderr',file=sys.stderr)";
                    Field<TextBox>(form, "arguments").Text = string.Join(Environment.NewLine, "-c", code, Text("side_effect"));
                    Field<CheckBox>(form, "capture").Checked = true;
                    Fire(start);
                    Check(Busy(form) && File.Exists(receipt) && !start.Enabled && !query.Enabled,
                          "Start did not reserve the receipt before sending or disable actions");
                    await WaitFor(form);
                    Check(output.Text.Contains("无法确认"), "Lost acknowledgement did not remain unknown");
                    Console.WriteLine("PASS: new-task button saves a receipt before a lost acknowledgement");
                }
                Check(!start.Enabled && query.Enabled, "Existing receipt should permit only lookup");
                for (int attempt = 0; attempt < 20; attempt++)
                {
                    Fire(query);
                    Check(Busy(form) && !query.Enabled && !start.Enabled, "Controls were not disabled while querying");
                    await WaitFor(form);
                    if (output.Text.Contains("退出码：0")) break;
                    await Task.Delay(500);
                }
                Check(output.Text.Contains("退出码：0"), "The original task did not report its successful exit: " + output.Text);
                Console.WriteLine("PASS: original receipt queries the finished task through the GUI handler");
                Fire(Field<Button>(form, "readOutput")); await WaitFor(form);
                Check(output.Text.Trim() == "managed-stdout", "Standard output did not match");
                Fire(Field<Button>(form, "readError")); await WaitFor(form);
                Check(output.Text.Trim() == "managed-stderr", "Standard error did not match");
                Console.WriteLine("PASS: both output buttons display the correct separate streams");
                string invalid = Path.Combine(directory, "uncreated.json");
                Field<TextBox>(form, "receipt").Text = invalid;
                Field<TextBox>(form, "executable").Text = "";
                Check(start.Enabled && !query.Enabled, "A new path should enable start only");
                Fire(start); await WaitFor(form);
                Check(!File.Exists(invalid) && output.Text.Contains("任务尚未发送"), "Invalid start created or sent a task");
                Field<TextBox>(form, "receipt").Text = receipt;
                Check(!start.Enabled && query.Enabled, "Returning to original receipt should prevent a new start");
                Fire(query); await WaitFor(form);
                Check(output.Text.Contains("退出码：0"), "Second query failed");
                Console.WriteLine("PASS: invalid start is blocked and the original receipt cannot be resubmitted");
                Field<TextBox>(form, "stateDirectory").Text = "/tmp/wrong-state";
                Fire(query); await WaitFor(form);
                Check(output.Text.Contains("无法确认"), "A mismatched state directory was accepted");
                Field<TextBox>(form, "stateDirectory").Text = state;
                Fire(query); await WaitFor(form);
                Check(output.Text.Contains("退出码：0"), "Original state directory did not recover the task");
                Field<TextBox>(form, "arguments").Clear();
                form.Size = form.MinimumSize; form.PerformLayout();
                Layout(form, Path.Combine(directory, "offscreen-layout-minimum.png"));
                Console.WriteLine("PASS: minimum-size layout controls and buttons fit");
                using (var reopened = new NonActivatingTaskManagerForm(connection, () => receipt)
                {
                    StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false
                })
                {
                    reopened.Show();
                    Field<TextBox>(reopened, "stateDirectory").Text = state;
                    Fire(Field<Button>(reopened, "browse"));
                    Check(!Field<Button>(reopened, "start").Enabled, "Reopened window allowed duplicate start");
                    Fire(Field<Button>(reopened, "query")); await WaitFor(reopened);
                    Check(Field<TextBox>(reopened, "output").Text.Contains("退出码：0"), "Reopened window did not recover the task");
                }
                Console.WriteLine("PASS: reopened window recovers the same task; target mismatch stays unknown");
                string longHost = string.Join('.', new[] { new string('a', 63), new string('b', 63), new string('c', 63), new string('d', 61) });
                using (var longTarget = new NonActivatingTaskManagerForm(connection with { Host = longHost }, () => null)
                {
                    StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ShowInTaskbar = false
                })
                {
                    longTarget.Show(); longTarget.Size = longTarget.MinimumSize;
                    Layout(longTarget, Path.Combine(directory, "offscreen-layout-long-host.png"));
                }
                Console.WriteLine("PASS: maximum-length host fits at minimum window size");
                exitCode = 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); }
            finally { context.ExitThread(); }
        };
        timer.Start(); Application.Run(context);
        timer.Dispose();
        Environment.ExitCode = exitCode;
    }
}
