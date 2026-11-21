using RemoteSsh;

class PrivacyOptionsForm : Form
{
    readonly TextBox ipv4 = new() { Dock = DockStyle.Fill };
    readonly TextBox ipv6 = new() { Dock = DockStyle.Fill };
    readonly CheckBox relay = new() { Text = "通过本机 SOCKS5 中继连接 VPS", AutoSize = true, Checked = true };
    readonly NumericUpDown relayPort = new() { Minimum = 1, Maximum = 65535, Value = 7897, Dock = DockStyle.Fill };
    readonly TextBox relaySource = new() { Dock = DockStyle.Fill, PlaceholderText = "需要独立核实；未知时请勿猜测" };
    public PrivacyOptions? Options { get; private set; }

    public PrivacyOptionsForm()
    {
        Text = "Codex 出口隐私检查"; ClientSize = new Size(640, 410); MinimumSize = new Size(640, 440);
        StartPosition = FormStartPosition.CenterParent; Font = new Font("Microsoft YaHei UI", 10);
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(18), ColumnCount = 2, RowCount = 8 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 160)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var note = new Label { Text = "请输入独立核实的地址。检查会从 VPS 访问 ipify 和 icanhazip，不能保证 Codex 的实际路由。", AutoSize = true, MaximumSize = new Size(590, 0) };
        grid.Controls.Add(note, 0, 0); grid.SetColumnSpan(note, 2);
        grid.Controls.Add(new Label { Text = "预期 IPv4（必填）", AutoSize = true }, 0, 1); grid.Controls.Add(ipv4, 1, 1);
        grid.Controls.Add(new Label { Text = "预期 IPv6（可选）", AutoSize = true }, 0, 2); grid.Controls.Add(ipv6, 1, 2);
        grid.Controls.Add(relay, 0, 3); grid.SetColumnSpan(relay, 2);
        grid.Controls.Add(new Label { Text = "本机 SOCKS5 端口", AutoSize = true }, 0, 4); grid.Controls.Add(relayPort, 1, 4);
        grid.Controls.Add(new Label { Text = "预期中继出口 IP", AutoSize = true }, 0, 5); grid.Controls.Add(relaySource, 1, 5);
        var detail = new Label { Text = "来源不符时不会启动。中继只改变当前连接；旧日志、项目和其他信息仍可能包含本机地址。", AutoSize = true, MaximumSize = new Size(590, 0) };
        grid.Controls.Add(detail, 0, 6); grid.SetColumnSpan(detail, 2);
        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        var confirm = new Button { Text = "检查并启动", AutoSize = true };
        var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
        buttons.Controls.AddRange([confirm, cancel]); grid.Controls.Add(buttons, 1, 7);
        relay.CheckedChanged += (_, _) => { relayPort.Enabled = relay.Checked; relaySource.Enabled = relay.Checked; };
        confirm.Click += (_, _) =>
        {
            try { Options = new PrivacyOptions(ipv4.Text.Trim(), ipv6.Text.Trim(), relay.Checked ? (int)relayPort.Value : null,
                relay.Checked ? relaySource.Text.Trim() : null).Validated(); DialogResult = DialogResult.OK; Close(); }
            catch (ArgumentException ex) { MessageBox.Show(this, ex.Message, "地址无效", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        };
        Controls.Add(grid); AcceptButton = confirm; CancelButton = cancel;
    }
}
