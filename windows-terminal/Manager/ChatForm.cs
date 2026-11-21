using System.ComponentModel;
using System.Text.Json;
using RemoteSsh;

internal delegate Task<ManagedToolResult> ChatTaskRunner(ManagedTaskAction action, string receipt,
    string? stateDirectory, Guid? id, byte[]? payload);
internal delegate Task<ManagedToolResult> ChatUploadRunner(Guid conversation, Guid turn, IReadOnlyList<ChatAttachment> attachments);
internal delegate Task<ManagedToolResult> ChatAuthRunner(Guid conversation, Guid? accountSource);

class ChatForm : Form
{
    sealed class Turn(string receipt, ManagedReceipt record, ChatTurnRecord? saved, string? prompt)
    {
        public readonly string Receipt = receipt;
        public readonly ManagedReceipt Record = record;
        public readonly ChatTurnRecord? Saved = saved;
        public readonly string? Prompt = prompt;
        public string State = "unknown", Status = "尚未查询。", Output = "", Diagnostic = "";
        public bool OutputUnavailable, Truncated;
        public int? ExitCode;
    }
    sealed class Entry(ChatConversationRecord? conversation, List<Turn> turns, string title)
    {
        public ChatConversationRecord? Conversation = conversation;
        public List<Turn> Turns = turns;
        public readonly string Title = title;
        public Turn Last => Turns[^1];
        public override string ToString() => Title;
    }
    sealed record Draft(string Text, ChatAttachment[] Files);

