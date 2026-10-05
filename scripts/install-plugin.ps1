$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ is required.' }
if (-not (Get-Command codex.exe -ErrorAction SilentlyContinue)) { throw 'Codex CLI was not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'plugins/start-buttons/dist/mcp.mjs'))) { throw 'Plugin build is missing. Run npm ci and npm run build first.' }

$configRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$configFile = Join-Path $configRoot 'config.toml'
if (Test-Path -LiteralPath $configFile) {
    $backupDirectory = Join-Path $configRoot ('start-buttons-backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    Copy-Item -LiteralPath $configFile -Destination (Join-Path $backupDirectory 'config.toml')
    Write-Output "Existing Codex config backed up: $backupDirectory"
}
& codex.exe plugin marketplace add $projectRoot --json
if ($LASTEXITCODE -ne 0) { throw 'Could not register the local marketplace.' }
# Update only this plugin's verified panel daemon. Startup targets are not managed here.
$dataDirectory = Join-Path $env:LOCALAPPDATA 'StartButtons'
$runtimeFile = Join-Path $dataDirectory 'runtime.json'
if (Test-Path -LiteralPath $runtimeFile) {
    $runtime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $health = $null
    if ($runtime.port -ge 1 -and $runtime.port -le 65535 -and $runtime.token -match '^[a-f0-9]{64}$') {
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($runtime.port)/api/health" -Headers @{ 'x-start-buttons-token' = $runtime.token } -TimeoutSec 2 } catch { }
    }
    if ($health -and $health.app -eq 'start-buttons' -and $health.dataDir -eq $dataDirectory) {
        $panelProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($runtime.pid)" -ErrorAction SilentlyContinue
        $sourcePanel = (Join-Path $projectRoot 'plugins/start-buttons/dist/panel.mjs').Replace('/', '\')
        $cacheRoot = (Join-Path $configRoot 'plugins/cache/start-buttons-local/start-buttons').Replace('/', '\') + '\'
        $commandLine = if ($panelProcess) { $panelProcess.CommandLine.Replace('/', '\') } else { '' }
        $isOurPanel = $panelProcess -and $panelProcess.Name -eq 'node.exe' -and $commandLine -match '(?:^|\s)--daemon(?:\s|$)' -and
            ($commandLine.Contains($sourcePanel) -or ($commandLine.Contains($cacheRoot) -and $commandLine.Contains('\dist\panel.mjs')))
        if (-not $isOurPanel) { throw 'The running panel could not be identified safely. Its process was not stopped.' }
        Stop-Process -Id $panelProcess.ProcessId -ErrorAction Stop
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if (-not (Get-Process -Id $panelProcess.ProcessId -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
        if (Get-Process -Id $panelProcess.ProcessId -ErrorAction SilentlyContinue) { throw 'The previous panel did not exit.' }
        Write-Output 'Previous Start Buttons panel stopped; project processes were preserved.'
    }
}
& codex.exe plugin add 'start-buttons@start-buttons-local' --json
if ($LASTEXITCODE -ne 0) {
    # Keep the updated standalone panel usable if a host still holds the cache.
    & node.exe (Join-Path $projectRoot 'plugins/start-buttons/dist/panel.mjs')
    throw 'Could not install Start Buttons. The local panel was restarted; close this plugin in Codex and retry installation.'
}
& codex.exe plugin list --marketplace 'start-buttons-local' --json
if ($LASTEXITCODE -ne 0) { throw 'Could not verify plugin installation.' }

& node.exe (Join-Path $projectRoot 'plugins/start-buttons/dist/panel.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Could not start the updated local panel.' }
$runtime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$($runtime.port)/api/health" -Headers @{ 'x-start-buttons-token' = $runtime.token } -TimeoutSec 2
$targetVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($health.app -ne 'start-buttons' -or $health.version -ne $targetVersion) { throw 'The active panel does not match the installed version.' }
Write-Output "Panel version $targetVersion is active. Refresh the existing panel page."
Write-Output 'Installed. Open a new Codex chat to load the skill and MCP tools.'
