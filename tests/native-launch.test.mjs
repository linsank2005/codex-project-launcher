import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { launchProject } from '../src/launcher.mjs';
import { tempDir, waitForFile } from './helpers.mjs';

const native = { skip: process.platform !== 'win32' };
const hidden = { windowStyle: 'Hidden', keepOpen: false };
const quote = value => "'" + value.replace(/'/g, "''") + "'";
test('Windows launches a PowerShell file with spaces, Unicode, apostrophe and ampersand paths', native, async t => {
  const root = await tempDir(t), dir = path.join(root, "中文 空格 & O'Brien");
  await mkdir(dir);
  const script = path.join(dir, '启动 入口.ps1'), marker = path.join(dir, 'marker.txt');
  await writeFile(script, '\uFEFF' + `[IO.File]::WriteAllText(${quote(marker)}, (Get-Location).Path, [Text.Encoding]::UTF8)`);
  const result = await launchProject({ type: 'file', path: script, name: 'test', cwd: dir }, hidden);
  assert.equal(result.accepted, true);
  assert.equal((await waitForFile(marker)).replace(/^\uFEFF/, ''), dir);
});
test('Windows runs the original multiline PowerShell command in the configured project directory', native, async t => {
  const dir = await tempDir(t), marker = path.join(dir, 'command.txt');
  const command = `[IO.File]::WriteAllText(${quote(marker)}, "原有命令|" + (Get-Location).Path, [Text.Encoding]::UTF8)\nWrite-Output 'done'`;
  await launchProject({ type: 'command', command, cwd: dir, name: 'command' }, hidden);
  assert.equal((await waitForFile(marker)).replace(/^\uFEFF/, ''), `原有命令|${dir}`);
});
test('Windows launches a CMD entry from its own directory', native, async t => {
  const root = await tempDir(t), dir = path.join(root, 'CMD space & entry');
  await mkdir(dir);
  const script = path.join(dir, 'start.cmd'), marker = path.join(dir, 'cmd.txt');
  await writeFile(script, '@echo off\r\necho success>cmd.txt\r\n');
  await launchProject({ type: 'file', path: script, name: 'cmd' }, hidden);
  assert.equal((await waitForFile(marker)).trim(), 'success');
});
test('Windows shortcut retains its own working directory', native, async t => {
  const root = await tempDir(t), targetDir = path.join(root, 'shortcut target');
  await mkdir(targetDir);
  const marker = path.join(root, 'shortcut.txt'), script = path.join(root, 'target.ps1'), shortcut = path.join(root, 'original.lnk');
  await writeFile(script, `[IO.File]::WriteAllText(${quote(marker)}, (Get-Location).Path)`);
  const setup = `$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut(${quote(shortcut)}); $link.TargetPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $link.Arguments = '-NoProfile -File "${script}"'; $link.WorkingDirectory = ${quote(targetDir)}; $link.WindowStyle = 7; $link.Save()`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(setup, 'utf16le').toString('base64')], { windowsHide: true });
  await launchProject({ type: 'file', path: shortcut, name: 'lnk' }, hidden);
  assert.equal((await waitForFile(marker)).replace(/^\uFEFF/, ''), targetDir);
});
test('Windows runs an unchanged UTF-8 without BOM entry and its nested script with modern PowerShell features', native, async t => {
  const root = await tempDir(t), dir = path.join(root, "中文 嵌套 & O'Brien");
  await mkdir(dir);
  const entry = path.join(dir, '启动.ps1'), nested = path.join(dir, 'nested.ps1'), marker = path.join(dir, 'result.json');
  await writeFile(entry, "& (Join-Path $PSScriptRoot 'nested.ps1')\n", 'utf8');
  await writeFile(nested, `$ErrorActionPreference = 'Stop'\n$runtime = '{"api":123}' | ConvertFrom-Json -AsHashtable\n$record = @{ message = '安装依赖失败。'; major = $PSVersionTable.PSVersion.Major; api = $runtime.api; cwd = (Get-Location).Path; scriptRoot = $PSScriptRoot }\n[IO.File]::WriteAllText(${quote(marker)}, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))\n`, 'utf8');
  const result = await launchProject({ type: 'file', path: entry, name: 'UTF-8 regression' }, hidden);
  assert.equal(result.accepted, true);
  const record = JSON.parse(await waitForFile(marker));
  assert.equal(record.message, '安装依赖失败。');
  assert.ok(record.major >= 7);
  assert.equal(record.api, 123);
  assert.equal(record.cwd, dir);
  assert.equal(record.scriptRoot, dir);
  assert.equal((await readFile(nested, 'utf8')).startsWith('\uFEFF'), false);
});
test('Windows runs modern PowerShell commands instead of Windows PowerShell 5.1', native, async t => {
  const dir = await tempDir(t), marker = path.join(dir, 'modern-command.json');
  const command = `$value = '{"result":"采购核查台"}' | ConvertFrom-Json -AsHashtable\n[IO.File]::WriteAllText(${quote(marker)}, ($value | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))`;
  const result = await launchProject({ type: 'command', command, cwd: dir, name: 'modern command' }, hidden);
  assert.ok(Number(result.powershell.version.split('.')[0]) >= 7);
  assert.equal(JSON.parse(await waitForFile(marker)).result, '采购核查台');
});
test('Windows reports a broken original script in the panel before opening its terminal', native, async t => {
  const dir = await tempDir(t), script = path.join(dir, 'broken.ps1');
  await writeFile(script, "Write-Output 'unterminated\n", 'utf8');
  await assert.rejects(launchProject({ type: 'file', path: script, name: 'broken' }, hidden), error => {
    assert.ok(error.message.includes(`${script}:1:`));
    assert.match(error.message, /terminator|终止符/i);
    return true;
  });
});
test('Windows reports a broken PowerShell command before opening its terminal', native, async t => {
  const dir = await tempDir(t);
  await assert.rejects(launchProject({ type: 'command', command: "Write-Output 'unterminated", cwd: dir, name: 'broken command' }, hidden), /PowerShell command:1:/);
});
test('Windows launches updated code from the same saved entry path without recreating the shortcut', native, async t => {
  const dir = await tempDir(t), script = path.join(dir, 'same-entry.ps1');
  const first = path.join(dir, 'first.txt'), second = path.join(dir, 'second.txt');
  const project = { id: 'same-entry', name: 'updates', type: 'file', path: script };
  await writeFile(script, `[IO.File]::WriteAllText(${quote(first)}, 'version 1')`, 'utf8');
  await launchProject(project, hidden);
  assert.equal(await waitForFile(first), 'version 1');
  await writeFile(script, `[IO.File]::WriteAllText(${quote(second)}, 'version 2 最新代码', [Text.UTF8Encoding]::new($false))`, 'utf8');
  await launchProject(project, hidden);
  assert.equal(await waitForFile(second), 'version 2 最新代码');
});
