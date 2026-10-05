import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { checkProjectStatuses, statusFromStartupProcesses, launchKey } from '../src/status.mjs';
import { tempDir } from './helpers.mjs';
import { resolvePowerShell } from '../src/powershell.mjs';

async function service(t, handler = (req, res) => res.end('ok')) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}/health`, close };
}
test('each project has independent live status and stopping one leaves the other running', async t => {
  const first = await service(t), second = await service(t);
  const projects = [{ id: 'a', type: 'file', path: path.resolve('first/start.ps1'), healthUrl: first.url }, { id: 'b', type: 'file', path: path.resolve('second/start.ps1'), healthUrl: second.url }];
  const records = projects.flatMap((p, i) => [{ pid: i * 10 + 1, name: 'pwsh.exe', command: `pwsh.exe -File "${p.path}"`, born: '2026-10-03T01:00:00Z' }, { pid: i * 10 + 2, parent: i * 10 + 1, name: 'node.exe', born: '2026-10-03T01:00:01Z' }]);
  const options = { startupProcesses: async () => records, portOwners: async () => projects.map((p, i) => ({ port: Number(new URL(p.healthUrl).port), address: '127.0.0.1', pid: i * 10 + 2 })) };
  let statuses = await checkProjectStatuses(projects, options);
  assert.equal(statuses.a.state, 'running');
  assert.equal(statuses.b.state, 'running');
  await first.close();
  records.splice(0, 2);
  statuses = await checkProjectStatuses(projects, { ...options, portOwners: async () => [{ port: Number(new URL(second.url).port), address: '127.0.0.1', pid: 12 }] });
  assert.equal(statuses.a.state, 'offline');
  assert.equal(statuses.b.state, 'running');
});
test('unknown script status and invalid local address are never reported as running', async () => {
  let requests = 0;
  const statuses = await checkProjectStatuses([{ id: 'script', type: 'command' }, { id: 'external', healthUrl: 'http://example.com/' }], {
    request: async () => { requests++; throw new Error('Must not request external URL.'); },
  });
  assert.equal(statuses.script.state, 'unknown');
  assert.equal(statuses.external.state, 'unknown');
  assert.equal(requests, 0);
});
test('a hanging service times out as unconfirmed instead of claiming that its process stopped', async t => {
  const hanging = await service(t, () => {});
  const statuses = await checkProjectStatuses([{ id: 'slow', healthUrl: hanging.url }], { timeoutMs: 100 });
  assert.equal(statuses.slow.state, 'unknown');
  assert.equal(statuses.slow.label, '检查超时');
});
test('unverified HTTP errors and redirects do not claim this project is running or stopped and never follow redirects', async t => {
  let redirectedRequests = 0;
  const target = await service(t, (req, res) => { redirectedRequests++; res.end('ok'); });
  const redirect = await service(t, (req, res) => { res.writeHead(302, { Location: target.url }); res.end(); });
  const failure = await service(t, (req, res) => { res.writeHead(503); res.end('not ready'); });
  const statuses = await checkProjectStatuses([{ id: 'redirect', healthUrl: redirect.url }, { id: 'error', healthUrl: failure.url }]);
  assert.equal(statuses.redirect.state, 'unknown');
  assert.equal(statuses.error.state, 'unknown');
  assert.equal(statuses.redirect.canLaunch, false);
  assert.equal(statuses.error.canLaunch, false);
  assert.equal(redirectedRequests, 0);
});

test('HTTP 200 from a different listener is not proof that the saved script is running', async () => {
  const project = { id: 'wrong', type: 'file', path: path.resolve('wrong/start.ps1'), healthUrl: 'http://127.0.0.1:3000/' };
  const options = { request: async () => new Response('ok'), startupProcesses: async () => [], portOwners: async () => [{ port: 3000, pid: 90, address: '127.0.0.1' }] };
  const status = (await checkProjectStatuses([project], options)).wrong;
  assert.equal(status.state, 'unknown');
  assert.equal(status.canLaunch, false);
  const root = { pid: 1, name: 'pwsh.exe', command: `pwsh.exe -File "${project.path}"`, born: '2026-10-03T01:00:00Z' };
  const app = { pid: 2, parent: 1, name: 'node.exe', born: '2026-10-03T01:00:01Z' };
  const stillWrong = (await checkProjectStatuses([project], { ...options, startupProcesses: async () => [root, app] })).wrong;
  assert.equal(stillWrong.state, 'unknown', 'Even another business child is not ownership of the responding port.');
});

test('a non-HTTP listening process and an unavailable probe never turn into a false running label', async () => {
  const project = { id: 'busy', type: 'command', healthUrl: 'http://127.0.0.1:3000/' };
  const status = (await checkProjectStatuses([project], { request: async () => { throw new Error('not HTTP'); }, portOwners: async () => [{ port: 3000, pid: 90, address: '0.0.0.0' }] })).busy;
  assert.equal(status.state, 'offline');
  assert.equal(status.canLaunch, false);
  const unavailable = (await checkProjectStatuses([project], { request: async () => new Response('ok'), portOwners: async () => { throw new Error('access denied'); } })).busy;
  assert.equal(unavailable.state, 'unknown');
  assert.equal(unavailable.canLaunch, false);
});

test('verified listener that is not ready still blocks duplicates until its process exits', async () => {
  const project = { id: 'own', type: 'file', path: path.resolve('app.exe'), healthUrl: 'http://127.0.0.1:3000/' };
  const options = { request: async () => new Response('starting', { status: 503 }), startupProcesses: async () => [{ pid: 20, name: 'app.exe', exe: project.path }], portOwners: async () => [{ port: 3000, pid: 20, address: '0.0.0.0' }] };
  const status = (await checkProjectStatuses([project], options)).own;
  assert.equal(status.state, 'running');
  assert.match(status.label, /未就绪/);
  assert.equal(status.canLaunch, false);
  const notReady = (await checkProjectStatuses([project], { ...options, request: async () => { throw new Error('refused'); }, portOwners: async () => [] })).own;
  assert.equal(notReady.state, 'running');
  assert.equal(notReady.canLaunch, false);
});

test('launch records correlate commands and aliases by birth time while ignoring recycled PIDs and changed entries', async () => {
  const project = { id: 'command', type: 'command', command: 'original', cwd: path.resolve('project') };
  const born = '2026-10-03T01:00:00.123Z';
  const root = { pid: 20, name: 'pwsh.exe', born }, app = { pid: 21, parent: 20, name: 'node.exe', born: '2026-10-03T01:00:01Z' };
  const launches = { otherAlias: { pid: 20, startedAt: born, accepted: true, entryKey: launchKey(project), at: born } };
  const options = { launches, startupProcesses: async () => [root, app] };
  assert.equal((await checkProjectStatuses([project], options)).command.state, 'running');
  assert.equal((await checkProjectStatuses([project], { ...options, startupProcesses: async () => [{ ...root, born: '2026-10-03T02:00:00Z' }, app] })).command.state, 'unknown');
  assert.equal((await checkProjectStatuses([{ ...project, command: 'changed' }], options)).command.state, 'unknown');
});

test('a recent handoff blocks a second launch during startup without reporting an idle terminal as running', async () => {
  const project = { id: 'wait', type: 'command', command: 'original' }, at = new Date().toISOString();
  const launch = { pid: 20, startedAt: at, accepted: true, entryKey: launchKey(project), at };
  const status = (await checkProjectStatuses([project], { launches: { wait: launch }, startupProcesses: async () => [{ pid: 20, born: at, name: 'pwsh.exe' }] })).wait;
  assert.equal(status.state, 'unknown');
  assert.equal(status.label, '启动中');
  assert.equal(status.canLaunch, false);
  const exited = (await checkProjectStatuses([project], { launches: { wait: launch }, startupProcesses: async () => [] })).wait;
  assert.equal(exited.canLaunch, true);
  const idleAfterStop = (await checkProjectStatuses([project], { launches: { wait: { ...launch, settled: true } }, startupProcesses: async () => [{ pid: 20, born: at, name: 'pwsh.exe' }] })).wait;
  assert.equal(idleAfterStop.state, 'offline');
  assert.equal(idleAfterStop.canLaunch, true, 'A service already observed running must not re-enter the startup hold after stopping.');
});

test('different IPv4 and IPv6 owners cannot make localhost or a specific IPv4 response appear owned', async () => {
  const project = { id: 'v4', type: 'file', path: path.resolve('own.exe'), healthUrl: 'http://127.0.0.1:3000/' };
  const options = { request: async () => new Response('ok'), startupProcesses: async () => [{ pid: 1, exe: project.path, name: 'own.exe' }], portOwners: async () => [{ pid: 1, port: 3000, address: '::' }, { pid: 2, port: 3000, address: '127.0.0.1' }] };
  assert.equal((await checkProjectStatuses([project], options)).v4.state, 'unknown');
  assert.equal((await checkProjectStatuses([{ ...project, healthUrl: 'http://localhost:3000/' }], options)).v4.state, 'unknown');
  assert.equal((await checkProjectStatuses([{ ...project, healthUrl: 'http://[::1]:3000/' }], options)).v4.state, 'running');
});
test('EXE detection matches the absolute path instead of a shared filename and preserves unknown probe failures', async () => {
  const a = path.resolve('first/start.exe'), b = path.resolve('second/start.exe');
  const projects = [{ id: 'a', type: 'file', path: a }, { id: 'b', type: 'file', path: b }];
  const statuses = await checkProjectStatuses(projects, { executablePaths: async () => new Set([a.toLowerCase()]) });
  assert.equal(statuses.a.state, 'running');
  assert.equal(statuses.b.state, 'offline');
  const failed = await checkProjectStatuses(projects, { executablePaths: async () => { throw new Error('unavailable'); } });
  assert.equal(failed.a.state, 'unknown');
});
test('script status follows its original startup chain but an idle terminal is not a running project', () => {
  const script = path.resolve('项目/start.ps1');
  const project = { type: 'file', path: script };
  const root = { pid: 10, parent: 1, name: 'pwsh.exe', command: `pwsh.exe -NoExit -File "${script}"`, born: '2026-10-02T01:00:00Z' };
  const shell = { pid: 11, parent: 10, name: 'cmd.exe', born: '2026-10-02T01:00:01Z' };
  const app = { pid: 12, parent: 11, name: 'python.exe', born: '2026-10-02T01:00:02Z' };
  assert.equal(statusFromStartupProcesses(project, [root, shell, app]).state, 'running');
  assert.equal(statusFromStartupProcesses(project, [root, shell]).state, 'unknown');
  assert.equal(statusFromStartupProcesses(project, [root, { ...app, parent: 10, born: '2026-10-01T00:00:00Z' }]).state, 'unknown');
  assert.equal(statusFromStartupProcesses(project, [{ ...root, command: `pwsh.exe -File "${script}.other"` }, shell, app]).state, 'unknown');
});
test('CMD invocation matches the saved file including forward slashes and preserves a separate project', () => {
  const script = path.resolve('中文 & 项目/start.cmd');
  const root = { pid: 10, name: 'cmd.exe', command: `cmd.exe /c ""${script.replace(/\\/g, '/')}""`, born: '2026-10-02T01:00:00Z' };
  const app = { pid: 11, parent: 10, name: 'python.exe', born: '2026-10-02T01:00:01Z' };
  assert.equal(statusFromStartupProcesses({ path: script }, [root, app]).state, 'running');
  assert.equal(statusFromStartupProcesses({ path: path.resolve('other/start.cmd') }, [root, app]).state, 'unknown');
});
test('Windows detects a real EXE starting and stopping by its unique executable path', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t), exe = path.join(dir, '状态检查.exe');
  await copyFile(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), exe);
  const child = spawn(exe, ['/d', '/c', 'ping -n 40 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  const stop = async () => {
    if (child.exitCode !== null) return;
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await exited;
  };
  try {
    const project = { id: 'native', type: 'file', path: exe };
    assert.equal((await checkProjectStatuses([project])).native.state, 'running');
    await stop();
    assert.equal((await checkProjectStatuses([project])).native.state, 'offline');
  } finally { await stop(); }
});

test('Windows identifies a real original PowerShell entry with a business child process', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t), entry = path.join(dir, 'status-demo.ps1');
  await copyFile(new URL('./fixtures/status-demo.ps1', import.meta.url), entry);
  await copyFile(new URL('./fixtures/status-demo.mjs', import.meta.url), path.join(dir, 'status-demo.mjs'));
  const powershell = await resolvePowerShell();
  const child = spawn(powershell.path, ['-NoLogo', '-NoProfile', '-NoExit', '-File', entry], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The independent script service did not become ready.')), 8000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', data => { if (/http:\/\/127\.0\.0\.1:\d+/.test(data.toString())) { clearTimeout(timer); resolve(); } });
    });
    const statuses = await checkProjectStatuses([{ id: 'script', type: 'file', path: entry }]);
    assert.equal(statuses.script.state, 'running');
    assert.equal(statuses.script.method, 'process');
  } finally {
    if (child.exitCode === null) await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await exited;
  }
  assert.equal((await checkProjectStatuses([{ id: 'script', type: 'file', path: entry }])).script.state, 'unknown');
});
