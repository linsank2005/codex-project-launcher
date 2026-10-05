import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { discoverXhsCheck, checkXhsRuntime } from '../src/xhs-status.mjs';
import { checkProjectStatuses, launchKey } from '../src/status.mjs';
import { tempDir } from './helpers.mjs';

const refused = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
const launcherContract = 'export function launcherFingerprint(directory, dataDir) { return createHash("sha256").update(`${path.resolve(directory)}\\n${path.resolve(dataDir)}`).digest("hex").slice(0, 32); }\nconst lockFile = "launcher.lock";\nconst app = "xhs-cover-simulator";\nfor (let candidate = 3001; candidate <= 3010; candidate++) {}\n';
async function fixture(t) {
  const root = await tempDir(t);
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'data'));
  const project = { id: 'xhs', type: 'file', name: 'Any display name', path: path.join(root, 'start-windows.cmd') };
  await writeFile(project.path, '@echo off\r\npushd "%~dp0"\r\nnode scripts\\launch.mjs\r\npopd\r\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'xiaohongshu-cover-simulator', scripts: { launch: 'node scripts/launch.mjs' } }));
  await writeFile(path.join(root, 'scripts', 'launch.mjs'), launcherContract);
  const profile = await discoverXhsCheck(project, {});
  assert.ok(profile);
  return { root, project, profile };
}
const options = { request: refused, startupProcesses: async () => [], portOwners: async () => [] };
const nodeOwner = { pid: 42, name: 'node.exe', command: 'node scripts\\launch.mjs', born: '2026-10-01T01:00:00Z' };

test('XHS never started, stopped with an idle console, and stale launch receipts show not running', async t => {
  const { project } = await fixture(t);
  const off = (await checkProjectStatuses([project], options)).xhs;
  assert.equal(off.state, 'offline');
  assert.equal(off.label, '未运行');
  assert.equal(off.method, 'launcher');
  assert.equal(off.canLaunch, true);
  const at = '2026-10-01T01:00:00Z';
  const stopped = (await checkProjectStatuses([project], { ...options,
    startupProcesses: async () => [{ pid: 10, name: 'cmd.exe', command: `cmd /k "${project.path}"`, born: at }],
    launches: { xhs: { accepted: true, entryKey: launchKey(project), pid: 10, startedAt: at, at, settled: true } },
  })).xhs;
  assert.equal(stopped.state, 'offline');
  assert.equal(stopped.canLaunch, true);
});

test('XHS finds the actual dynamic port, verifies workspace identity and can see a service without its original console', async t => {
  const { project, profile } = await fixture(t);
  const urls = [];
  const status = (await checkProjectStatuses([project], { ...options, request: async (url, init) => {
    urls.push(url);
    assert.equal(init.redirect, 'manual');
    if (new URL(url).port === '3008') return Response.json({ app: 'xhs-cover-simulator', workspace: profile.workspace });
    return refused();
  } })).xhs;
  assert.equal(status.state, 'running');
  assert.equal(status.canLaunch, false);
  assert.match(status.detail, /3008\/api\/health/);
  assert.equal(urls.length, 10);
});

test('another XHS workspace or another app on a candidate port is not this project and leaves fallback ports usable', async t => {
  const { project, profile } = await fixture(t);
  const status = (await checkProjectStatuses([project], { ...options, portOwners: async () => [{ port: 3001, pid: 90, address: '127.0.0.1' }], request: async url => {
    if (new URL(url).port === '3001') return Response.json({ app: 'xhs-cover-simulator', workspace: 'another-workspace' });
    if (new URL(url).port === '3002') return Response.json({ app: 'another-app', workspace: profile.workspace });
    return refused();
  } })).xhs;
  assert.equal(status.state, 'offline');
  assert.equal(status.canLaunch, true);
  const full = (await checkProjectStatuses([project], { ...options, request: async () => Response.json({ app: 'another-app' }) })).xhs;
  assert.equal(full.state, 'offline');
  assert.equal(full.canLaunch, false);
  assert.match(full.launchBlockReason, /3001–3010/);
});

