param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $entry = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
    # The detached panel disables Ctrl+C for its Windows process group. Restore
    # the inherited setting before creating any project terminal or process.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StartButtonsConsole {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool ignore);
}
'@
    if (-not [StartButtonsConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)) {
        throw 'Could not restore Ctrl+C handling for the project launch.'
    }
    $startOptions = @{ PassThru = $true; WindowStyle = $entry.windowStyle }
    if ($entry.cwd) { $startOptions.WorkingDirectory = $entry.cwd }
    if ($entry.type -eq 'command') {
        $parseTokens = $null
        $parseErrors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($entry.command, [ref]$parseTokens, [ref]$parseErrors)
        if ($parseErrors.Count) { throw ('PowerShell command:{0}:{1}: {2}' -f $parseErrors[0].Extent.StartLineNumber, $parseErrors[0].Extent.StartColumnNumber, $parseErrors[0].Message) }
        $commandPayload = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(($entry | ConvertTo-Json -Compress)))
        $terminalScript = "`$entry = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$commandPayload')) | ConvertFrom-Json`nSet-Location -LiteralPath `$entry.cwd`n& ([scriptblock]::Create(`$entry.command))"
        $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($terminalScript))
        $terminalArgs = @('-NoLogo', '-NoProfile')
        if ($entry.keepOpen) { $terminalArgs += '-NoExit' }
        $terminalArgs += @('-EncodedCommand', $encodedCommand)
        $startOptions.FilePath = $entry.powershellPath
        $startOptions.ArgumentList = $terminalArgs
    } elseif ([System.IO.Path]::GetExtension($entry.path).ToLowerInvariant() -eq '.ps1') {
        $parseTokens = $null
        $parseErrors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($entry.path, [ref]$parseTokens, [ref]$parseErrors)
        if ($parseErrors.Count) { throw ('{0}:{1}:{2}: {3}' -f $entry.path, $parseErrors[0].Extent.StartLineNumber, $parseErrors[0].Extent.StartColumnNumber, $parseErrors[0].Message) }
        $terminalArgs = @('-NoLogo', '-NoProfile')
        if ($entry.keepOpen) { $terminalArgs += '-NoExit' }
        $terminalArgs += @('-ExecutionPolicy', 'Bypass', '-File', ('"' + $entry.path + '"'))
        $startOptions.FilePath = $entry.powershellPath
        $startOptions.ArgumentList = $terminalArgs
        if (-not $entry.cwd) { $startOptions.WorkingDirectory = [System.IO.Path]::GetDirectoryName($entry.path) }
    } else {
        $startOptions.FilePath = $entry.path
        if (-not $entry.cwd -and @('.cmd', '.bat') -contains [System.IO.Path]::GetExtension($entry.path).ToLowerInvariant()) {
            $startOptions.WorkingDirectory = [System.IO.Path]::GetDirectoryName($entry.path)
        }
    }
    $launched = Start-Process @startOptions
    $startedAt = $null
    # An entry that exits immediately may no longer expose its start time.
    try { if ($launched) { $startedAt = $launched.StartTime.ToUniversalTime().ToString('o') } } catch { }
    @{ accepted = $true; pid = $launched.Id; startedAt = $startedAt } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
