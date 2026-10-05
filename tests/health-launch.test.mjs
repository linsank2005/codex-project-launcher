import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from '../src/panel.mjs';
import { launchProject } from '../src/launcher.mjs';
import { windowsPowerShellPath } from '../src/powershell.mjs';
import { tempDir, waitForFile } from './helpers.mjs';

const run = promisify(execFile), quote = value => "'" + value.replace(/'/g, "''") + "'";
test('Windows verifies the HTTP listener belongs to the original launch, rejects duplicates, and permits restart after Ctrl+C', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t), entry = path.join(dir, 'start.ps1');
  await copyFile(new URL('./fixtures/ctrl-service.mjs', import.meta.url), path.join(dir, 'ctrl-service.mjs'));
  await writeFile(entry, '& node.exe (Join-Path $PSScriptRoot "ctrl-service.mjs")\n', 'utf8');
  let calls = 0;
  const roots = [];
  const panel = await createPanelServer({ dataDir: path.join(dir, 'panel'), port: 0, template: '/*START_BUTTONS_CONFIG*/', launch: async p => {
    calls++;
    const started = await launchProject(p, { windowStyle: 'Hidden', keepOpen: true });
    roots.push(started.pid);
    return started;
  } });
  const call = async (route, input) => {
    const response = await fetch(panel.info.url + 'api/' + route, { method: input ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-start-buttons-token': panel.info.token }, body: input ? JSON.stringify(input) : undefined });
    return { status: response.status, data: await response.json() };
  };
  try {
    let { data: { project } } = await call('save', { name: 'owned HTTP fixture', type: 'file', path: entry });
    const started = await call('launch', { id: project.id });
    assert.equal(started.status, 200, started.data.error);
    assert.ok(started.data.startedAt);
    const ready = JSON.parse(await waitForFile(path.join(dir, 'ctrl-ready.json')));
    project = { ...project, healthUrl: `http://127.0.0.1:${ready.port}/` };
    const updated = await call('save', project);
    assert.equal(updated.data.statuses[project.id].state, 'running');
    assert.match(updated.data.statuses[project.id].detail, /已核验/);
    assert.equal((await call('launch', { id: project.id })).status, 409);
    assert.equal(calls, 1);
    await run(windowsPowerShellPath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixtures/send-console-ctrl.ps1', import.meta.url)),
      '-TargetPid', String(started.data.pid), '-ExpectedPids', [started.data.pid, ready.pid].join(',')], { windowsHide: true, timeout: 8000 });
    assert.equal(JSON.parse(await waitForFile(path.join(dir, 'ctrl-received.json'))).signal, 'SIGINT');
    const stopped = await call('projects');
    assert.equal(stopped.data.statuses[project.id].state, 'offline');
    assert.equal(stopped.data.statuses[project.id].canLaunch, true);
    await unlink(path.join(dir, 'ctrl-ready.json'));
    assert.equal((await call('launch', { id: project.id })).status, 200);
    assert.equal(calls, 2);
    const restarted = JSON.parse(await waitForFile(path.join(dir, 'ctrl-ready.json')));
    assert.ok(restarted.pid);
    const checked = await call('save', { ...project, healthUrl: `http://127.0.0.1:${restarted.port}/` });
    assert.equal(checked.data.statuses[project.id].state, 'running');
  } finally {
    await panel.close();
    // Re-check unique test paths before killing the owned fixture trees.
    for (const id of roots) {
      const code = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${id}'; if ($p -and $p.CommandLine.Contains(${quote(dir)})) { & taskkill.exe /PID ${id} /T /F | Out-Null }`;
      await run(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
    }
  }
});
