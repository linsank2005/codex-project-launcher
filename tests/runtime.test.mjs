import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentPanel } from '../src/panel.mjs';
import { compareVersions } from '../src/versions.mjs';
import { VERSION } from '../src/version.mjs';
import { tempDir, waitForFile } from './helpers.mjs';

const run = promisify(execFile);
const native = { skip: process.platform !== 'win32', timeout: 45000 };
const nextVersion = `${VERSION.split('.').slice(0, 2).join('.')}.${Number(VERSION.split('.')[2]) + 1}`;
async function setup(t) {
  let dataDir;
  t.after(async () => {
    const info = await currentPanel(dataDir);
    if (info?.version === VERSION) {
      await fetch(`${info.url}api/shutdown`, { method: 'POST', headers: { 'x-start-buttons-token': info.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ targetVersion: nextVersion }) }).catch(() => {});
      for (let i = 0; i < 50 && await currentPanel(dataDir); i++) await new Promise(resolve => setTimeout(resolve, 100));
    }
  });
  const dir = await tempDir(t), plugin = path.join(dir, 'installed plugin'); dataDir = path.join(dir, 'data');
  await cp('plugins/start-buttons', plugin, { recursive: true }); await mkdir(dataDir);
  const projects = JSON.stringify({ version: 1, projects: [{ id: 'saved', name: '保留入口', icon: '🚀', type: 'command', command: 'original', cwd: dir }] });
  await writeFile(path.join(dataDir, 'projects.json'), projects);
  const env = { ...process.env, START_BUTTONS_DATA_DIR: dataDir, START_BUTTONS_PORT: '0' };
  const open = () => run(process.execPath, [path.join(plugin, 'dist/panel.mjs')], { env, windowsHide: true, timeout: 35000 });
  return { dir, plugin, dataDir, env, projects, open };
}
async function legacy(t, fixture, recognized = true, version = '0.2.3') {
  const file = path.join(fixture.dir, recognized ? 'legacy/plugins/start-buttons/dist/panel.mjs' : 'unrelated.mjs');
  await mkdir(path.dirname(file), { recursive: true }); await cp('tests/fixtures/legacy-panel.mjs', file);
  const child = spawn(process.execPath, [file, '--daemon'], { env: { ...fixture.env, FIXTURE_VERSION: version }, windowsHide: true, stdio: 'ignore' });
  t.after(() => child.kill());
  return JSON.parse(await waitForFile(path.join(fixture.dataDir, 'runtime.json')));
}

test('version ordering compares numeric components and rejects unknown version formats', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions(VERSION, VERSION), 0);
  for (const value of [undefined, 'invalid', '0.2.4-beta', '0.2', '-1.0.0']) assert.throws(() => compareVersions(value, VERSION));
});

test('two independent clients start one relocated daemon and preserve existing configuration', native, async t => {
  const fixture = await setup(t);
  const [first, second] = await Promise.all([fixture.open(), fixture.open()]);
  assert.equal(first.stdout.trim(), second.stdout.trim());
  const info = await currentPanel(fixture.dataDir);
  assert.equal(info.version, VERSION);
  assert.equal(await readFile(path.join(fixture.dataDir, 'projects.json'), 'utf8'), fixture.projects);
});

test('a verified pre-shutdown-API daemon upgrades automatically while an independent service stays alive', native, async t => {
  const fixture = await setup(t), before = await legacy(t, fixture);
  const service = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => service.kill());
  const { stdout } = await fixture.open();
  const after = await currentPanel(fixture.dataDir);
  assert.equal(after.version, VERSION); assert.notEqual(after.pid, before.pid); assert.equal(stdout.trim(), after.url);
  assert.equal(service.exitCode, null); assert.doesNotThrow(() => process.kill(service.pid, 0));
  assert.equal(await readFile(path.join(fixture.dataDir, 'projects.json'), 'utf8'), fixture.projects);
});

test('an unrecognized listener process is preserved instead of being killed during upgrade', native, async t => {
  const fixture = await setup(t), before = await legacy(t, fixture, false);
  await assert.rejects(fixture.open(), /无法核验旧面板进程/);
  assert.equal((await currentPanel(fixture.dataDir)).pid, before.pid);
  assert.doesNotThrow(() => process.kill(before.pid, 0));
});

test('a panel with the shutdown API upgrades gracefully and keeps its launch journal', native, async t => {
  const fixture = await setup(t), oldPlugin = path.join(fixture.dir, 'old cache');
  await cp(fixture.plugin, oldPlugin, { recursive: true });
  const file = path.join(oldPlugin, 'dist/panel.mjs');
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll(VERSION, '0.2.3'));
  const journal = JSON.stringify({ version: 1, records: { saved: { entryKey: 'a'.repeat(64), at: new Date().toISOString(), accepted: true, settled: true, processes: [] } } });
  await writeFile(path.join(fixture.dataDir, 'launches.json'), journal);
  const child = spawn(process.execPath, [file, '--daemon'], { env: fixture.env, windowsHide: true, stdio: 'ignore' });
  t.after(() => child.kill());
  const before = JSON.parse(await waitForFile(path.join(fixture.dataDir, 'runtime.json')));
  await fixture.open();
  const after = await currentPanel(fixture.dataDir);
  assert.notEqual(after.pid, before.pid); assert.equal(after.version, VERSION);
  assert.equal(await readFile(path.join(fixture.dataDir, 'launches.json'), 'utf8'), journal);
});

test('older clients cannot downgrade a newer running panel', native, async t => {
  const fixture = await setup(t), before = await legacy(t, fixture, true, '99.0.0');
  await assert.rejects(fixture.open(), /旧聊天不会降级面板/);
  assert.equal((await currentPanel(fixture.dataDir)).pid, before.pid);
});

test('a stale start lock left by an exited client is recovered automatically', native, async t => {
  const fixture = await setup(t);
  await writeFile(path.join(fixture.dataDir, 'panel-start.lock'), JSON.stringify({ pid: 2147483647, nonce: 'abandoned' }));
  await fixture.open(); assert.equal((await currentPanel(fixture.dataDir)).version, VERSION);
  await assert.rejects(readFile(path.join(fixture.dataDir, 'panel-start.lock')), { code: 'ENOENT' });
});
