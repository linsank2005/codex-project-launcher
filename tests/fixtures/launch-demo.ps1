$demoOutput = Join-Path ([System.IO.Path]::GetTempPath()) 'StartButtons-demo.txt'
[System.IO.File]::WriteAllText($demoOutput, "Start Buttons demo completed`n" + (Get-Location).Path, [System.Text.Encoding]::UTF8)
Write-Output 'Start Buttons demo completed.'
exit
