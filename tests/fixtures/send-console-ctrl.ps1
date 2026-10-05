param(
    [Parameter(Mandatory = $true)][uint32]$TargetPid,
    [Parameter(Mandatory = $true)][string]$ExpectedPids,
    [ValidateSet(0, 1)][uint32]$Event = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestConsoleSignal {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool ignore);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);
}
'@
[void][TestConsoleSignal]::FreeConsole()
if (-not [TestConsoleSignal]::AttachConsole($TargetPid)) { throw 'Could not attach to the owned test console.' }
try {
    $allowed = @($ExpectedPids.Split(',') | ForEach-Object { [uint32]$_ }) + @([uint32]$PID)
    $ids = New-Object uint32[] 128
    $count = [TestConsoleSignal]::GetConsoleProcessList($ids, $ids.Length)
    if ($count -eq 0 -or $count -gt $ids.Length) { throw 'Could not verify the test console process list.' }
    $active = @($ids[0..($count - 1)])
    if (@($active | Where-Object { $_ -notin $allowed }).Count) { throw 'Refusing to signal a console containing unrelated processes.' }
    if (-not [TestConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) { throw 'Could not protect the test sender.' }
    if (-not [TestConsoleSignal]::GenerateConsoleCtrlEvent($Event, 0)) { throw 'Could not deliver the console event.' }
    [Threading.Thread]::Sleep(400)
    @{ sent = $true; event = $Event; processes = $active } | ConvertTo-Json -Compress
} finally {
    [void][TestConsoleSignal]::FreeConsole()
}
