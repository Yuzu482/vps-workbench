using System.ComponentModel;
using System.Diagnostics;
using RemoteSsh;

class ConnectionForm : Form
{
    readonly Action<TaskManagerForm>? taskWindow;
    readonly Action<string>? taskError;
    readonly Action<ChatForm>? chatWindow;
    readonly TextBox host = new(), user = new(), identity = new(), known = new();
    readonly NumericUpDown port = new() { Minimum = 1, Maximum = 65535, Value = 22 };
    readonly ComboBox auth = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly CheckBox verified = new() { Text = "我已通过可信渠道核对主机指纹，并确认 known_hosts 记录正确", AutoSize = true };
    readonly Label status = new() { AutoSize = true, Text = "填写连接信息后，在独立 Windows Terminal 中登录。", MaximumSize = new Size(650, 0) };
    readonly Button connect = new() { Text = "打开 SSH 终端", AutoSize = true, Padding = new Padding(12, 4, 12, 4) };
    readonly Button diagnose = new() { Text = "测试连接", AutoSize = true, Padding = new Padding(12, 4, 12, 4) };
    readonly Button tasks = new() { Text = "远端任务与恢复", AutoSize = true, Padding = new Padding(12, 4, 12, 4) };
    readonly Button privacy = new() { Text = "隐私启动 Codex", AutoSize = true, Padding = new Padding(12, 4, 12, 4) };
    readonly Button chat = new() { Text = "打开对话工作台", AutoSize = true, Padding = new Padding(12, 4, 12, 4) };
    readonly CancellationTokenSource closing = new();

