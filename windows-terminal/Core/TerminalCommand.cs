using System.Diagnostics;

namespace RemoteSsh;

public static class TerminalCommand
{
    public static ProcessStartInfo Build(Connection connection, string terminalPath, string helperPath, PrivacyOptions? privacy = null)
    {
        connection.Validate();
        if (!File.Exists(terminalPath)) throw new FileNotFoundException("未找到 Windows Terminal。", terminalPath);
        if (!File.Exists(helperPath)) throw new FileNotFoundException("缺少 RemoteSsh.Console.exe，请重新构建完整发布目录。", helperPath);
        // WT parses semicolons even inside quoted command arguments. Configuration
        // travels as a base64url token; only the executable path crosses that parser.
        if (!Path.IsPathFullyQualified(helperPath) || helperPath.Any(c => char.IsControl(c) || c is ';' or '"'))
            throw new ArgumentException("程序目录不能包含分号或引号，请将测试版放在普通目录中。");
        var start = new ProcessStartInfo(terminalPath) { UseShellExecute = false };
        foreach (var arg in new[] { "-w", "-1", "new-tab", "--title", "Remote SSH", "--suppressApplicationTitle", helperPath, "--connection", ConnectionCodec.Encode(connection) })
            start.ArgumentList.Add(arg);
        if (privacy is not null)
        {
            var safe = privacy.Validated();
            start.ArgumentList.Add("--privacy-ipv4"); start.ArgumentList.Add(safe.ExpectedIpv4);
            if (safe.ExpectedIpv6 is not null) { start.ArgumentList.Add("--privacy-ipv6"); start.ArgumentList.Add(safe.ExpectedIpv6); }
            if (safe.SocksPort is int port)
            {
                start.ArgumentList.Add("--socks-port"); start.ArgumentList.Add(port.ToString(System.Globalization.CultureInfo.InvariantCulture));
                start.ArgumentList.Add("--expected-ssh-source"); start.ArgumentList.Add(safe.ExpectedSshSource!);
            }
        }
        return start;
    }
}
