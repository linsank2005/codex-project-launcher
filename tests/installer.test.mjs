import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { windowsPowerShellPath } from '../src/powershell.mjs';

test('installer and console helpers parse with Windows PowerShell 5.1 before public distribution', { skip: process.platform !== 'win32' }, async () => {
  const files = ['scripts/install-plugin.ps1', 'plugins/start-buttons/scripts/start-mcp.ps1', 'src/launch.ps1', 'src/stop-console.ps1', 'src/upgrade-panel.ps1'].map(f => path.resolve(f));
  const encodedFiles = Buffer.from(JSON.stringify(files), 'utf8').toString('base64');
  const code = `$ErrorActionPreference='Stop'; $files=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFiles}'))|ConvertFrom-Json; $results=@(); foreach($file in $files) { $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count) { throw ('Script parse failed: ' + [IO.Path]::GetFileName($file)) }; $results+=@{name=[IO.Path]::GetFileName($file);errors=$errors.Count} }; ConvertTo-Json -InputObject $results -Compress`;
  const { stdout } = await promisify(execFile)(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
  const results = JSON.parse(stdout.trim());
  assert.equal(results.length, files.length); assert.ok(results.every(r => r.errors === 0));
});
