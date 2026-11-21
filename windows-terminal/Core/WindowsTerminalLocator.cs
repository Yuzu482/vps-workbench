using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RemoteSsh;

// Official current-user known folder only; never derive another user's path,
// use PATH, or fall back to the installed package executable.
public static class WindowsTerminalLocator
{
    private static readonly Guid LocalAppData = new("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
    public static string ResolveCurrent()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out var token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法查询当前进程令牌。");
        using (token)
        {
            bool success = GetTokenInformation(token, 29, out int appContainer, sizeof(int), out int length);
            CheckTokenResult(success, length, success ? 0 : Marshal.GetLastWin32Error());
            if (appContainer != 0) throw new InvalidOperationException("当前进程在受限容器内，无法安全定位用户的 Windows Terminal 别名。请在正常用户桌面上下文运行此入口。");
        }
        IntPtr result = IntPtr.Zero;
        try
        {
            int status = SHGetKnownFolderPath(in LocalAppData, 0, IntPtr.Zero, out result);
            if (status != 0 || result == IntPtr.Zero) throw new InvalidOperationException("无法获取当前用户的 LocalAppData 已知文件夹。");
            return SelectAlias(false, Marshal.PtrToStringUni(result) ?? "", File.Exists);
        }
        finally { if (result != IntPtr.Zero) Marshal.FreeCoTaskMem(result); }
    }

    internal static void CheckTokenResult(bool success, int length, int error)
    {
        if (!success) throw new Win32Exception(error, "无法确定当前进程是否受容器限制。");
        if (length != sizeof(int)) throw new InvalidOperationException("当前进程令牌信息长度异常。");
    }

    internal static string SelectAlias(bool appContainer, string knownFolder, Func<string, bool> exists)
    {
        if (appContainer) throw new InvalidOperationException("受限容器不可定位用户别名。");
        if (string.IsNullOrEmpty(knownFolder) || !Path.IsPathFullyQualified(knownFolder)) throw new InvalidOperationException("当前用户的已知文件夹不可用。");
        string alias = Path.Combine(knownFolder, "Microsoft", "WindowsApps", "wt.exe");
        if (!exists(alias)) throw new InvalidOperationException("当前用户的 Windows Terminal 执行别名不可用，请核实安装和执行别名设置。");
        return alias;
    }
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeFileHandle token, int kind, out int value, int size, out int returned);
    [DllImport("shell32.dll", ExactSpelling = true)]
    private static extern int SHGetKnownFolderPath(in Guid folder, uint flags, IntPtr token, out IntPtr path);
}
