param([int]$Port = 0)
$ErrorActionPreference = 'Stop'
& node.exe (Join-Path $PSScriptRoot 'status-demo.mjs') --port $Port
if ($LASTEXITCODE -ne 0) { throw 'The independent status demo did not start.' }
