import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPanelServer } from '../src/panel.mjs';
import { launchProject } from '../src/launcher.mjs';
import { inspectProjectProcesses } from '../src/status.mjs';
import { sendConsoleStop } from '../src/stop.mjs';
import { windowsPowerShellPath } from '../src/powershell.mjs';
import { tempDir, waitForFile } from './helpers.mjs';

const run = promisify(execFile), quote = s => "'" + s.replace(/'/g, "''") + "'";
const native = { skip: process.platform !== 'win32', timeout: 120000 };

for (const kind of ['CMD', 'PowerShell file', 'PowerShell command', 'shortcut']) {
  test(`${kind}: panel stop/restart exits the service, restores launch records, and preserves another service`, native, async t => {
    const dir = await tempDir(t), receipts = [];
    await copyFile(new URL('./fixtures/ctrl-service.mjs', import.meta.url), path.join(dir, 'ctrl-service.mjs'));
    let input;
    if (kind === 'PowerShell command') input = { type: 'command', command: 'node.exe ctrl-service.mjs', cwd: dir };
    else {
      const file = path.join(dir, kind === 'CMD' ? 'start.cmd' : kind === 'shortcut' ? 'start.lnk' : 'start.ps1');
      if (kind === 'shortcut') {
        const setup = `$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut(${quote(file)}); $link.TargetPath=${quote(process.execPath)}; $link.Arguments='ctrl-service.mjs'; $link.WorkingDirectory=${quote(dir)}; $link.Save()`;
        await run(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(setup, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
      } else await writeFile(file, kind === 'CMD' ? '@echo off\r\nnode.exe ctrl-service.mjs\r\n' : '& node.exe (Join-Path $PSScriptRoot "ctrl-service.mjs")\n');
      input = { type: 'file', path: file };
    }
    const options = { dataDir: path.join(dir, 'panel'), port: 0, template: '/*START_BUTTONS_CONFIG*/',
      launch: async project => {
        const receipt = await launchProject(project, { windowStyle: 'Hidden', keepOpen: true });
        receipts.push(receipt); return receipt;
      } };
    let panel = await createPanelServer(options), otherReady;
    const call = async (route, input) => {
      const response = await fetch(panel.info.url + 'api/' + route, { method: input ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-start-buttons-token': panel.info.token },
        body: input ? JSON.stringify(input) : undefined, signal: AbortSignal.timeout(60000) });
      const data = await response.json(); assert.equal(response.status, 200, data.error); return data;
    };
    try {
      const { project } = await call('save', { name: 'Lifecycle fixture', ...input });
      const first = await call('launch', { id: project.id });
      const ready = JSON.parse(await waitForFile(path.join(dir, 'ctrl-ready.json')));
      const observed = await call('projects');
      assert.equal(observed.statuses[project.id].state, 'running');
      assert.equal(observed.statuses[project.id].canStop, true);
      const processes = await inspectProjectProcesses(project, { launches: observed.launches });

      // A recycled PID or a console member not in the ownership set must receive no signal.
      if (kind === 'CMD') {
        const identities = processes.owned.map(p => ({ pid: p.pid, born: p.born }));
        await assert.rejects(sendConsoleStop(first.pid, identities.map(p => p.pid === first.pid ? { ...p, born: '2000-01-01T00:00:00Z' } : p)));
        await assert.rejects(sendConsoleStop(first.pid, identities.filter(p => p.pid !== ready.pid)));
        assert.equal((await fetch(`http://127.0.0.1:${ready.port}/`)).status, 200);
      }
      if (kind === 'PowerShell command') {
        const otherDir = path.join(dir, 'other');
        await (await import('node:fs/promises')).mkdir(otherDir);
        await copyFile(new URL('./fixtures/ctrl-service.mjs', import.meta.url), path.join(otherDir, 'ctrl-service.mjs'));
        const { project: other } = await call('save', { name: 'Independent fixture', type: 'command', command: 'node.exe ctrl-service.mjs', cwd: otherDir });
        await call('launch', { id: other.id });
        otherReady = JSON.parse(await waitForFile(path.join(otherDir, 'ctrl-ready.json')));
        // Re-open the same data directory while both services are still running.
        await panel.close(); panel = await createPanelServer(options);
        const restored = await call('projects');
        assert.equal(restored.statuses[project.id].state, 'running');
        assert.equal(restored.statuses[other.id].state, 'running');
        assert.equal(restored.launches[project.id].pid, first.pid);
      }
      await unlink(path.join(dir, 'ctrl-ready.json'));
      let restarted = await call('restart', { id: project.id });
      if (kind === 'CMD') {
        assert.match(restarted.confirmation.prompt, /Y\s*\/\s*N/i);
        assert.equal(receipts.length, 1, 'Restart must wait for the console answer.');
        restarted = await call('restart', { id: project.id, confirmationToken: restarted.confirmation.token, answer: true });
      }
      assert.equal(restarted.accepted, true);
      const next = JSON.parse(await waitForFile(path.join(dir, 'ctrl-ready.json')));
      assert.notEqual(next.pid, ready.pid);
      assert.equal(JSON.parse(await waitForFile(path.join(dir, 'ctrl-received.json'))).pid, ready.pid);
      await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/`, { signal: AbortSignal.timeout(1000) }));
      assert.equal((await fetch(`http://127.0.0.1:${next.port}/`)).status, 200);
      assert.equal((await call('projects')).statuses[project.id].canStop, true);
      await unlink(path.join(dir, 'ctrl-received.json'));
      let stopped = await call('stop', { id: project.id });
      if (kind === 'CMD') {
        assert.match(stopped.confirmation.prompt, /Y\s*\/\s*N/i);
        stopped = await call('stop', { id: project.id, confirmationToken: stopped.confirmation.token, answer: true });
      }
      assert.equal(stopped.stopped, true);
      assert.equal(JSON.parse(await waitForFile(path.join(dir, 'ctrl-received.json'))).pid, next.pid);
      assert.equal((await call('projects')).statuses[project.id].state, 'offline');
      await assert.rejects(fetch(`http://127.0.0.1:${next.port}/`, { signal: AbortSignal.timeout(1000) }));
      if (otherReady) assert.equal((await fetch(`http://127.0.0.1:${otherReady.port}/`)).status, 200);
    } finally {
      await panel.close();
      for (const receipt of receipts) {
        // PID plus creation time identifies only a fixture started by this test.
        const cleanup = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${receipt.pid}'; if ($p -and ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() -eq ([DateTimeOffset]::Parse(${quote(receipt.startedAt)})).ToUnixTimeMilliseconds()) { & taskkill.exe /PID ${receipt.pid} /T /F | Out-Null }`;
        await run(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
      }
    }
  });
}

test('CMD No is delivered to the real batch prompt, rejects changed targets, and cancels restart', native, async t => {
  const dir = await tempDir(t), receipts = [];
  await copyFile(new URL('./fixtures/ctrl-service.mjs', import.meta.url), path.join(dir, 'ctrl-service.mjs'));
  const file = path.join(dir, 'start.cmd');
  await writeFile(file, '@echo off\r\nnode.exe ctrl-service.mjs\r\necho continued>continued.txt\r\n');
  const panel = await createPanelServer({ dataDir: path.join(dir, 'panel'), port: 0, template: '',
    launch: async p => { const receipt = await launchProject(p, { windowStyle: 'Hidden' }); receipts.push(receipt); return receipt; } });
  const call = async (route, input) => {
    const response = await fetch(panel.info.url + 'api/' + route, { method: input ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-start-buttons-token': panel.info.token }, body: input ? JSON.stringify(input) : undefined });
    const data = await response.json(); assert.equal(response.status, 200, data.error); return data;
  };
  try {
    const { project } = await call('save', { name: 'CMD cancel fixture', type: 'file', path: file });
    await call('launch', { id: project.id });
    const ready = JSON.parse(await waitForFile(path.join(dir, 'ctrl-ready.json')));
    const observed = await call('projects');
    const owned = (await inspectProjectProcesses(project, { launches: observed.launches })).owned.map(p => ({ pid: p.pid, born: p.born }));
    const pending = await call('restart', { id: project.id });
    const rootPid = receipts[0].pid;
    const prompt = (await sendConsoleStop(rootPid, owned, { action: 'read' })).confirmation;
    assert.match(prompt.prompt, /Y\s*\/\s*N/i);
    await assert.rejects(sendConsoleStop(rootPid, owned, { action: 'answer', ...prompt, prompt: 'Changed question', answer: true }));
    await assert.rejects(sendConsoleStop(rootPid, owned.map(p => p.pid === rootPid ? { ...p, born: '2000-01-01T00:00:00Z' } : p), { action: 'answer', ...prompt, answer: true }));
    assert.equal((await sendConsoleStop(rootPid, owned, { action: 'read' })).confirmation.prompt, prompt.prompt);
    const cancelled = await call('restart', { id: project.id, confirmationToken: pending.confirmation.token, answer: false });
    assert.equal(cancelled.cancelled, true); assert.equal(receipts.length, 1);
    assert.match(await waitForFile(path.join(dir, 'continued.txt')), /continued/);
    assert.equal((await call('projects')).statuses[project.id].state, 'offline');
    await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    await panel.close();
    for (const receipt of receipts) {
      const cleanup = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${receipt.pid}'; if ($p -and ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() -eq ([DateTimeOffset]::Parse(${quote(receipt.startedAt)})).ToUnixTimeMilliseconds()) { & taskkill.exe /PID ${receipt.pid} /T /F | Out-Null }`;
      await run(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
    }
  }
});

test('an original stop command executes in the selected project directory and is verified before reporting exit', native, async t => {
  const dir = await tempDir(t);
  await copyFile(new URL('./fixtures/ctrl-service.mjs', import.meta.url), path.join(dir, 'ctrl-service.mjs'));
  let receipt;
  const panel = await createPanelServer({ dataDir: path.join(dir, 'panel'), port: 0, template: '',
    launch: async p => { receipt = await launchProject(p, { windowStyle: 'Hidden', keepOpen: true }); return receipt; } });
  const call = async (route, input) => {
    const response = await fetch(panel.info.url + 'api/' + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-start-buttons-token': panel.info.token }, body: JSON.stringify(input) });
    const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
  };
  try {
    const { project } = await call('save', { name: 'Original stop fixture', type: 'command', command: 'node.exe ctrl-service.mjs', cwd: dir });
    await call('launch', { id: project.id });
    const ready = JSON.parse(await waitForFile(path.join(dir, 'ctrl-ready.json')));
    const stopCommand = `if ((Get-Location).Path -ne ${quote(dir)}) { throw 'Wrong directory' }; Invoke-WebRequest -Uri 'http://127.0.0.1:${ready.port}/stop-fixture' | Out-Null`;
    await call('save', { ...project, stopCommand });
    assert.equal((await call('stop', { id: project.id })).stopped, true);
    assert.equal(JSON.parse(await waitForFile(path.join(dir, 'ctrl-received.json'))).signal, 'stop-command');
    await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    await panel.close();
    if (receipt) {
      const cleanup = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${receipt.pid}'; if ($p -and ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() -eq ([DateTimeOffset]::Parse(${quote(receipt.startedAt)})).ToUnixTimeMilliseconds()) { & taskkill.exe /PID ${receipt.pid} /T /F | Out-Null }`;
      await run(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
    }
  }
});
