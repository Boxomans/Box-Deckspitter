// bds-scan: fast folder-size scanner for StoragePeek (Box-DocSpitter).
// Compiled on first use with the .NET Framework compiler that ships with Windows (C# 5, no downloads).
//
// Reads whole directories at a time with GetFileInformationByHandleEx (sizes come back with the listing,
// so there is no per-file stat), walks folders on several threads, counts on-disk (allocated) size, and
// counts hard-linked files once. Run elevated, it also enables SeBackupPrivilege to read protected folders.
//
// Usage: bds-scan.exe <folder> [--out <file>] [--threads N] [--min-file BYTES]
// Output (UTF-8 lines, tab separated):
//   A <admin 0|1>          M <ntfs file-table bytes>
//   D <id> <parentId> <name>                          a folder was found (parents always come first)
//   S <id> <allocBytes> <logicalBytes> <files> <denied 0|1>   a folder's own files were counted
//   F <dirId> <allocBytes> <name>                     a big file
//   T <ext> <allocBytes>   E <deniedFolders> <ms>     totals by extension, end of scan

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class BdsScan
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int infoClass, IntPtr buffer, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LookupPrivilegeValueW(string system, string name, out long luid);

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct TokenPrivileges { public int Count; public long Luid; public int Attributes; }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, int length, IntPtr previous, IntPtr returnLength);

    const uint FILE_LIST_DIRECTORY = 1, SHARE_ALL = 7, OPEN_EXISTING = 3, FLAG_BACKUP_SEMANTICS = 0x02000000;
    const int FileIdBothDirectoryInfo = 10, FileIdBothDirectoryRestartInfo = 11;
    const uint ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400;
    const uint TAG_MOUNT_POINT = 0xA0000003, TAG_SYMLINK = 0xA000000C;
    const int BUFFER = 256 * 1024;

    class Work { public int Id; public string Path; }

    static readonly ConcurrentStack<Work> stack = new ConcurrentStack<Work>();
    static readonly object outLock = new object();
    static readonly HashSet<long>[] seen = new HashSet<long>[64];
    static TextWriter output;
    static int nextId, pending, deniedDirs;
    static volatile bool cancelled;
    static bool dedupe;
    static long minFile = 1024 * 1024;

    static int Main(string[] args)
    {
        string root = null, outFile = null;
        int threads = Math.Min(16, Math.Max(4, Environment.ProcessorCount));
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) outFile = args[++i];
            else if (args[i] == "--threads" && i + 1 < args.Length) threads = Math.Max(1, int.Parse(args[++i]));
            else if (args[i] == "--min-file" && i + 1 < args.Length) minFile = long.Parse(args[++i]);
            else root = args[i];
        }
        if (root == null) { Console.Error.WriteLine("usage: bds-scan <folder> [--out file]"); return 1; }
        root = Path.GetFullPath(root);

        Stream stream = outFile != null
            ? new FileStream(outFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)
            : Console.OpenStandardOutput();
        output = new StreamWriter(stream, new UTF8Encoding(false), 1 << 16);
        string cancelFile = outFile != null ? outFile + ".cancel" : null;

        for (int i = 0; i < seen.Length; i++) seen[i] = new HashSet<long>();
        string volume = Path.GetPathRoot(root);
        try { string fs = new DriveInfo(volume).DriveFormat; dedupe = fs == "NTFS" || fs == "ReFS"; } catch { dedupe = false; }

        var started = DateTime.UtcNow;
        bool admin = EnableBackupPrivilege();
        Emit("A\t" + (admin ? 1 : 0) + "\n");
        if (string.Equals(volume, root, StringComparison.OrdinalIgnoreCase) && volume.Length == 3)
        {
            long mft = MftBytes(volume.Substring(0, 2));
            if (mft > 0) Emit("M\t" + mft + "\n");
        }
        Emit("D\t0\t-1\t" + root + "\n");
        pending = 1;
        stack.Push(new Work { Id = 0, Path = root });

        var flusher = new Thread(() =>
        {
            while (!cancelled && Volatile.Read(ref pending) > 0)
            {
                Thread.Sleep(150);
                lock (outLock) output.Flush();
                if (cancelFile != null && File.Exists(cancelFile)) cancelled = true;
            }
        });
        flusher.IsBackground = true;
        flusher.Start();

        var workers = new Thread[threads];
        var types = new Dictionary<string, long>[threads];
        for (int i = 0; i < threads; i++)
        {
            types[i] = new Dictionary<string, long>();
            workers[i] = new Thread(Worker, 256 * 1024);
            workers[i].IsBackground = true;
            workers[i].Start(types[i]);
        }
        foreach (var t in workers) t.Join();

        var total = new Dictionary<string, long>();
        foreach (var d in types)
            foreach (var kv in d) { long v; total.TryGetValue(kv.Key, out v); total[kv.Key] = v + kv.Value; }
        var sb = new StringBuilder();
        foreach (var kv in total) sb.Append("T\t").Append(kv.Key).Append('\t').Append(kv.Value).Append('\n');
        sb.Append("E\t").Append(deniedDirs).Append('\t').Append((long)(DateTime.UtcNow - started).TotalMilliseconds).Append('\n');
        Emit(sb.ToString());
        lock (outLock) output.Flush();
        output.Dispose();
        return cancelled ? 2 : 0;
    }

    static void Emit(string s) { lock (outLock) output.Write(s); }

    static void Worker(object state)
    {
        var types = (Dictionary<string, long>)state;
        IntPtr buf = Marshal.AllocHGlobal(BUFFER);
        var lines = new StringBuilder(4096);
        var children = new List<Work>();
        try
        {
            while (true)
            {
                Work w;
                if (stack.TryPop(out w))
                {
                    try { if (!cancelled) Scan(w, buf, types, lines, children); }
                    catch { /* keep going */ }
                    finally { Interlocked.Decrement(ref pending); }
                }
                else
                {
                    if (Volatile.Read(ref pending) <= 0 || cancelled) break;
                    Thread.Sleep(1);
                }
            }
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static string LongPath(string p)
    {
        if (p.StartsWith(@"\\?\")) return p;
        if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
        return @"\\?\" + p;
    }

    static bool FirstSeen(long id)
    {
        var set = seen[(int)((ulong)id % (ulong)seen.Length)];
        lock (set) return set.Add(id);
    }

    static void Scan(Work w, IntPtr buf, Dictionary<string, long> types, StringBuilder lines, List<Work> children)
    {
        lines.Clear();
        children.Clear();
        long own = 0, logical = 0;
        int count = 0;
        using (var h = CreateFileW(LongPath(w.Path), FILE_LIST_DIRECTORY, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
        {
            if (h.IsInvalid)
            {
                Interlocked.Increment(ref deniedDirs);
                Emit("S\t" + w.Id + "\t0\t0\t0\t1\n");
                return;
            }
            bool first = true;
            string prefix = w.Path.EndsWith("\\") ? w.Path : w.Path + "\\";
            while (!cancelled && GetFileInformationByHandleEx(h, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, buf, BUFFER))
            {
                first = false;
                int off = 0;
                while (true)
                {
                    IntPtr e = IntPtr.Add(buf, off);
                    int next = Marshal.ReadInt32(e, 0);
                    long eof = Marshal.ReadInt64(e, 40);
                    long alloc = Marshal.ReadInt64(e, 48);
                    uint attr = (uint)Marshal.ReadInt32(e, 56);
                    int nameBytes = Marshal.ReadInt32(e, 60);
                    uint tag = (uint)Marshal.ReadInt32(e, 64);
                    long fileId = Marshal.ReadInt64(e, 96);
                    string name = Marshal.PtrToStringUni(IntPtr.Add(e, 104), nameBytes / 2);
                    if ((attr & ATTR_DIRECTORY) != 0)
                    {
                        bool link = (attr & ATTR_REPARSE) != 0 && (tag == TAG_MOUNT_POINT || tag == TAG_SYMLINK);
                        if (name != "." && name != ".." && !link)
                        {
                            int id = Interlocked.Increment(ref nextId);
                            lines.Append("D\t").Append(id).Append('\t').Append(w.Id).Append('\t').Append(name).Append('\n');
                            children.Add(new Work { Id = id, Path = prefix + name });
                        }
                    }
                    else
                    {
                        count++;
                        if (!dedupe || fileId == 0 || FirstSeen(fileId))
                        {
                            own += alloc;
                            logical += eof;
                            int dot = name.LastIndexOf('.');
                            string ext = dot > 0 && name.Length - dot <= 12 ? name.Substring(dot + 1).ToLowerInvariant() : "";
                            long v;
                            types.TryGetValue(ext, out v);
                            types[ext] = v + alloc;
                            if (alloc >= minFile) lines.Append("F\t").Append(w.Id).Append('\t').Append(alloc).Append('\t').Append(name).Append('\n');
                        }
                    }
                    if (next == 0) break;
                    off += next;
                }
            }
        }
        lines.Append("S\t").Append(w.Id).Append('\t').Append(own).Append('\t').Append(logical).Append('\t').Append(count).Append("\t0\n");
        Emit(lines.ToString());
        // Children are queued only after their D lines are written, so a parent always appears before its children.
        foreach (var c in children) { Interlocked.Increment(ref pending); stack.Push(c); }
    }

    static bool EnableBackupPrivilege()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x08, out token)) return false;
        long luid;
        if (!LookupPrivilegeValueW(null, "SeBackupPrivilege", out luid)) return false;
        var tp = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
        if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return false;
        return Marshal.GetLastWin32Error() == 0;
    }

    // Size of the NTFS master file table (not visible as a normal file). Needs admin rights.
    static long MftBytes(string drive)
    {
        try
        {
            using (var h = CreateFileW(@"\\.\" + drive, 0x80000000, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
            {
                if (h.IsInvalid) return 0;
                IntPtr buf = Marshal.AllocHGlobal(512);
                try
                {
                    uint got;
                    if (!DeviceIoControl(h, 0x00090064, IntPtr.Zero, 0, buf, 512, out got, IntPtr.Zero)) return 0;
                    return Marshal.ReadInt64(buf, 56);
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }
        catch { return 0; }
    }
}
