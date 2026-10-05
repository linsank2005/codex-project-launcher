import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, copyFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from '../src/panel.mjs';
import { launchProject } from '../src/launcher.mjs';
import { windowsPowerShellPath } from '../src/powershell.mjs';
import { tempDir, waitForFile } from './helpers.mjs';

const run = promisify(execFile), quote = value => "'" + value.replace(/'/g, "''") + "'";
test('Windows XHS launcher contract transitions from stopped to preparing, running and Ctrl+C stopped, then starts again', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, 'scripts')); await mkdir(path.join(dir, 'data'));
  await copyFile(new URL('./fixtures/xhs-demo-launcher.mjs', import.meta.url), path.join(dir, 'scripts', 'launch.mjs'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'xiaohongshu-cover-simulator', scripts: { launch: 'node scripts/launch.mjs' } }));
  const entry = path.join(dir, 'start-windows.cmd');
  await writeFile(entry, '@echo off\r\npushd "%~dp0"\r\nnode scripts\\launch.mjs\r\npopd\r\n');
  const roots = [];
  let calls = 0;
  const panel = await createPanelServer({ dataDir: path.join(dir, 'panel'), port: 0, template: '/*START_BUTTONS_CONFIG*/', launch: async project => {
    calls++;
    const launched = await launchProject(project, { windowStyle: 'Hidden', keepOpen: true });
    roots.push(launched.pid);
    return launched;
  } });
  const call = async (route, input) => {
    const response = await fetch(panel.info.url + 'api/' + route, { method: input ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-start-buttons-token': panel.info.token }, body: input ? JSON.stringify(input) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const interrupt = async (root, ready) => {
    await run(windowsPowerShellPath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixtures/send-console-ctrl.ps1', import.meta.url)),
      '-TargetPid', String(root), '-ExpectedPids', [root, ready.pid].join(',')], { windowsHide: true, timeout: 8000 });
    assert.equal(JSON.parse(await waitForFile(path.join(dir, 'launcher-stopped.json'))).signal, 'SIGINT');
  };
  try {
    const { data: { project, statuses } } = await call('save', { name: 'independent XHS contract fixture', type: 'file', path: entry });
    assert.equal(statuses[project.id].state, 'offline');
    assert.equal(statuses[project.id].label, '未运行');
    const started = await call('launch', { id: project.id });
    assert.equal(started.status, 200, started.data.error);
    await waitForFile(path.join(dir, 'launcher-preparing.json'));
    const preparing = (await call('projects')).data.statuses[project.id];
    assert.equal(preparing.label, '启动中');
    assert.equal(preparing.canLaunch, false);
    assert.equal((await call('launch', { id: project.id })).status, 409);
    await writeFile(path.join(dir, 'continue-launch'), 'ready');
    const ready = JSON.parse(await waitForFile(path.join(dir, 'launcher-ready.json')));
    const running = (await call('projects')).data.statuses[project.id];
    assert.equal(running.state, 'running');
    assert.match(running.detail, new RegExp(`:${ready.port}/api/health`));
    assert.equal((await call('launch', { id: project.id })).status, 409);
    await interrupt(started.data.pid, ready);
    const stopped = (await call('projects')).data.statuses[project.id];
    assert.equal(stopped.state, 'offline');
    assert.equal(stopped.label, '未运行');
    assert.equal(stopped.canLaunch, true);
    assert.equal(calls, 1);
    await unlink(path.join(dir, 'launcher-ready.json'));
    await unlink(path.join(dir, 'launcher-stopped.json'));
    const second = await call('launch', { id: project.id });
    assert.equal(second.status, 200, second.data.error);
    const again = JSON.parse(await waitForFile(path.join(dir, 'launcher-ready.json')));
    assert.equal((await call('projects')).data.statuses[project.id].state, 'running');
    assert.equal(calls, 2);
    await interrupt(second.data.pid, again);
    assert.equal((await call('projects')).data.statuses[project.id].state, 'offline');
  } finally {
    await panel.close();
    for (const pid of roots) {
      const code = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CommandLine.Contains(${quote(dir)})) { & taskkill.exe /PID ${pid} /T /F | Out-Null }`;
      await run(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
    }
  }
});