    public ConnectionForm(Connection? initial, Action<TaskManagerForm>? taskWindow = null, Action<string>? taskError = null, Action<ChatForm>? chatWindow = null)
    {
        this.taskWindow = taskWindow;
        this.taskError = taskError;
        this.chatWindow = chatWindow;
        Text = "Remote SSH · 测试版";
        ClientSize = new Size(760, 580); MinimumSize = new Size(720, 590);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 10);
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 3, RowCount = 13 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80));
        var title = new Label { Text = "连接远端开发环境", Font = new Font(Font.FontFamily, 18, FontStyle.Bold), AutoSize = true };
        grid.Controls.Add(title, 0, 0); grid.SetColumnSpan(title, 3);
        var subtitle = new Label { Text = "系统 OpenSSH 负责连接；Windows Terminal 负责终端交互。", AutoSize = true, Margin = new Padding(0, 6, 0, 18) };
        grid.Controls.Add(subtitle, 0, 1); grid.SetColumnSpan(subtitle, 3);
        Row("主机 / IP", host, 2); Row("端口", port, 3); Row("用户名", user, 4);
        auth.Items.AddRange(["SSH 密钥（支持口令）", "密码 / 键盘交互"]); auth.SelectedIndex = 0;
        Row("认证方式", auth, 5); Row("私钥文件", identity, 6); Row("known_hosts 文件", known, 7);
        Browse(identity, 6); Browse(known, 7);
        auth.SelectedIndexChanged += (_, _) => identity.Enabled = auth.SelectedIndex == 0;
        foreach (var field in new Control[] { host, user, identity, known, port, auth })
        {
            if (field is TextBox box) box.TextChanged += (_, _) => verified.Checked = false;
            else if (field is NumericUpDown number) number.ValueChanged += (_, _) => verified.Checked = false;
            else auth.SelectedIndexChanged += (_, _) => verified.Checked = false;
        }
        verified.Margin = new Padding(0, 14, 0, 10);
        grid.Controls.Add(verified, 0, 8); grid.SetColumnSpan(verified, 3);
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        actions.Controls.Add(connect); actions.Controls.Add(diagnose); actions.Controls.Add(tasks);
        grid.Controls.Add(actions, 1, 9);
        var workbenchActions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        workbenchActions.Controls.Add(chat); workbenchActions.Controls.Add(privacy); grid.Controls.Add(workbenchActions, 1, 10);
        status.Margin = new Padding(0, 14, 0, 6);
        grid.Controls.Add(status, 0, 11); grid.SetColumnSpan(status, 3);
        var note = new Label { Text = "普通终端中手动运行 codex 不会自动执行隐私检查。密码和私钥口令只在终端中输入。", AutoSize = true, MaximumSize = new Size(680, 0) };
        grid.Controls.Add(note, 0, 12); grid.SetColumnSpan(note, 3);
        Controls.Add(grid); AcceptButton = connect;
        if (initial is not null)
        {
            host.Text = initial.Host; port.Value = initial.Port; user.Text = initial.User;
            auth.SelectedIndex = initial.Authentication == Authentication.Key ? 0 : 1;
            identity.Text = initial.IdentityPath; known.Text = initial.KnownHostsPath;
        }
        connect.Click += async (_, _) => await Connect();
        privacy.Click += async (_, _) =>
        {
            if (!verified.Checked) { status.ForeColor = Color.Firebrick; status.Text = "请先核对主机指纹，再勾选确认。"; return; }
            using var dialog = new PrivacyOptionsForm();
            if (dialog.ShowDialog(this) == DialogResult.OK) await Connect(dialog.Options);
        };
        diagnose.Click += async (_, _) => await Diagnose();
        tasks.Click += (_, _) => OpenTasks();
        chat.Click += (_, _) => OpenChat();
        FormClosed += (_, _) => closing.Cancel();
        void Row(string label, Control control, int row)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
            control.Dock = DockStyle.Fill; control.Margin = new Padding(3, 5, 3, 5); grid.Controls.Add(control, 1, row);
        }
        void Browse(TextBox box, int row)
        {
            var button = new Button { Text = "浏览…", AutoSize = true, Anchor = AnchorStyles.Right };
            button.Click += (_, _) => { using var picker = new OpenFileDialog { Title = "选择 " + (box == identity ? "SSH 私钥" : "known_hosts"), CheckFileExists = true }; if (picker.ShowDialog(this) == DialogResult.OK) box.Text = picker.FileName; };
            grid.Controls.Add(button, 2, row);
        }
    }

    void OpenTasks()
    {
        try
        {
            if (!verified.Checked) throw new ArgumentException("请先核对主机指纹，再勾选确认。");
            var connection = new Connection(host.Text.Trim(), (int)port.Value, user.Text.Trim(),
                auth.SelectedIndex == 0 ? Authentication.Key : Authentication.Password,
                auth.SelectedIndex == 0 ? identity.Text.Trim() : "", known.Text.Trim());
            connection.Validate();
            if (connection.Authentication != Authentication.Key)
                throw new ArgumentException("托管任务需要无需交互的 SSH 私钥；密码模式请使用交互终端。");
            using var window = new TaskManagerForm(connection);
            if (taskWindow is null) window.ShowDialog(this); else taskWindow(window);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            status.ForeColor = Color.Firebrick; status.Text = ex.Message;
            if (taskError is null) MessageBox.Show(this, ex.Message, "无法打开任务窗口", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            else taskError(ex.Message);
        }
    }

    void OpenChat()
    {
        try
        {
            if (!verified.Checked) throw new ArgumentException("请先核对主机指纹，再勾选确认。");
            var connection = new Connection(host.Text.Trim(), (int)port.Value, user.Text.Trim(),
                auth.SelectedIndex == 0 ? Authentication.Key : Authentication.Password,
                auth.SelectedIndex == 0 ? identity.Text.Trim() : "", known.Text.Trim());
            connection.Validate();
            if (connection.Authentication != Authentication.Key)
                throw new ArgumentException("对话工作台需要无需交互的 SSH 私钥；密码模式请使用交互终端。");
            using var window = new ChatForm(connection);
            if (chatWindow is null) window.ShowDialog(this); else chatWindow(window);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            status.ForeColor = Color.Firebrick; status.Text = ex.Message;
            if (taskError is null) MessageBox.Show(this, ex.Message, "无法打开对话工作台", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            else taskError(ex.Message);
        }
    }

    async Task Diagnose()
    {
        diagnose.Enabled = false; connect.Enabled = false;
        try
        {
            string target = host.Text.Trim(); int targetPort = (int)port.Value;
            Connection.ValidateTarget(target, targetPort);
            status.ForeColor = SystemColors.ControlText;
            status.Text = "正在进行 3 次 DNS / TCP 检查；这不会登录 SSH。";
            var samples = await ConnectivityProbe.RunAsync(target, targetPort, 3,
                TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(1), closing.Token);
            var lines = samples.Select((sample, index) =>
                $"{index + 1}. 地址：{(sample.Resolved.Count == 0 ? "未取得" : string.Join(", ", sample.Resolved))}；" +
                (sample.Connected is null ? sample.Error : $"TCP 已连接 {sample.Connected}，{sample.ConnectMilliseconds} ms"));
            bool allResolved = samples.All(sample => sample.Resolved.Count > 0);
            bool changed = allResolved && samples.Skip(1).Any(sample =>
                !sample.Resolved.Select(address => address.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase)
                    .SetEquals(samples[0].Resolved.Select(address => address.ToString())));
            string comparison = !allResolved ? "有解析失败，无法比较地址变化。" : changed ?
                "这几次查询返回的地址集合不同；可能是 DNS 轮询或地址变化。" :
                "这几次查询返回的地址集合相同；这不代表长期固定。";
            bool targetChanged = !string.Equals(host.Text.Trim(), target, StringComparison.OrdinalIgnoreCase) || (int)port.Value != targetPort;
            status.Text = targetChanged ? "主机或端口已更改，请重新测试当前目标。" :
                $"连接检查完成：{samples.Count(sample => sample.Connected is not null)}/{samples.Count} 次 TCP 接通。";
            var testedTarget = $"本次检查的主机：{target}；端口：{targetPort}。" +
                (targetChanged ? " 当前输入已更改，请重新检查。" : "");
            MessageBox.Show(this, testedTarget + Environment.NewLine + string.Join(Environment.NewLine, lines) + Environment.NewLine + Environment.NewLine + comparison +
                Environment.NewLine + "TCP 接通不代表主机身份正确、SSH 已登录或会话稳定；仍需核对主机指纹。",
                "连接检查", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (OperationCanceledException) when (closing.IsCancellationRequested) { }
        catch (Exception ex) when (ex is ArgumentException or IOException or System.Net.Sockets.SocketException)
        {
            status.ForeColor = Color.Firebrick; status.Text = ex.Message;
            MessageBox.Show(this, ex.Message, "连接检查失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally { if (!IsDisposed) { diagnose.Enabled = true; connect.Enabled = true; } }
    }

    async Task Connect(PrivacyOptions? privacyOptions = null)
    {
        connect.Enabled = false; diagnose.Enabled = false;
        try
        {
            if (!verified.Checked) throw new ArgumentException("请先核对主机指纹，再勾选确认。");
            var connection = new Connection(host.Text.Trim(), (int)port.Value, user.Text.Trim(),
                auth.SelectedIndex == 0 ? Authentication.Key : Authentication.Password,
                auth.SelectedIndex == 0 ? identity.Text.Trim() : "", known.Text.Trim());
            _ = SshCommand.Build(connection);
            var start = TerminalCommand.Build(connection, WindowsTerminalLocator.ResolveCurrent(), Path.Combine(AppContext.BaseDirectory, "RemoteSsh.Console.exe"), privacyOptions);
            using var process = Process.Start(start) ?? throw new IOException("Windows Terminal 未能启动。");
            // The alias usually exits after forwarding the launch request. Detect
            // immediate errors but never report this as successful SSH login.
            var ended = process.WaitForExitAsync();
            if (await Task.WhenAny(ended, Task.Delay(1500)) == ended && process.ExitCode != 0)
                throw new IOException($"Windows Terminal 返回错误码 {process.ExitCode}。");
            status.ForeColor = SystemColors.ControlText;
            status.Text = "已请求打开 SSH 终端。连接、认证和错误信息请查看新终端窗口。";
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception)
        {
            status.ForeColor = Color.Firebrick; status.Text = ex.Message;
            MessageBox.Show(this, ex.Message, "无法打开连接", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally { if (!IsDisposed) { connect.Enabled = true; diagnose.Enabled = true; } }
    }
}
