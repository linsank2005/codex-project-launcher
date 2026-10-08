param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
public static class ProjectDockStop {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool ignore);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint groupId);
    [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Screen { public Coord Size, Cursor; public short Attributes; public Rect Window; public Coord Maximum; }
    [StructLayout(LayoutKind.Explicit, Size=20, CharSet=CharSet.Unicode)] public struct Input {
        [FieldOffset(0)] public short Type;
        [FieldOffset(4)] public int Down;
        [FieldOffset(8)] public short Repeat;
        [FieldOffset(10)] public short Key;
        [FieldOffset(12)] public short Scan;
        [FieldOffset(14)] public char Character;
        [FieldOffset(16)] public int Control;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out Screen info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ReadConsoleOutputCharacter(IntPtr handle, [Out] char[] text, uint length, Coord start, out uint read);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteConsoleInput(IntPtr handle, Input[] events, uint length, out uint written);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool PeekConsoleInput(IntPtr handle, [Out] Input[] events, uint length, out uint read);
    static IntPtr Open(string name, uint access) {
        var handle = CreateFile(name, access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new InvalidOperationException("Cannot open console buffer.");
        return handle;
    }
    public static string[] Prompt() {
        var handle = Open("CONOUT$", 0x80000000);
        try {
            Screen info;
            if (!GetConsoleScreenBufferInfo(handle, out info)) throw new InvalidOperationException("Cannot read console cursor.");
            var start = new Coord { X = 0, Y = (short)Math.Max(0, info.Cursor.Y - 3) };
            var length = (uint)((info.Cursor.Y - start.Y) * info.Size.X + info.Cursor.X);
            if (length == 0 || length > 16384) return null;
            var text = new char[length]; uint read;
            if (!ReadConsoleOutputCharacter(handle, text, length, start, out read)) throw new InvalidOperationException("Cannot read console prompt.");
            // The console returns a character count, not a null-terminated string.
            // ponytail: Only standard English/Chinese CMD stop prompts; custom prompts need a project stop command.
            var match = Regex.Match(new string(text, 0, (int)read).Replace("\0", ""), @"(?:Terminate\s+batch\s+job|终止批处理(?:操作|作业)吗)\s*[（(]\s*Y\s*/\s*N\s*[)）]\s*[?？]\s*$", RegexOptions.IgnoreCase);
            return match.Success ? new[] { match.Value.Trim(), info.Cursor.Y + ":" + info.Cursor.X } : null;
        } finally { CloseHandle(handle); }
    }
    public static void Answer(bool yes, string prompt, string position) {
        var handle = Open("CONIN$", 0xC0000000);
        try {
            var queued = new Input[128]; uint read;
            if (!PeekConsoleInput(handle, queued, (uint)queued.Length, out read) || read == queued.Length) throw new InvalidOperationException("Cannot verify console input.");
            for (int i=0; i<read; i++) if (queued[i].Type == 1 && queued[i].Down != 0 && queued[i].Character != '\0') throw new InvalidOperationException("Console input is already pending; answer in the original window.");
            var current = Prompt();
            if (current == null || current[0] != prompt || current[1] != position) throw new InvalidOperationException("Console prompt changed; no answer sent.");
            var events = new Input[4]; var chars = new[] { yes ? 'Y' : 'N', '\r' };
            for (int i=0; i<events.Length; i++) events[i] = new Input { Type=1, Down=i%2 == 0 ? 1 : 0, Repeat=1, Key=(short)chars[i/2], Character=chars[i/2] };
            uint written;
            if (!WriteConsoleInput(handle, events, (uint)events.Length, out written) || written != events.Length) throw new InvalidOperationException("Cannot send console answer.");
        } finally { CloseHandle(handle); }
    }
}
'@
function Check-Identity($expected) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)" -ErrorAction Stop
    if (-not $process -or $process.SessionId -ne (Get-Process -Id $PID).SessionId -or
        $process.CreationDate.ToUniversalTime().ToString('o') -ne ([DateTime]::Parse($expected.born).ToUniversalTime().ToString('o'))) {
        throw '停止目标已变化，未发送信号。请刷新后重试。'
    }
}
$root = $request.processes | Where-Object { $_.pid -eq $request.targetPid } | Select-Object -First 1
if (-not $root) { throw '停止目标缺少身份记录。' }
if ($request.action -in @('read', 'answer') -and -not (Get-CimInstance Win32_Process -Filter "ProcessId=$($root.pid)")) {
    @{ sent = $true; closed = $true } | ConvertTo-Json -Compress
    return
}
Check-Identity $root
[void][ProjectDockStop]::FreeConsole()
if (-not [ProjectDockStop]::AttachConsole([uint32]$request.targetPid)) { throw '无法连接此项目的独立终端。请使用原项目的停止命令或在原窗口退出。' }
try {
    $ids = New-Object uint32[] 1024
    $count = [ProjectDockStop]::GetConsoleProcessList($ids, $ids.Length)
    if ($count -eq 0 -or $count -gt $ids.Length) { throw '无法核验终端内的进程。' }
    $hasCmd = $false
    foreach ($activeId in $ids[0..($count - 1)]) {
        if ($activeId -eq $PID) { continue }
        $expected = $request.processes | Where-Object { $_.pid -eq $activeId } | Select-Object -First 1
        if (-not $expected) { throw '此终端包含其他进程，未发送停止信号。请在原窗口退出。' }
        Check-Identity $expected
        if ((Get-Process -Id $activeId).ProcessName -eq 'cmd') { $hasCmd = $true }
    }
    $prompt = if ($hasCmd) { [ProjectDockStop]::Prompt() } else { $null }
    if ($request.action -eq 'answer') {
        if ($prompt -and ($prompt[0] -ne $request.prompt -or $prompt[1] -ne $request.position)) { throw '终端提问已变化，未发送选择。请刷新后重试。' }
        if ($prompt) {
            if ($request.answer -isnot [bool]) { throw '关闭确认必须选择是或否。' }
            [ProjectDockStop]::Answer($request.answer, $request.prompt, $request.position)
            [Threading.Thread]::Sleep(400)
        }
        $prompt = $null
    } elseif ($request.action -ne 'read' -and -not $prompt) {
        if (-not [ProjectDockStop]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) { throw '停止信号发送器初始化失败。' }
        if (-not [ProjectDockStop]::GenerateConsoleCtrlEvent(0, 0)) { throw '停止信号发送失败。' }
        $deadline = [DateTime]::UtcNow.AddMilliseconds($(if ($hasCmd) { 2500 } else { 400 }))
        do {
            [Threading.Thread]::Sleep(100)
            if ($hasCmd) { $prompt = [ProjectDockStop]::Prompt() }
        } while (-not $prompt -and [DateTime]::UtcNow -lt $deadline)
    }
    $reply = @{ sent = $true; mayConfirm = $hasCmd }
    if ($prompt) { $reply.confirmation = @{ prompt = $prompt[0]; position = $prompt[1] } }
} finally { [void][ProjectDockStop]::FreeConsole() }
$reply | ConvertTo-Json -Depth 4 -Compress
} catch {
    @{ sent = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