test('a live launcher preparing a build remains starting beyond the short handoff, while ready health takes precedence', async t => {
  const { project, profile } = await fixture(t);
  await writeFile(profile.lockFile, JSON.stringify({ pid: 42, port: null, workspace: profile.workspace }));
  const status = (await checkProjectStatuses([project], { ...options, startupProcesses: async () => [nodeOwner] })).xhs;
  assert.equal(status.state, 'unknown');
  assert.equal(status.label, '启动中');
  assert.equal(status.canLaunch, false);
  const ready = await checkXhsRuntime(profile, { records: [nodeOwner], request: async url => new URL(url).port === '3009'
    ? Response.json({ app: 'xhs-cover-simulator', workspace: profile.workspace }) : refused() });
  assert.equal(ready.state, 'running');
});

test('a stale XHS lock and a recycled PID cannot keep a stopped project running or starting', async t => {
  const { project, profile } = await fixture(t);
  await writeFile(profile.lockFile, JSON.stringify({ pid: 42, port: 3001, workspace: profile.workspace }));
  assert.equal((await checkProjectStatuses([project], options)).xhs.state, 'offline');
  const recycled = await checkProjectStatuses([project], { ...options, startupProcesses: async () => [{ ...nodeOwner, born: '2099-01-01T00:00:00Z' }] });
  assert.equal(recycled.xhs.state, 'offline');
  assert.equal(recycled.xhs.canLaunch, true);
  const unready = (await checkProjectStatuses([project], { ...options, startupProcesses: async () => [nodeOwner] })).xhs;
  assert.equal(unready.state, 'running');
  assert.match(unready.label, /未就绪/);
});

test('XHS read errors, malformed lock, incomplete HTTP checks and restricted process probes preserve uncertainty', async t => {
  const { project, profile } = await fixture(t);
  await writeFile(profile.lockFile, 'not JSON');
  const bad = (await checkProjectStatuses([project], options)).xhs;
  assert.equal(bad.label, '状态文件异常');
  assert.equal(bad.canLaunch, false);
  const cleanProfile = { ...profile, lockFile: path.join(profile.root, 'absent.lock') };
  const slow = await checkXhsRuntime(cleanProfile, { request: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  assert.equal(slow.state, 'unknown');
  assert.equal(slow.label, '检查超时');
  assert.equal(slow.blocked, true);
  const invalid = await checkXhsRuntime(cleanProfile, { request: async () => new Response('<html>other service or broken response</html>') });
  assert.equal(invalid.state, 'unknown');
  const restricted = await checkXhsRuntime(cleanProfile, { request: refused, recordError: 'access denied' });
  assert.equal(restricted.state, 'unknown');
  assert.equal(restricted.blocked, true);
  const noPorts = await checkXhsRuntime(cleanProfile, { request: refused, portError: 'access denied' });
  assert.equal(noPorts.state, 'unknown');
});

test('auto checks require the original XHS entry contract, respect explicit addresses and resolve custom data directories', async t => {
  const { root, project, profile } = await fixture(t);
  const custom = await discoverXhsCheck(project, { SIMULATOR_DATA_DIR: 'custom-data' });
  assert.equal(custom.lockFile, path.join(root, 'custom-data', 'launcher.lock'));
  assert.notEqual(custom.workspace, profile.workspace);
  assert.equal(await discoverXhsCheck({ ...project, healthUrl: 'http://127.0.0.1:4000/' }), null);
  await writeFile(path.join(root, 'scripts', 'launch.mjs'), launcherContract.replace('sha256', 'md5'));
  assert.equal(await discoverXhsCheck(project, {}), null, 'A changed identity contract must not result in false offline checks.');
  await writeFile(path.join(root, 'scripts', 'launch.mjs'), 'console.log("another launcher")');
  assert.equal(await discoverXhsCheck(project, {}), null);
  const other = (await checkProjectStatuses([project], options)).xhs;
  assert.equal(other.state, 'unknown', 'Unknown scripts must not be changed into a false stopped label.');
});
