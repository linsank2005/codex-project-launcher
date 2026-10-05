param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProjectDockStop {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool ignore);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint groupId);
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
Check-Identity $root
[void][ProjectDockStop]::FreeConsole()
if (-not [ProjectDockStop]::AttachConsole([uint32]$request.targetPid)) { throw '无法连接此项目的独立终端。请使用原项目的停止命令或在原窗口退出。' }
try {
    $ids = New-Object uint32[] 1024
    $count = [ProjectDockStop]::GetConsoleProcessList($ids, $ids.Length)
    if ($count -eq 0 -or $count -gt $ids.Length) { throw '无法核验终端内的进程。' }
    foreach ($activeId in $ids[0..($count - 1)]) {
        if ($activeId -eq $PID) { continue }
        $expected = $request.processes | Where-Object { $_.pid -eq $activeId } | Select-Object -First 1
        if (-not $expected) { throw '此终端包含其他进程，未发送停止信号。请在原窗口退出。' }
        Check-Identity $expected
    }
    if (-not [ProjectDockStop]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) { throw '停止信号发送器初始化失败。' }
    if (-not [ProjectDockStop]::GenerateConsoleCtrlEvent(0, 0)) { throw '停止信号发送失败。' }
    [Threading.Thread]::Sleep(400)
} finally { [void][ProjectDockStop]::FreeConsole() }
@{ sent = $true } | ConvertTo-Json -Compress
} catch {
    @{ sent = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
