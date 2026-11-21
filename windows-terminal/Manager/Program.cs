using RemoteSsh;

internal static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            Connection? initial = null;
            if (args.Length != 0)
            {
                if (args.Length != 2 || args[0] != "--profile") throw new ArgumentException("用法：RemoteSsh.Manager.exe [--profile 配置.json]");
                if (new FileInfo(args[1]).Length > 16384) throw new ArgumentException("配置文件过大。");
                initial = ConnectionCodec.FromJson(File.ReadAllText(args[1]));
            }
            Application.Run(new ConnectionForm(initial));
            return 0;
        }
        catch (Exception ex) when (ex is ArgumentException or System.Text.Json.JsonException or IOException or UnauthorizedAccessException)
        {
            MessageBox.Show(ex.Message, "Remote SSH 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
