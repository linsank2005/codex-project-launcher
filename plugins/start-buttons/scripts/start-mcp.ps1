$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$candidates = @()
if ($env:USERPROFILE) {
    $candidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
}
$installed = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if ($installed) { $candidates += $installed.Source }
foreach ($base in @($env:ProgramFiles, $env:ProgramW6432, $env:LOCALAPPDATA)) {
    if ($base) { $candidates += Join-Path $base 'nodejs/node.exe' }
}
$nodePath = $null
foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $version = & $candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $nodePath = $candidate; break }
    } catch { }
}
if (-not $nodePath) {
    [Console]::Error.WriteLine('Codex Project Launcher requires Node.js 22+. Install it from https://nodejs.org/en/download and restart Codex. No npm install is required.')
    exit 1
}
& $nodePath (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/mcp.mjs')
exit $LASTEXITCODE