    readonly Connection connection;
    readonly string receipts, appDirectory;
    readonly ChatTaskRunner? runner;
    readonly ChatUploadRunner? uploader;
    readonly ChatAuthRunner? authRunner;
    readonly Action<string>? loginHelp;
    readonly List<ChatAttachment> attachments = [];
    readonly Dictionary<string, Draft> drafts = new(StringComparer.Ordinal);
    string activeDraftKey = "new:codex";
    FileStream? sessionLock;
    readonly ListBox history = new() { Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, IntegralHeight = false };
    readonly Button fresh = new() { Text = "+ 新对话", Dock = DockStyle.Fill, Height = 38 };
    readonly Button openReceipt = new() { Text = "打开旧回执…", Dock = DockStyle.Fill, Height = 34 };
    readonly Button refresh = new() { Text = "查询状态", AutoSize = true };
    readonly Button diagnostics = new() { Text = "查看诊断", AutoSize = true };
    readonly Button send = new() { Text = "发送", AutoSize = true, Padding = new Padding(14, 5, 14, 5) };
    readonly Button addAttachment = new() { Text = "添加附件…", AutoSize = true };
    readonly Button clearAttachments = new() { Text = "清空附件", AutoSize = true };
    readonly Label attachmentStatus = new() { AutoSize = true, MaximumSize = new Size(600, 0), ForeColor = Color.DimGray };
    readonly ComboBox provider = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 145 };
    readonly ComboBox claudeAuth = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 150, Visible = false };
    readonly Panel claudeAuthSlot = new() { Width = 150, Height = 30, Margin = new Padding(3), Visible = false };
    readonly Label selectedClaudeAuth = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(5, 0, 0, 0), BorderStyle = BorderStyle.FixedSingle, ForeColor = Color.DimGray, BackColor = Color.FromArgb(245, 243, 238), Visible = false };
    readonly Button prepareLogin = new() { Text = "订阅登录步骤", AutoSize = true, Visible = false };
    readonly Button checkLogin = new() { Text = "检查订阅登录", AutoSize = true, Visible = false };
    readonly Button reuseAccount = new() { Text = "复用账号新对话", AutoSize = true, Visible = false };
    readonly Label selectedProvider = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(5, 0, 0, 0), BorderStyle = BorderStyle.FixedSingle, ForeColor = Color.DimGray, BackColor = Color.FromArgb(245, 243, 238), Visible = false };
    readonly TextBox workspace = new() { Dock = DockStyle.Fill, PlaceholderText = "/home/user/project" };
    readonly TextBox ipv4 = new() { Dock = DockStyle.Fill, PlaceholderText = "预期 VPS 出口 IPv4" };
    readonly CheckBox outerOnly = new() { Text = "仅外层隔离（内层关闭，项目可写）", AutoSize = true };
    readonly CheckBox capture = new() { Text = "同意保存对话及远端输出、附件", AutoSize = true };
    readonly RichTextBox transcript = new() { Dock = DockStyle.Fill, ReadOnly = true, BorderStyle = BorderStyle.None, DetectUrls = false };
    readonly TextBox composer = new() { Dock = DockStyle.Fill, Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical };
    readonly Label taskStatus = new() { AutoSize = true, MaximumSize = new Size(800, 0) };
    readonly System.Windows.Forms.Timer timer = new() { Interval = 4000 };
    readonly Font transcriptBold;
    bool busy, suppressSelection, subscriptionReady;
    string subscriptionStatus = "尚未检查订阅登录。", subscriptionState = "unchecked";

    public ChatForm(Connection connection, string? receiptDirectory = null, ChatTaskRunner? runner = null,
        string? appDirectory = null, ChatUploadRunner? uploader = null, ChatAuthRunner? authRunner = null, Action<string>? loginHelp = null)
    {
        this.connection = connection; this.runner = runner; this.uploader = uploader; this.authRunner = authRunner; this.loginHelp = loginHelp;
        this.appDirectory = appDirectory ?? AppContext.BaseDirectory;
        receipts = receiptDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RemoteSsh", "ChatReceipts");
        Text = "远端 AI 对话工作台";
        ClientSize = new Size(1120, 850); MinimumSize = new Size(900, 760);
        StartPosition = FormStartPosition.CenterParent; Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.FromArgb(250, 249, 246);
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 210)); root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var sidebar = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), RowCount = 5, ColumnCount = 1, BackColor = Color.FromArgb(239, 237, 230) };
        sidebar.RowStyles.Add(new RowStyle(SizeType.AutoSize)); sidebar.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        sidebar.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); sidebar.RowStyles.Add(new RowStyle(SizeType.AutoSize)); sidebar.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        sidebar.Controls.Add(new Label { Text = "远端工作台", Font = new Font(Font.FontFamily, 15, FontStyle.Bold), AutoSize = true, Margin = new Padding(0, 2, 0, 18) }, 0, 0);
        sidebar.Controls.Add(fresh, 0, 1); history.BackColor = sidebar.BackColor; history.Margin = new Padding(0, 14, 0, 10); sidebar.Controls.Add(history, 0, 2);
        sidebar.Controls.Add(openReceipt, 0, 3);
        sidebar.Controls.Add(new Label { Text = "消息保存在本机；远端保存会话、附件及输出。", AutoSize = true, MaximumSize = new Size(175, 0), ForeColor = Color.DimGray, Margin = new Padding(0, 12, 0, 0) }, 0, 4);
        root.Controls.Add(sidebar, 0, 0);
        var body = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(28, 20, 28, 16), ColumnCount = 1, RowCount = 9 };
        for (int i = 0; i < 4; i++) body.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        body.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        for (int i = 0; i < 4; i++) body.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        body.Controls.Add(new Label { Text = "远端对话", Font = new Font(Font.FontFamily, 18, FontStyle.Bold), AutoSize = true }, 0, 0);
        body.Controls.Add(new Label { Text = $"目标：{connection.User}@{connection.Host}:{connection.Port}  ·  SSH 直连", AutoSize = true, MaximumSize = new Size(780, 0), ForeColor = Color.DimGray, Margin = new Padding(0, 4, 0, 8) }, 0, 1);
        var settings = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 6, AutoSize = true, Margin = new Padding(0, 0, 0, 2) };
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); settings.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58));
        settings.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42));
        provider.Items.AddRange(["Codex", "Claude"]); provider.SelectedIndex = 0;
        var providerSlot = new Panel { Width = 145, Height = provider.PreferredHeight, Margin = new Padding(3) };
        provider.Dock = DockStyle.Fill; providerSlot.Controls.Add(provider); providerSlot.Controls.Add(selectedProvider);
        settings.Controls.Add(new Label { Text = "后端", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0); settings.Controls.Add(providerSlot, 1, 0);
        settings.Controls.Add(new Label { Text = "项目", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(8, 0, 4, 0) }, 2, 0); settings.Controls.Add(workspace, 3, 0);
        settings.Controls.Add(new Label { Text = "出口 IPv4", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(8, 0, 4, 0) }, 4, 0); settings.Controls.Add(ipv4, 5, 0); body.Controls.Add(settings, 0, 2);
        var options = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true, Margin = new Padding(0, 2, 0, 6) };
        claudeAuth.Items.AddRange(["API 密钥", "订阅（原生登录）"]); claudeAuth.SelectedIndex = 1;
        claudeAuth.Dock = DockStyle.Fill; claudeAuthSlot.Controls.Add(claudeAuth); claudeAuthSlot.Controls.Add(selectedClaudeAuth);
        options.Controls.Add(claudeAuthSlot); options.Controls.Add(prepareLogin); options.Controls.Add(checkLogin); options.Controls.Add(reuseAccount);
        options.Controls.Add(outerOnly); options.Controls.Add(capture); body.Controls.Add(options, 0, 3);
        transcript.BackColor = Color.White; transcript.Font = new Font(Font.FontFamily, 10.5f); transcriptBold = new Font(transcript.Font, FontStyle.Bold); transcript.Margin = new Padding(0, 0, 0, 8); body.Controls.Add(transcript, 0, 4);
        composer.Height = 70; composer.MaxLength = 8192; composer.PlaceholderText = "输入消息…"; composer.Margin = new Padding(0, 2, 0, 2);
        var composeArea = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = Padding.Empty };
        composeArea.Controls.Add(new Label { Text = "消息 · 草稿仅在当前窗口保留", AutoSize = true, ForeColor = Color.DimGray }, 0, 0); composeArea.Controls.Add(composer, 0, 1); body.Controls.Add(composeArea, 0, 5);
        var files = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true, Margin = Padding.Empty };
        files.Controls.Add(addAttachment); files.Controls.Add(clearAttachments); files.Controls.Add(attachmentStatus); body.Controls.Add(files, 0, 6);
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true, FlowDirection = FlowDirection.LeftToRight, Margin = Padding.Empty };
        actions.Controls.Add(send); actions.Controls.Add(refresh); actions.Controls.Add(diagnostics); body.Controls.Add(actions, 0, 7);
        taskStatus.ForeColor = Color.DimGray; taskStatus.Margin = new Padding(0, 5, 0, 0); body.Controls.Add(taskStatus, 0, 8);
        body.SizeChanged += (_, _) => taskStatus.MaximumSize = new Size(Math.Max(200, body.ClientSize.Width - body.Padding.Horizontal - 8), 0);
        root.Controls.Add(body, 1, 0); Controls.Add(root);
        foreach (var button in new[] { fresh, openReceipt, refresh, diagnostics, send, addAttachment, clearAttachments, prepareLogin, checkLogin, reuseAccount })
        {
            button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderColor = Color.FromArgb(210, 205, 195);
            button.BackColor = button == send ? Color.FromArgb(190, 106, 75) : Color.FromArgb(250, 249, 246);
            if (button == send) button.ForeColor = Color.White;
        }
        fresh.Click += (_, _) => NewTask(); openReceipt.Click += (_, _) => ChooseReceipt();
        history.SelectedIndexChanged += async (_, _) => { if (!suppressSelection) await SelectEntry(); };
        composer.TextChanged += (_, _) => RefreshControls();
        provider.SelectedIndexChanged += (_, _) =>
        {
            if (Selected is null && outerOnly.Checked) outerOnly.Checked = false;
            if (Selected is null) SwitchDraft(null);
            outerOnly.Text = provider.SelectedIndex == 1 ? "仅外层隔离（跳过 Claude 权限提示，项目可写）" : "仅外层隔离（内层关闭，项目可写）";
            Render(); RefreshControls();
        };
        claudeAuth.SelectedIndexChanged += (_, _) => { if (Selected is null) { SwitchDraft(null); subscriptionReady = false; subscriptionState = "unchecked"; subscriptionStatus = "尚未检查订阅登录。"; } Render(); RefreshControls(); };
        prepareLogin.Click += async (_, _) => await PrepareSubscription();
        checkLogin.Click += async (_, _) => await CheckSubscription();
        reuseAccount.Click += async (_, _) => await ReuseSubscription();
        capture.CheckedChanged += (_, _) => { Render(); RefreshControls(); };
        outerOnly.CheckedChanged += (_, _) => Render();
        addAttachment.Click += (_, _) => ChooseAttachments(); clearAttachments.Click += (_, _) => { attachments.Clear(); RefreshControls(); };
        send.Click += async (_, _) => await StartTask(); refresh.Click += async (_, _) => await RefreshSelected(); diagnostics.Click += async (_, _) => await ReadDiagnostics();
        timer.Tick += async (_, _) =>
        {
            if (busy || !IsRunning(Selected)) return;
            await RefreshSelected(1);
            var current = Selected;
            if (current is not null && IsSubscription(current) && !subscriptionReady && CanContinue(current)) await CheckSubscription();
        };
        FormClosing += (_, e) => { if (busy) { e.Cancel = true; taskStatus.Text = "正在处理请求；请保留回执。"; } };
        Disposed += (_, _) => { timer.Dispose(); sessionLock?.Dispose(); sessionLock = null; drafts.Clear(); attachments.Clear(); transcriptBold.Dispose(); };
        LoadReceipts(); Render(); RefreshControls();
    }

    Entry? Selected => history.SelectedItem as Entry;
    static bool IsRunning(Entry? entry) => entry is not null && entry.Turns.Count != 0 && entry.Last.State == "running";
    bool IsSubscription(Entry? entry) => entry?.Conversation?.ClaudeAuthMode == "subscription" ||
        (entry is null && provider.SelectedIndex == 1 && claudeAuth.SelectedIndex == 1);

    string DraftKey(Entry? entry) => entry?.Conversation is not null ? "conversation:" + entry.Conversation.Id.ToString("D") :
        entry is not null ? "receipt:" + entry.Last.Record.TaskId.ToString("D") : provider.SelectedIndex == 0 ? "new:codex" :
        claudeAuth.SelectedIndex == 1 ? "new:claude:subscription" : "new:claude:api_key";

    void SwitchDraft(Entry? entry)
    {
        string next = DraftKey(entry);
        if (next == activeDraftKey) return;
        if (composer.TextLength != 0 || attachments.Count != 0) drafts[activeDraftKey] = new Draft(composer.Text, attachments.ToArray());
        else drafts.Remove(activeDraftKey);
        activeDraftKey = next; composer.Clear(); attachments.Clear();
        if (drafts.Remove(next, out var draft)) { composer.Text = draft.Text; attachments.AddRange(draft.Files); }
    }

    void AdoptDraft(Entry entry)
    {
        drafts.Remove(activeDraftKey);
        activeDraftKey = DraftKey(entry);
    }

    Entry FromConversation(ChatConversationRecord record, Entry? previous = null)
    {
        var old = previous?.Turns.ToDictionary(t => t.Record.TaskId) ?? new Dictionary<Guid, Turn>();
        var turns = new List<Turn>();
        foreach (var item in record.Turns)
        {
            string path = Path.Combine(receipts, item.Receipt);
            if (old.TryGetValue(item.TaskId, out var prior))
            {
                var copy = new Turn(path, prior.Record, item, item.Prompt) { State = prior.State, Status = prior.Status, Output = prior.Output,
                    Diagnostic = prior.Diagnostic, OutputUnavailable = prior.OutputUnavailable, Truncated = prior.Truncated, ExitCode = prior.ExitCode };
                turns.Add(copy);
            }
            else turns.Add(new Turn(path, ManagedTask.ReadReceipt(connection, path), item, item.Prompt));
        }
        return new Entry(record, turns, (record.Provider == "codex" ? "Codex " : "Claude ") + record.Id.ToString("N")[..8]);
    }

    void LoadReceipts()
    {
        try
        {
            if (!Directory.Exists(receipts)) return;
            var used = new HashSet<Guid>();
            foreach (string path in Directory.EnumerateFiles(receipts, "conversation-*.json").OrderByDescending(File.GetLastWriteTimeUtc).Take(100))
                try { var record = ChatStore.Read(path, connection, receipts); history.Items.Add(FromConversation(record)); foreach (var turn in record.Turns) used.Add(turn.TaskId); }
                catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException) { }
            foreach (string path in Directory.EnumerateFiles(receipts, "task-*.json").OrderByDescending(Path.GetFileName).Take(100))
                try { var record = ManagedTask.ReadReceipt(connection, path); if (!used.Contains(record.TaskId)) history.Items.Add(new Entry(null, [new Turn(path, record, null, null)], "旧任务 " + record.TaskId.ToString("N")[..8])); }
                catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException) { }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { taskStatus.Text = "无法读取本机会话目录。"; }
    }

    async Task SelectEntry()
    {
        timer.Stop(); sessionLock?.Dispose(); sessionLock = null; SwitchDraft(Selected); subscriptionReady = false; subscriptionState = "unchecked"; subscriptionStatus = "尚未检查订阅登录。";
        var entry = Selected;
        if (entry?.Conversation is not null)
        {
            try
            {
                sessionLock = ChatStore.Lock(receipts, entry.Conversation.Id);
                var current = ChatStore.Read(ChatStore.PathFor(receipts, entry.Conversation.Id), connection, receipts);
                var replacement = FromConversation(current, entry); int index = history.SelectedIndex;
                suppressSelection = true; history.Items[index] = replacement; history.SelectedIndex = index; suppressSelection = false;
                entry = replacement;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or JsonException)
            { sessionLock?.Dispose(); sessionLock = null; if (entry.Turns.Count != 0) entry.Last.Status = "会话正由其他窗口使用，或本地记录无法读取；只能查询。"; else subscriptionStatus = "会话正由其他窗口使用，或本地记录无法读取。"; }
            workspace.Text = entry.Conversation!.Workspace; ipv4.Text = entry.Conversation.ExpectedIpv4;
            outerOnly.Checked = entry.Conversation.OuterOnly; provider.SelectedIndex = entry.Conversation.Provider == "codex" ? 0 : 1;
            claudeAuth.SelectedIndex = entry.Conversation.ClaudeAuthMode == "subscription" ? 1 : 0;
        }
        Render(); RefreshControls();
        if (entry is null) return;
        if (entry.Turns.Count != 0) await RefreshSelected(3);
        if (Selected == entry && IsSubscription(entry) && sessionLock is not null &&
            (entry.Turns.Count == 0 || CanContinue(entry))) await CheckSubscription();
    }

    void NewTask()
    {
        if (busy) return;
        timer.Stop();
        if (Selected is null) { composer.Clear(); attachments.Clear(); drafts.Remove(activeDraftKey); }
        else history.ClearSelected();
        sessionLock?.Dispose(); sessionLock = null; outerOnly.Checked = false; subscriptionReady = false; subscriptionState = "unchecked"; subscriptionStatus = "尚未检查订阅登录。"; Render(); RefreshControls(); composer.Focus();
    }

    void ChooseReceipt()
    {
        if (busy) return;
        using var picker = new OpenFileDialog { Title = "选择原任务回执", Filter = "JSON 回执 (*.json)|*.json|所有文件 (*.*)|*.*", CheckFileExists = true };
        if (Directory.Exists(receipts)) picker.InitialDirectory = receipts;
        if (picker.ShowDialog(this) != DialogResult.OK) return;
        try { AddReceipt(picker.FileName); }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException) { taskStatus.Text = ex.Message; }
    }

    internal void AddReceipt(string path)
    {
        var record = ManagedTask.ReadReceipt(connection, path);
        for (int i = 0; i < history.Items.Count; i++)
            if (history.Items[i] is Entry old && old.Turns.Any(t => t.Record.TaskId == record.TaskId && t.Record.StateDirectory == record.StateDirectory)) { history.SelectedIndex = i; return; }
        history.Items.Insert(0, new Entry(null, [new Turn(path, record, null, null)], "旧任务 " + record.TaskId.ToString("N")[..8])); history.SelectedIndex = 0;
    }

    void ChooseAttachments()
    {
        using var picker = new OpenFileDialog { Title = "选择附件（每个最多 5 MiB）", Multiselect = true, CheckFileExists = true };
        if (picker.ShowDialog(this) != DialogResult.OK) return;
        try { AddAttachmentPaths(picker.FileNames); }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException) { taskStatus.Text = "未添加附件：" + ex.Message; }
    }

    internal void AddAttachmentPaths(IEnumerable<string> paths)
    {
        var selected = new List<ChatAttachment>(attachments);
        foreach (string path in paths)
        {
            if (selected.Count >= 4) throw new ArgumentException("每轮最多选择 4 个附件。");
            selected.Add(ChatAttachments.Read(path, selected.Count + 1));
        }
        long otherDraftBytes = drafts.Values.Sum(d => d.Files.Sum(x => x.Size));
        if (selected.Sum(x => x.Size) + otherDraftBytes > ChatAttachments.MaxTotalBytes)
            throw new ArgumentException("所有未发送草稿的附件总大小不能超过 20 MiB；请先清空其他草稿的附件。");
        attachments.Clear(); attachments.AddRange(selected); RefreshControls();
    }

    bool CanContinue(Entry? entry)
    {
        if (entry?.Conversation is null || sessionLock is null || entry.Conversation.Turns.Count >= 100) return false;
        if (entry.Turns.Count == 0) return IsSubscription(entry);
        Turn last = entry.Last;
        Guid? expected = entry.Turns.Count > 1 ? entry.Turns[^2].Saved?.ThreadId : entry.Conversation.Provider == "claude" ? entry.Conversation.Id : null;
        var observed = ChatBackends.Completed(entry.Conversation.Provider, last.Output, last.State == "finished", last.ExitCode, last.Truncated, expected);
        return observed is not null && last.Saved?.ThreadId == observed;
    }

    void RefreshControls()
    {
        var entry = Selected; bool sub = IsSubscription(entry);
        bool editing = !busy && (entry is null || (entry.Conversation is not null && sessionLock is not null));
        bool nativeSub = sub && (entry is null || entry.Conversation?.NativeProfile == true);
        bool canSend = editing && (entry is null || CanContinue(entry)) && (!sub || nativeSub || subscriptionReady);
        bool sharedDraft = entry?.Conversation is not null && (entry.Conversation.NativeProfile || entry.Conversation.ClaudeAccountSourceId is not null) && entry.Turns.Count == 0 && sessionLock is not null;
        fresh.Enabled = openReceipt.Enabled = history.Enabled = !busy;
        composer.Enabled = addAttachment.Enabled = editing;
        clearAttachments.Enabled = editing && attachments.Count != 0;
        workspace.Enabled = ipv4.Enabled = outerOnly.Enabled = !busy && (entry is null || sharedDraft);
        provider.Enabled = !busy && entry is null;
        selectedProvider.Text = entry?.Conversation?.Provider == "claude" ? "Claude" : "Codex";
        selectedProvider.Visible = entry is not null; provider.Visible = entry is null;
        claudeAuthSlot.Visible = provider.SelectedIndex == 1;
        claudeAuth.Visible = entry is null; claudeAuth.Enabled = !busy && entry is null;
        selectedClaudeAuth.Visible = entry is not null; selectedClaudeAuth.Text = sub ? "订阅（原生登录）" : "API 密钥";
        prepareLogin.Visible = checkLogin.Visible = sub; prepareLogin.Enabled = !busy && (entry is null || sessionLock is not null);
        checkLogin.Enabled = !busy && (entry is null || (entry.Conversation is not null && sessionLock is not null));
        reuseAccount.Visible = sub && entry?.Conversation is not null && !entry.Conversation.NativeProfile;
        reuseAccount.Enabled = !busy && reuseAccount.Visible && entry!.Turns.Count != 0 && subscriptionReady && CanContinue(entry);
        capture.Enabled = !busy;
        send.Enabled = canSend && capture.Checked && (!string.IsNullOrWhiteSpace(composer.Text) || attachments.Count != 0);
        send.BackColor = send.Enabled ? Color.FromArgb(190, 106, 75) : Color.FromArgb(230, 226, 219); send.ForeColor = send.Enabled ? Color.White : Color.DimGray;
        refresh.Enabled = diagnostics.Enabled = !busy && entry is not null && entry.Turns.Count != 0;
        attachmentStatus.Text = attachments.Count == 0 ? "最多 4 个，每个 5 MiB；草稿合计 20 MiB" : string.Join("、", attachments.Select(a => a.DisplayName));
        composer.PlaceholderText = entry is not null && !CanContinue(entry) ? "可先写下一条；原任务确认完成后才能发送。" :
            sub && !subscriptionReady ? (nativeSub ? "发送时检查原生登录。" : "可先写草稿；确认订阅登录后才能发送。") : "输入消息…";
    }

    void Render()
    {
        var entry = Selected; transcript.Clear();
        void Line(string title, string value, Color color)
        {
            transcript.SelectionStart = transcript.TextLength; transcript.SelectionColor = color; transcript.SelectionFont = transcriptBold;
            transcript.AppendText(title + "\n"); transcript.SelectionFont = transcript.Font; transcript.AppendText(value + "\n\n");
        }
        if (entry is null)
        {
            Line("开始对话", "同一对话会恢复原生会话。消息保存在本机，远端会保存会话、附件和输出。", Color.FromArgb(62, 59, 54));
            taskStatus.Text = outerOnly.Checked ? "仅外层隔离：项目可写，任务程序可读取认证信息。" : IsSubscription(entry) ? "填写项目和出口；发送时自动检查原生登录。" : provider.SelectedIndex == 1 ? "Claude 使用 VPS 上配置的 API 密钥；默认只读。" : "填写项目目录和预期出口，确认保存后发送。";
            return;
        }
        if (entry.Turns.Count == 0 && IsSubscription(entry))
            Line("Claude 订阅对话", entry.Conversation?.NativeProfile == true ? "新对话使用 VPS 原生登录和独立会话 ID；账号配置及历史文件由 CLI 共用。" : entry.Conversation?.ClaudeAccountSourceId is null ? "该旧对话使用独立的远端登录目录。请先查看订阅登录步骤，完成原生登录后检查状态。" :
                "该对话复用远端账号凭据，原生历史独立。同账号任务不能同时运行；共同项目和账号凭据仍可被任务访问。", Color.FromArgb(62, 59, 54));
        foreach (var turn in entry.Turns)
        {
            string prompt = turn.Prompt ?? "（从旧回执恢复；本机未保存原任务内容）";
            if (turn.Saved?.Attachments.Count > 0) prompt += "\n附件：" + string.Join("、", turn.Saved.Attachments);
            Line("你", prompt, Color.FromArgb(106, 70, 54));
            foreach (var item in ChatBackends.Parse(entry.Conversation?.Provider ?? "codex", turn.Output, turn.State == "finished"))
            {
                Color color = item.Kind == ChatItemKind.Error ? Color.Firebrick : item.Kind == ChatItemKind.Assistant ? Color.FromArgb(40, 39, 37) : Color.FromArgb(100, 95, 86);
                Line(item.Title, item.Text, color);
            }
            if (turn.OutputUnavailable) Line("输出不可用", "该任务没有保存输出，或当前无法读取。", Color.DimGray);
            if (!string.IsNullOrEmpty(turn.Diagnostic)) Line("诊断", turn.Diagnostic.Length > 16000 ? turn.Diagnostic[..16000] + "\n…" : turn.Diagnostic, Color.Firebrick);
        }
        taskStatus.Text = entry.Turns.Count == 0 ? "尚未发送消息。" : entry.Last.Status + (CanContinue(entry) ? "  可以继续发送下一轮。" : "  查询原任务不会重复发送。");
        if (entry.Turns.Count > 3 && entry.Turns.Take(entry.Turns.Count - 3).Any(t => t.State == "unknown"))
            taskStatus.Text += "  较早消息尚未确认，可点击“查询状态”恢复。";
        if (IsSubscription(entry)) taskStatus.Text += "  " + subscriptionStatus;
        if (entry.Conversation?.NativeProfile == true) taskStatus.Text += "  原生账号共用配置及历史文件。";
        else if (entry.Conversation?.ClaudeAccountSourceId is not null) taskStatus.Text += "  复用账号：历史隔离，同账号任务不能同时运行。";
        else if (IsSubscription(entry) && subscriptionReady && entry.Turns.Count != 0 && CanContinue(entry))
            taskStatus.Text += "  试验性复用会共享凭据；目录结构变化将暂停来源及关联会话。";
        else if (IsSubscription(entry) && subscriptionReady && entry.Turns.Count == 0)
            taskStatus.Text += "  首轮确认完成后可试验复用账号。";
        if (entry.Conversation?.OuterOnly == true) taskStatus.Text += "  仅外层隔离：程序可读取认证信息。";
        transcript.SelectionStart = transcript.TextLength; transcript.ScrollToCaret();
    }

    Task<ManagedToolResult> Execute(ManagedTaskAction action, Turn turn, Guid? id = null, byte[]? payload = null)
    {
        if (runner is not null) return runner(action, turn.Receipt, turn.Record.StateDirectory, id, payload);
        var start = ManagedTask.Build(connection, turn.Receipt, turn.Record.StateDirectory, action, id, appDirectory);
        return ManagedTask.RunAsync(start, payload, TimeSpan.FromSeconds(action == ManagedTaskAction.Status ? 55 : 30));
    }

    Entry EnsureSubscriptionDraft()
    {
        if (Selected is Entry current) return current;
        Guid id = Guid.NewGuid();
        var record = new ChatConversationRecord { Id = id, Provider = "claude", ClaudeAuthMode = "subscription", NativeProfile = true,
            Host = connection.Host, Port = connection.Port, User = connection.User, Workspace = workspace.Text.Trim(),
            ExpectedIpv4 = ipv4.Text.Trim(), OuterOnly = outerOnly.Checked };
        sessionLock = ChatStore.Lock(receipts, id);
        try { ChatStore.Save(record, connection, receipts); }
        catch { sessionLock.Dispose(); sessionLock = null; throw; }
        var entry = new Entry(record, [], "Claude " + id.ToString("N")[..8]);
        suppressSelection = true; history.Items.Insert(0, entry); history.SelectedIndex = 0; suppressSelection = false;
        AdoptDraft(entry);
        return entry;
    }

    async Task PrepareSubscription()
    {
        if (busy || !IsSubscription(Selected)) return;
        try
        {
            var entry = EnsureSubscriptionDraft();
            if (entry.Conversation is null || sessionLock is null) return;
            await CheckSubscription(); // Also prepares the private remote directories.
            if (subscriptionState is not ("not_logged_in" or "wrong_auth" or "ready" or "shared_profile_changed")) return;
            string command = ClaudeSubscription.LoginCommand(ClaudeSubscription.ValidateSource(entry.Conversation, connection, receipts) ?? entry.Conversation.Id, entry.Conversation.NativeProfile);
            if (loginHelp is not null) { loginHelp(command); return; }
            using var dialog = new Form { Text = "Claude 原生订阅登录", StartPosition = FormStartPosition.CenterParent,
                Size = new Size(750, 410), MinimumSize = new Size(600, 350), Font = Font };
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 1, RowCount = 3 };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(680, 0), Text = subscriptionStatus + "\n在远端 SSH 终端运行以下命令，用 Anthropic 自己的流程选择 Claude 订阅账号登录；不要把验证码、链接或凭据发给工作台。完成后关闭终端并点击“检查订阅登录”。\n登录命令运行在普通 SSH 终端，浏览器走自身网络。登录前请确认同账号任务已结束。" +
                (entry.Conversation.NativeProfile ? "原生账号供新对话共用。" : "旧共享配置的结构变化可能继续阻止共享。") }, 0, 0);
            var text = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Text = command, Font = new Font("Consolas", 10), Margin = new Padding(0, 12, 0, 12) };
            layout.Controls.Add(text, 0, 1);
            var copy = new Button { Text = "复制命令", AutoSize = true }; copy.Click += (_, _) => Clipboard.SetText(command); layout.Controls.Add(copy, 0, 2);
            dialog.Controls.Add(layout); dialog.ShowDialog(this);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception)
        { subscriptionReady = false; taskStatus.Text = "尚未准备订阅会话：" + ex.Message; RefreshControls(); }
        finally { RefreshControls(); }
    }

    async Task ReuseSubscription()
    {
        var original = Selected?.Conversation;
        if (busy || original is null || Selected!.Turns.Count == 0 || !IsSubscription(Selected) || !subscriptionReady || !CanContinue(Selected)) return;
        FileStream? newLock = null;
        try
        {
            Guid source = ClaudeSubscription.ValidateSource(original, connection, receipts) ?? original.Id;
            Guid id = Guid.NewGuid();
            var record = new ChatConversationRecord { Id = id, Provider = "claude", ClaudeAuthMode = "subscription", ClaudeAccountSourceId = source,
                Host = connection.Host, Port = connection.Port, User = connection.User, Workspace = original.Workspace, ExpectedIpv4 = original.ExpectedIpv4, OuterOnly = false };
            _ = ClaudeSubscription.ValidateSource(record, connection, receipts);
            newLock = ChatStore.Lock(receipts, id);
            ChatStore.Save(record, connection, receipts);
            var entry = new Entry(record, [], "Claude " + id.ToString("N")[..8]);
            SwitchDraft(entry);
            sessionLock?.Dispose(); sessionLock = newLock; newLock = null;
            suppressSelection = true; history.Items.Insert(0, entry); history.SelectedIndex = 0; suppressSelection = false;
            outerOnly.Checked = false; subscriptionReady = false; subscriptionState = "unchecked"; subscriptionStatus = "尚未检查共享账号。";
            Render(); RefreshControls();
            await CheckSubscription();
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception or JsonException)
        { taskStatus.Text = "未创建可用的复用会话：" + ex.Message; }
        finally { newLock?.Dispose(); RefreshControls(); }
    }

    async Task<bool> CheckSubscription()
    {
        var entry = Selected;
        if (busy || !IsSubscription(entry)) return false;
        try { entry ??= EnsureSubscriptionDraft(); }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException)
        { subscriptionReady = false; subscriptionStatus = "尚未准备订阅会话：" + ex.Message; Render(); RefreshControls(); return false; }
        if (entry.Conversation is null || sessionLock is null) return false;
        subscriptionReady = false; subscriptionState = "checking"; busy = true; RefreshControls(); taskStatus.Text = "正在检查远端原生登录状态；不会发送模型消息。";
        try
        {
            Guid id = entry.Conversation.Id;
            Guid? source;
            try { source = ClaudeSubscription.ValidateSource(entry.Conversation, connection, receipts); }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException)
            { subscriptionState = "source_unavailable"; subscriptionStatus = "账号来源记录不可用；请保留回执并检查原对话。"; return false; }
            var result = authRunner is not null ? await authRunner(id, source) :
                await ManagedTask.RunAsync(ClaudeSubscription.BuildStatus(connection, id, appDirectory, source, entry.Conversation.NativeProfile), null, TimeSpan.FromSeconds(30));
            subscriptionState = ClaudeSubscription.Status(result, id);
            subscriptionReady = subscriptionState == "ready";
            subscriptionStatus = subscriptionState switch
            {
                "ready" => "原生 CLI 报告已登录；模型权限和网络仍需实际验证。",
                "not_logged_in" => "未检测到订阅登录；请查看登录步骤。",
                "cli_missing" => "远端未找到 Claude Code，请先安装独立 Linux 版本。",
                "cli_unsupported" => "远端 Claude 不是支持的独立 Linux 可执行文件。",
                "wrong_auth" => "当前认证不是 Claude 订阅；请查看登录步骤并选择订阅账号。",
                "wrong_profile" => "原生 CLI 报告的配置目录不匹配；已阻止发送。",
                "busy" => "账号或关联对话正在运行，请在任务结束后检查登录。",
                "shared_profile_changed" => "共享账号目录结构变化或不可安全隔离，已暂停关联会话；请保留远端数据并检查。",
                _ => "登录状态无法确认，请检查 SSH、原生 CLI 和隔离环境。"
            };
            return subscriptionReady;
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception)
        { subscriptionState = "unavailable"; subscriptionStatus = "登录状态无法确认，请检查 SSH、原生 CLI 和隔离环境。"; return false; }
        finally { busy = false; Render(); RefreshControls(); }
    }

    async Task StartTask()
    {
        var entry = Selected;
        if (busy || !capture.Checked || (entry is not null && !CanContinue(entry)) ||
            (IsSubscription(entry) && entry?.Conversation?.NativeProfile == false && !subscriptionReady)) return;
        Turn? turn = null; bool wasAdded = false;
        try
        {
            if (entry is null && IsSubscription(entry)) entry = EnsureSubscriptionDraft();
            string prompt = string.IsNullOrWhiteSpace(composer.Text) && attachments.Count != 0
                ? "逐份查看附件。列出文件名和一个要点，标明无法读取的附件。" : composer.Text;
            bool sharedDraft = entry?.Conversation is not null && (entry.Conversation.NativeProfile || entry.Conversation.ClaudeAccountSourceId is not null) && entry.Turns.Count == 0;
            string project = sharedDraft ? workspace.Text.Trim() : entry?.Conversation?.Workspace ?? workspace.Text.Trim();
            string address = sharedDraft ? ipv4.Text.Trim() : entry?.Conversation?.ExpectedIpv4 ?? ipv4.Text.Trim();
            bool outer = sharedDraft ? outerOnly.Checked : entry?.Conversation?.OuterOnly ?? outerOnly.Checked;
            string backend = entry?.Conversation?.Provider ?? (provider.SelectedIndex == 1 ? "claude" : "codex");
            Guid conversationId = entry?.Conversation?.Id ?? Guid.NewGuid(), id = Guid.NewGuid();
            Guid? thread = entry?.Turns.LastOrDefault()?.Saved?.ThreadId;
            var files = attachments.ToArray();
            string authMode = entry?.Conversation?.ClaudeAuthMode ?? "api_key";
            bool nativeProfile = entry?.Conversation?.NativeProfile ?? (backend == "codex");
            if (authMode == "subscription" && !await CheckSubscription()) return;
            var request = ChatBackends.Build(backend, prompt, project, new PrivacyOptions(address, null), outer, appDirectory, conversationId, id, thread, files, authMode, entry?.Conversation?.ClaudeAccountSourceId, nativeProfile);
            byte[] payload = ManagedTask.EncodeRequest(request);
            byte[]? upload = files.Length == 0 ? null : ChatAttachments.Encode(files);
            Directory.CreateDirectory(receipts);
            if (sharedDraft && entry?.Conversation is not null)
            {
                var record = entry.Conversation; string previousProject = record.Workspace, previousAddress = record.ExpectedIpv4; bool previousOuter = record.OuterOnly;
                record.Workspace = project; record.ExpectedIpv4 = address; record.OuterOnly = outer;
                try { ChatStore.Save(record, connection, receipts); }
                catch { record.Workspace = previousProject; record.ExpectedIpv4 = previousAddress; record.OuterOnly = previousOuter; throw; }
            }
            if (entry is null) sessionLock = ChatStore.Lock(receipts, conversationId);
            string path = Path.Combine(receipts, $"task-{DateTime.Now:yyyyMMdd-HHmmss}-{id:N}.json");
            ManagedTask.ReserveReceipt(connection, path, null, id);
            var saved = new ChatTurnRecord { TaskId = id, Receipt = Path.GetFileName(path), Prompt = prompt, Attachments = files.Select(x => x.DisplayName).ToList() };
            var conversation = entry?.Conversation ?? new ChatConversationRecord { Id = conversationId, Provider = backend, NativeProfile = nativeProfile, Host = connection.Host, Port = connection.Port, User = connection.User, Workspace = project, ExpectedIpv4 = address, OuterOnly = outer };
            conversation.Turns.Add(saved);
            try { ChatStore.Save(conversation, connection, receipts); }
            catch { conversation.Turns.Remove(saved); throw; }
            turn = new Turn(path, new ManagedReceipt(id, null), saved, prompt);
            if (entry is null)
            {
                entry = new Entry(conversation, [turn], (backend == "codex" ? "Codex " : "Claude ") + conversationId.ToString("N")[..8]);
                suppressSelection = true; history.Items.Insert(0, entry); history.SelectedIndex = 0; suppressSelection = false;
                AdoptDraft(entry);
            }
            else entry.Turns.Add(turn);
            wasAdded = true; composer.Clear(); attachments.Clear(); busy = true; RefreshControls();
            turn.Status = files.Length == 0 ? "回执已保存，正在发送一次启动请求。" : "回执已保存，正在上传选中的附件。"; Render();
            if (upload is not null)
            {
                var staged = uploader is not null ? await uploader(conversationId, id, files) :
                    await ManagedTask.RunAsync(ChatAttachments.BuildUpload(connection, conversationId, id, appDirectory), upload, TimeSpan.FromSeconds(120));
                if (!ChatAttachments.Confirmed(staged, conversationId, id, files))
                { turn.Status = "附件上传未确认，本轮任务未发送；不会自动重发。"; Render(); return; }
            }
            turn.Status = files.Length == 0 ? "正在发送一次启动请求。" : "附件已确认，正在发送一次启动请求。"; Render();
            var started = await Execute(ManagedTaskAction.Start, turn, id, payload);
            turn.Status = ManagedTask.Describe(ManagedTaskAction.Start, started, id);
            await RefreshCore(entry, turn);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception or JsonException)
        {
            if (!wasAdded) { if (Selected is null) { sessionLock?.Dispose(); sessionLock = null; } taskStatus.Text = "消息尚未发送：" + ex.Message; }
            else { turn!.State = "unknown"; turn.Status = "结果未确认；请保留回执并查询原任务，不要重复发送。"; Render(); }
        }
        finally { busy = false; RefreshControls(); if (IsRunning(Selected)) timer.Start(); }
    }

    static string State(ManagedToolResult result, Guid id, out bool outputUnavailable, out bool outputTruncated, out int? exitCode)
    {
        outputUnavailable = false; outputTruncated = false; exitCode = null;
        if (result.Uncertain || result.ExitCode != 0) return "unknown";
        try
        {
            using var document = JsonDocument.Parse(result.Output); var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("task_id", out var task) || task.ValueKind != JsonValueKind.String ||
                !Guid.TryParse(task.GetString(), out var observed) || observed != id ||
                !root.TryGetProperty("state", out var state) || state.ValueKind != JsonValueKind.String) return "unknown";
            string value = state.GetString() ?? "unknown";
            if (value == "finished")
            {
                if (!root.TryGetProperty("exit_code", out var exit) || exit.ValueKind != JsonValueKind.Number || !exit.TryGetInt32(out int code)) return "unknown";
                exitCode = code;
                if (root.TryGetProperty("output_captured", out var captured) && captured.ValueKind == JsonValueKind.False) outputUnavailable = true;
                if (root.TryGetProperty("output_truncated", out var truncated) && truncated.ValueKind == JsonValueKind.True) outputTruncated = true;
            }
            return value is "running" or "finished" or "launch_failed" ? value : "unknown";
        }
        catch (JsonException) { return "unknown"; }
    }

    async Task RefreshCore(Entry entry, Turn turn)
    {
        var status = await Execute(ManagedTaskAction.Status, turn);
        turn.State = State(status, turn.Record.TaskId, out bool noOutput, out bool truncated, out int? exitCode);
        turn.ExitCode = exitCode; turn.Truncated = truncated; turn.Status = ManagedTask.Describe(ManagedTaskAction.Status, status, turn.Record.TaskId);
        if (truncated) turn.Status += "\n输出已截断，无法确认完整会话。";
        turn.OutputUnavailable = noOutput;
        if ((turn.State is "running" or "finished") && !noOutput)
        {
            var output = await Execute(ManagedTaskAction.Output, turn);
            if (!output.Uncertain && output.ExitCode == 0) turn.Output = output.Output;
            else if (turn.State == "finished") turn.OutputUnavailable = true;
        }
        if (entry.Conversation is not null && turn.Saved is not null && sessionLock is not null)
        {
            int index = entry.Turns.IndexOf(turn); Guid? expected = index > 0 ? entry.Turns[index - 1].Saved?.ThreadId : entry.Conversation.Provider == "claude" ? entry.Conversation.Id : null;
            var id = ChatBackends.Completed(entry.Conversation.Provider, turn.Output, turn.State == "finished", turn.ExitCode, turn.Truncated, expected);
            if (id is not null && (turn.Saved.ThreadId is null || turn.Saved.ThreadId == id) && (index == 0 || expected is not null))
            {
                Guid? previous = turn.Saved.ThreadId; turn.Saved.ThreadId = id;
                try { ChatStore.Save(entry.Conversation, connection, receipts); }
                catch { turn.Saved.ThreadId = previous; throw; }
            }
        }
        if (Selected == entry) Render();
    }

    async Task RefreshSelected(int recentCount = 0)
    {
        var entry = Selected; if (busy || entry is null || entry.Turns.Count == 0) return;
        timer.Stop(); busy = true; RefreshControls(); taskStatus.Text = "正在查询原任务，不会重复发送。";
        try
        {
            var turns = recentCount > 0 ? entry.Turns.TakeLast(recentCount) : entry.Turns.Where(t => t.State == "unknown" || t == entry.Last);
            foreach (var turn in turns) await RefreshCore(entry, turn);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception)
        { entry.Last.State = "unknown"; entry.Last.Status = "查询未确认；保留回执，不要重复发送。"; Render(); }
        finally { busy = false; RefreshControls(); if (IsRunning(Selected)) timer.Start(); }
    }

    async Task ReadDiagnostics()
    {
        var entry = Selected; if (busy || entry is null || entry.Turns.Count == 0) return;
        timer.Stop(); busy = true; RefreshControls(); taskStatus.Text = "正在读取远端诊断。";
        try { var result = await Execute(ManagedTaskAction.ErrorOutput, entry.Last); entry.Last.Diagnostic = ManagedTask.Describe(ManagedTaskAction.ErrorOutput, result); Render(); }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception) { entry.Last.Diagnostic = "诊断暂时不可用。"; Render(); }
        finally { busy = false; RefreshControls(); if (IsRunning(Selected)) timer.Start(); }
    }
}
