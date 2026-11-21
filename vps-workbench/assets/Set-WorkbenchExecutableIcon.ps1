[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Icon
)

$ErrorActionPreference = 'Stop'
if (!('VpsWorkbench.Win32Icon' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace VpsWorkbench
{
    public static class Win32Icon
    {
        // Electron's pinned Windows binary uses main icon group 1 in en-US.
        const ushort Language = 1033;
        static readonly IntPtr MainIcon = new IntPtr(1);
        static readonly IntPtr IconType = new IntPtr(3);
        static readonly IntPtr GroupIconType = new IntPtr(14);

        [DllImport("kernel32.dll", EntryPoint = "BeginUpdateResourceW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr BeginUpdate(string path, bool deleteExisting);
        [DllImport("kernel32.dll", EntryPoint = "UpdateResourceW", SetLastError = true)]
        static extern bool WriteResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
        [DllImport("kernel32.dll", EntryPoint = "EndUpdateResourceW", SetLastError = true)]
        static extern bool EndUpdate(IntPtr update, bool discard);
        [DllImport("kernel32.dll", EntryPoint = "LoadLibraryExW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr OpenResources(string path, IntPtr file, uint flags);
        [DllImport("kernel32.dll", EntryPoint = "FindResourceExW", SetLastError = true)]
        static extern IntPtr FindResource(IntPtr module, IntPtr type, IntPtr name, ushort language);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint SizeofResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr LockResource(IntPtr data);
        [DllImport("kernel32.dll")]
        static extern bool FreeLibrary(IntPtr module);

        public static int Apply(string executable, string ico)
        {
            byte[] source = File.ReadAllBytes(ico);
            if (source.Length < 22 || BitConverter.ToUInt16(source, 0) != 0 ||
                BitConverter.ToUInt16(source, 2) != 1)
                throw new InvalidDataException("Invalid Windows icon header.");
            int count = BitConverter.ToUInt16(source, 4);
            int tableEnd = 6 + 16 * count;
            if (count < 1 || count > 32 || tableEnd > source.Length)
                throw new InvalidDataException("Invalid Windows icon directory.");
            var frames = new byte[count][];
            byte[] group;
            using (var output = new MemoryStream())
            using (var writer = new BinaryWriter(output))
            {
                writer.Write(source, 0, 6);
                for (int index = 0; index < count; index++)
                {
                    int entry = 6 + 16 * index;
                    int size = BitConverter.ToInt32(source, entry + 8);
                    int offset = BitConverter.ToInt32(source, entry + 12);
                    if (size < 8 || offset < tableEnd || offset > source.Length || size > source.Length - offset)
                        throw new InvalidDataException("Invalid Windows icon frame.");
                    frames[index] = new byte[size];
                    Buffer.BlockCopy(source, offset, frames[index], 0, size);
                    writer.Write(source, entry, 12);
                    writer.Write((ushort)(index + 1));
                }
                writer.Flush();
                group = output.ToArray();
            }

            IntPtr probe = OpenResources(executable, IntPtr.Zero, 0x22);
            if (probe == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { ReadResource(probe, GroupIconType, MainIcon); }
            finally { FreeLibrary(probe); }

            IntPtr update = BeginUpdate(executable, false);
            if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                for (int index = 0; index < count; index++)
                    WriteChecked(update, IconType, new IntPtr(index + 1), frames[index]);
                WriteChecked(update, GroupIconType, MainIcon, group);
            }
            catch
            {
                EndUpdate(update, true);
                throw;
            }
            if (!EndUpdate(update, false)) throw new Win32Exception(Marshal.GetLastWin32Error());

            IntPtr verified = OpenResources(executable, IntPtr.Zero, 0x22);
            if (verified == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                if (!ReadResource(verified, GroupIconType, MainIcon).AsSpan().SequenceEqual(group))
                    throw new InvalidDataException("The embedded icon group failed verification.");
                for (int index = 0; index < count; index++)
                    if (!ReadResource(verified, IconType, new IntPtr(index + 1)).AsSpan().SequenceEqual(frames[index]))
                        throw new InvalidDataException("An embedded icon frame failed verification.");
            }
            finally { FreeLibrary(verified); }
            return count;
        }

        static void WriteChecked(IntPtr update, IntPtr type, IntPtr name, byte[] bytes)
        {
            if (!WriteResource(update, type, name, Language, bytes, (uint)bytes.Length))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        static byte[] ReadResource(IntPtr module, IntPtr type, IntPtr name)
        {
            IntPtr resource = FindResource(module, type, name, Language);
            if (resource == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            int size = checked((int)SizeofResource(module, resource));
            IntPtr data = LoadResource(module, resource);
            if (data == IntPtr.Zero || size < 1) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr bytes = LockResource(data);
            if (bytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var result = new byte[size];
            Marshal.Copy(bytes, result, 0, result.Length);
            return result;
        }
    }
}
'@
}
$file = (Get-Item -LiteralPath $Executable).FullName
$asset = (Get-Item -LiteralPath $Icon).FullName
if ([IO.Path]::GetExtension($file) -ne '.exe' -or [IO.Path]::GetExtension($asset) -ne '.ico') {
    throw 'Expected an executable build output and a Windows .ico asset.'
}
$frames = [VpsWorkbench.Win32Icon]::Apply($file, $asset)
Write-Output "Embedded and verified $frames icon sizes."
