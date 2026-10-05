$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$agentsPath = Join-Path $projectRoot 'AGENTS.md'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git'))) {
    throw 'Git repository is missing.'
}
$actual = [System.IO.File]::ReadAllText($agentsPath).Replace("`r`n", "`n").TrimEnd()
$expected = @'
# 注意事项

- 每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。
- 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。
'@
if ($actual -cne $expected.Replace("`r`n", "`n").TrimEnd()) {
    throw 'AGENTS.md does not match the requested development rules.'
}
Write-Output 'PASS: Git repository and AGENTS.md verified.'
