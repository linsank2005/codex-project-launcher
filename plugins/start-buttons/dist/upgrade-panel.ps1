param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$entry = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
if ($entry.pid -le 0 -or $entry.port -lt 1 -or $entry.port -gt 65535) { throw 'Invalid panel identity.' }
$record = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.pid)"
if (-not $record) { exit 0 }
if ($record.Name -ne 'node.exe') { throw 'The old panel is not a Node.js daemon.' }
$commandLine = $record.CommandLine.Replace('/', '\')
if ($commandLine -notmatch '(?:^|\s)--daemon(?:\s|$)') { throw 'The old panel is not an independent daemon.' }
$match = [regex]::Match($commandLine, '(?:^|\s)(?:"(?<file>[^"]+\\dist\\panel\.mjs)"|(?<file>\S+\\dist\\panel\.mjs))(?=\s|$)')
if (-not $match.Success) { throw 'The old panel entrypoint cannot be identified.' }
$panelFile = [IO.Path]::GetFullPath($match.Groups['file'].Value)
$cacheRoot = [IO.Path]::GetFullPath($entry.cacheRoot).TrimEnd('\') + '\'
$isCache = $panelFile.StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase)
$isSource = $panelFile.EndsWith('\plugins\start-buttons\dist\panel.mjs', [StringComparison]::OrdinalIgnoreCase)
if (-not ($isCache -or $isSource)) { throw 'The old panel is outside a recognized plugin location.' }
$listeners = @(Get-NetTCPConnection -LocalPort $entry.port -State Listen -ErrorAction SilentlyContinue)
if (-not ($listeners | Where-Object { $_.OwningProcess -eq $entry.pid -and $_.LocalAddress -eq '127.0.0.1' })) { throw 'The panel listener does not belong to the recorded process.' }
$target = Get-Process -Id $entry.pid
if (([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds() -ne ([DateTimeOffset]$record.CreationDate).ToUnixTimeMilliseconds()) { throw 'The panel process identity changed.' }
# Only the verified panel daemon; never terminate a process tree or business service.
Stop-Process -InputObject $target -ErrorAction Stop
