import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { currentPanel } from '../src/panel.mjs';
import { windowsPowerShellPath } from '../src/powershell.mjs';
import { tempDir, waitForFile } from './helpers.mjs';

const run = promisify(execFile);
const native = { skip: process.platform !== 'win32' };
async function detachedPanel(t, dir) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/start-buttons/dist/panel.mjs', import.meta.url)), '--daemon'], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, START_BUTTONS_DATA_DIR: dir, START_BUTTONS_PORT: '0' },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  t.after(() => { if (child.exitCode === null) child.kill(); });
  for (let i = 0; i < 60; i++) {
    const info = await currentPanel(dir);
    if (info) return info;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Independent detached panel did not start.');
}
async function call(info, route, input) {
  const response = await fetch(info.url + 'api/' + route, { method: 'POST', headers: { 'x-start-buttons-token': info.token, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  assert.equal(response.ok, true, result.error);
  return result;
}

for (const kind of ['CMD', 'PowerShell file', 'PowerShell command', 'shortcut']) test(`${kind} launched through the detached panel receives console Ctrl+C and releases its listening port`, native, async t => {
  const dir = await tempDir(t), info = await detachedPanel(t, dir);
  await copyFile(new URL('./fixtures/ctrl-service.mjs', import.meta.url), path.join(dir, 'ctrl-service.mjs'));
  let input;
  if (kind === 'PowerShell command') input = { type: 'command', command: 'node.exe ctrl-service.mjs', cwd: dir };
  else {
    const entry = path.join(dir, kind === 'CMD' ? 'start.cmd' : kind === 'shortcut' ? 'start.lnk' : 'start.ps1');
    if (kind === 'shortcut') {
      const quote = value => "'" + value.replace(/'/g, "''") + "'";
      const setup = `$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut(${quote(entry)}); $link.TargetPath = ${quote(process.execPath)}; $link.Arguments = 'ctrl-service.mjs'; $link.WorkingDirectory = ${quote(dir)}; $link.Save()`;
      await run(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(setup, 'utf16le').toString('base64')], { windowsHide: true });
    } else await writeFile(entry, kind === 'CMD' ? '@echo off\r\nnode.exe ctrl-service.mjs\r\n' : '& node.exe (Join-Path $PSScriptRoot "ctrl-service.mjs")\n', 'utf8');
    input = { type: 'file', path: entry };
  }
  const { project } = await call(info, 'save', { name: 'owned console demo', ...input });
  const started = await call(info, 'launch', { id: project.id });
  let ready;
  try {
    ready = JSON.parse(await waitForFile(path.join(dir, 'ctrl-ready.json')));
    assert.equal((await fetch(`http://127.0.0.1:${ready.port}`)).status, 200);
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixtures/send-console-ctrl.ps1', import.meta.url)), '-TargetPid', String(started.pid), '-ExpectedPids', [...new Set([started.pid, ready.pid])].join(',')];
    const signal = await run(windowsPowerShellPath(), args, { windowsHide: true, timeout: 8000 });
    assert.equal(JSON.parse(signal.stdout.trim()).sent, true);
    const received = JSON.parse(await waitForFile(path.join(dir, 'ctrl-received.json')));
    assert.equal(received.signal, 'SIGINT');
    assert.equal(received.pid, ready.pid);
    await assert.rejects(fetch(`http://127.0.0.1:${ready.port}`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    await run('taskkill.exe', ['/PID', String(started.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    if (ready) await run('taskkill.exe', ['/PID', String(ready.pid), '/F'], { windowsHide: true }).catch(() => {});
  }
});
