using System.ComponentModel;
using RemoteSsh;

class TaskManagerForm : Form
{
    const string IdleNotice = "新任务用新回执；未知状态先查原回执，勿重提；退出码 0 不代表命令成功。";
    readonly Connection connection;
    readonly Func<string?>? receiptPicker;
    readonly TextBox receipt = new(), stateDirectory = new(), workingDirectory = new(), executable = new();
    readonly TextBox arguments = new() { Multiline = true, ScrollBars = ScrollBars.Vertical, Height = 80, AcceptsReturn = true };
    readonly TextBox output = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill };
    readonly CheckBox capture = new() { Text = "保存输出（可能包含敏感内容，各最多 256 KiB）", AutoSize = true };
    readonly CheckBox privacy = new() { Text = "执行前检查出口（直接运行 Codex 时必选）", AutoSize = true };
    readonly CheckBox isolation = new() { Text = "隔离进程、网络和日志（部分服务器内部命令受限）", AutoSize = true };
    readonly CheckBox outerOnly = new() { Text = "仅用外层隔离（内层沙箱关闭；项目可写）", AutoSize = true };
    readonly TextBox privacyIpv4 = new() { Width = 140, PlaceholderText = "预期 IPv4" };
    readonly TextBox privacyIpv6 = new() { Width = 195, PlaceholderText = "预期 IPv6（可选）" };
    readonly Button browse = new() { Text = "选择…", AutoSize = true };
    readonly Button start = new() { Text = "开始新任务", AutoSize = true };
    readonly Button query = new() { Text = "重连并查询状态", AutoSize = true };
    readonly Button readOutput = new() { Text = "读取标准输出", AutoSize = true };
    readonly Button readError = new() { Text = "读取标准错误", AutoSize = true };
    readonly Label notice = new() { AutoSize = true, MaximumSize = new Size(750, 0) };
    readonly HashSet<string> attempted = new(StringComparer.OrdinalIgnoreCase);
    bool busy;

    public TaskManagerForm(Connection connection, Func<string?>? receiptPicker = null)
    {
        this.connection = connection;
        this.receiptPicker = receiptPicker;
        Text = "远端任务与断线恢复";
        ClientSize = new Size(900, 890); MinimumSize = new Size(780, 830);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Microsoft YaHei UI", 10);
        receipt.PlaceholderText = "新任务选新文件；查询时选择原回执";
        stateDirectory.PlaceholderText = "留空使用远端默认状态目录";
        workingDirectory.PlaceholderText = "留空使用远端默认工作目录";
        executable.PlaceholderText = "例如 /home/remoteuser/.local/bin/codex";
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(18), ColumnCount = 3, RowCount = 16 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 132));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
        for (int row = 0; row < 15; row++) grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var title = new Label { Text = "非交互任务与恢复", Font = new Font(Font.FontFamily, 16, FontStyle.Bold), AutoSize = true };
        grid.Controls.Add(title, 0, 0); grid.SetColumnSpan(title, 3);
        var target = new Label { Text = $"目标：{connection.User}@{connection.Host}:{connection.Port}。需要无需交互的私钥；不恢复交互终端，也不支持 SSH 来源中继。", AutoSize = true, MaximumSize = new Size(780, 0), Margin = new Padding(0, 5, 0, 8) };
        grid.Controls.Add(target, 0, 1); grid.SetColumnSpan(target, 3);
        Row("本机回执", receipt, 2); grid.Controls.Add(browse, 2, 2);
        Row("远端状态目录", stateDirectory, 3);
        Row("远端工作目录", workingDirectory, 4);
        Row("远端程序", executable, 5);
        Row("参数（每行一项）", arguments, 6);
        grid.Controls.Add(privacy, 1, 7); grid.SetColumnSpan(privacy, 2);
        grid.Controls.Add(isolation, 1, 8); grid.SetColumnSpan(isolation, 2);
        grid.Controls.Add(outerOnly, 1, 9); grid.SetColumnSpan(outerOnly, 2);
        var addresses = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        addresses.Controls.AddRange([privacyIpv4, privacyIpv6]); grid.Controls.Add(addresses, 1, 10); grid.SetColumnSpan(addresses, 2);
        grid.Controls.Add(capture, 1, 11); grid.SetColumnSpan(capture, 2);
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true };
        actions.Controls.AddRange([start, query, readOutput, readError]);
        grid.Controls.Add(actions, 0, 12); grid.SetColumnSpan(actions, 3);
        notice.Text = IdleNotice;
        notice.Margin = new Padding(0, 8, 0, 4);
        grid.Controls.Add(notice, 0, 13); grid.SetColumnSpan(notice, 3);
        var resultLabel = new Label { Text = "状态 / 输出", AutoSize = true, Margin = new Padding(0, 4, 0, 4) };
        grid.Controls.Add(resultLabel, 0, 14); grid.SetColumnSpan(resultLabel, 3);
        grid.Controls.Add(output, 0, 15); grid.SetColumnSpan(output, 3);
        Controls.Add(grid);
        receipt.TextChanged += (_, _) => RefreshButtons();
        executable.TextChanged += (_, _) =>
        {
            bool codex = PrivacyCommand.IsDirectCodex(executable.Text.Trim());
            if (codex) privacy.Checked = true;
            isolation.Checked = codex;
        };
        isolation.CheckedChanged += (_, _) =>
        {
            if (!isolation.Checked) outerOnly.Checked = false;
            RefreshButtons();
        };
        browse.Click += (_, _) => ChooseReceipt();
        start.Click += async (_, _) => await StartTask();
        query.Click += async (_, _) => await RunReadOnly(ManagedTaskAction.Status);
        readOutput.Click += async (_, _) => await RunReadOnly(ManagedTaskAction.Output);
        readError.Click += async (_, _) => await RunReadOnly(ManagedTaskAction.ErrorOutput);
        FormClosing += (_, e) => { if (busy) { e.Cancel = true; notice.Text = "正在等待任务请求结束；请保留回执。"; } };
        RefreshButtons();
        void Row(string label, Control control, int row)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
            control.Dock = DockStyle.Fill; control.Margin = new Padding(3, 4, 3, 4); grid.Controls.Add(control, 1, row);
        }
    }

    string? StateDirectory => string.IsNullOrWhiteSpace(stateDirectory.Text) ? null : stateDirectory.Text.Trim();
    void RefreshButtons()
    {
        string path = receipt.Text.Trim();
        bool exists = !string.IsNullOrEmpty(path) && File.Exists(path);
        start.Enabled = !busy && path.Length > 0 && !exists && !attempted.Contains(path);
        query.Enabled = readOutput.Enabled = readError.Enabled = !busy && exists;
        browse.Enabled = !busy;
        foreach (Control control in new Control[] { receipt, stateDirectory, workingDirectory, executable, arguments, capture, privacy, isolation, privacyIpv4, privacyIpv6 }) control.Enabled = !busy;
        outerOnly.Enabled = !busy && isolation.Checked;
    }

    void ChooseReceipt()
    {
        if (receiptPicker is not null)
        {
            var selected = receiptPicker();
            if (selected is not null) receipt.Text = selected;
            return;
        }
        using var picker = new SaveFileDialog
        {
            Title = "选择新回执路径，或选择已有回执进行查询",
            Filter = "JSON 回执 (*.json)|*.json|所有文件 (*.*)|*.*",
            CheckPathExists = true, OverwritePrompt = false,
            FileName = $"remote-task-{DateTime.Now:yyyyMMdd-HHmmss}.json"
        };
        if (picker.ShowDialog(this) == DialogResult.OK) receipt.Text = picker.FileName;
    }

    async Task StartTask()
    {
        string path = receipt.Text.Trim(); string? remoteRoot = StateDirectory;
        bool reserved = false;
        try
        {
            var argv = new List<string> { executable.Text.Trim() };
            argv.AddRange(arguments.Lines.Where(line => !string.IsNullOrWhiteSpace(line)));
            if (PrivacyCommand.IsDirectCodex(argv[0]) && !privacy.Checked)
                throw new ArgumentException("直接启动 Codex 必须检查预期出口。");
            string? workspace = string.IsNullOrWhiteSpace(workingDirectory.Text) ? null : workingDirectory.Text.Trim();
            if (isolation.Checked && (!privacy.Checked || !PrivacyCommand.IsDirectCodex(argv[0]) || argv.Count < 2 || argv[1] != "exec" || workspace is null))
                throw new ArgumentException("隔离模式需要 codex exec、出口检查和远端项目目录。");
            if (outerOnly.Checked)
            {
                if (!isolation.Checked) throw new ArgumentException("仅外层隔离必须启用进程、网络和日志隔离。");
                argv = PrivacyCommand.UseOuterSandboxOnly(argv.ToArray()).ToList();
            }
            string[] command = privacy.Checked ? PrivacyCommand.WrapManaged(argv.ToArray(),
                new PrivacyOptions(privacyIpv4.Text.Trim(), privacyIpv6.Text.Trim()), AppContext.BaseDirectory,
                isolation.Checked ? workspace : null) : argv.ToArray();
            var request = new ManagedTaskRequest(command,
                workspace, capture.Checked);
            byte[] payload = ManagedTask.EncodeRequest(request);
            // CreateNew prevents a second window or repeated click from reusing a receipt.
            Guid id = ManagedTask.ReserveReceipt(connection, path, remoteRoot);
            reserved = true;
            attempted.Add(path);
            busy = true; RefreshButtons();
            notice.Text = "回执已保存，正在发送一次启动请求；请勿关闭窗口。";
            var process = ManagedTask.Build(connection, path, remoteRoot, ManagedTaskAction.Start, id, AppContext.BaseDirectory);
            var result = await ManagedTask.RunAsync(process, payload, TimeSpan.FromSeconds(30));
            output.Text = ManagedTask.Describe(ManagedTaskAction.Start, result, id);
            notice.Text = "正在使用同一回执只读查询任务状态。";
            await QueryCore(path, remoteRoot, id);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception)
        {
            output.Text = (reserved ? "无法确认任务结果。请保留回执，查询原任务；不要换回执重试。\r\n" :
                "任务尚未发送。请检查输入；已有回执请使用状态查询。\r\n") + ex.Message;
        }
        finally { busy = false; RefreshButtons(); notice.Text = IdleNotice; }
    }

    async Task QueryCore(string path, string? remoteRoot, Guid? id = null)
    {
        var process = ManagedTask.Build(connection, path, remoteRoot, ManagedTaskAction.Status, null, AppContext.BaseDirectory);
        var result = await ManagedTask.RunAsync(process, null, TimeSpan.FromSeconds(55));
        output.AppendText(Environment.NewLine + Environment.NewLine + ManagedTask.Describe(ManagedTaskAction.Status, result, id));
    }

    async Task RunReadOnly(ManagedTaskAction action)
    {
        busy = true; RefreshButtons();
        notice.Text = action == ManagedTaskAction.Status ? "正在建立 SSH 并只读查询，不会重新启动任务。" : "正在读取保存的输出。";
        try
        {
            var process = ManagedTask.Build(connection, receipt.Text.Trim(), StateDirectory, action, null, AppContext.BaseDirectory);
            var result = await ManagedTask.RunAsync(process, null, TimeSpan.FromSeconds(action == ManagedTaskAction.Status ? 55 : 25));
            output.Text = ManagedTask.Describe(action, result);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception)
        {
            output.Text = "查询未确认，请保留回执，不要重新提交。\r\n" + ex.Message;
        }
        finally { busy = false; RefreshButtons(); notice.Text = IdleNotice; }
    }
}
