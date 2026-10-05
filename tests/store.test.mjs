import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { tempDir } from './helpers.mjs';

test('persist and edit an existing Unicode entry without changing its startup file', async t => {
  const dir = await tempDir(t), file = path.join(dir, '启动 & 原有.ps1');
  await writeFile(file, 'original');
  const store = new ProjectStore(dir);
  const p = await store.save({ name: '我的项目', icon: '🧮', path: `"${file}"`, cwd: dir });
  assert.equal(p.path, file);
  await store.save({ ...p, name: '已改名' });
  assert.equal((await new ProjectStore(dir).list()).length, 1);
  assert.equal((await store.get(p.id)).name, '已改名');
  await store.remove(p.id);
  assert.deepEqual(await store.list(), []);
  assert.equal(await (await import('node:fs/promises')).readFile(file, 'utf8'), 'original');
});
test('serialize concurrent saves without dropping shortcuts', async t => {
  const dir = await tempDir(t), store = new ProjectStore(dir);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.save({ name: `项目${i}`, type: 'command', command: 'Write-Output "hello"', cwd: dir })));
  assert.equal((await store.list()).length, 12);
});
test('reject invalid launch configuration before persisting', async t => {
  const dir = await tempDir(t), store = new ProjectStore(dir);
  await assert.rejects(store.save({ name: 'missing', path: path.join(dir, 'missing.ps1') }), /不存在/);
  await assert.rejects(store.save({ name: 'relative', path: 'start.ps1' }), /完整路径/);
  await assert.rejects(store.save({ name: 'command', type: 'command', command: 'npm start' }), /项目目录/);
  await assert.rejects(store.save({ name: 'bad', type: 'command', command: 'npm start', cwd: dir, id: '../escape' }), /ID/);
  assert.deepEqual(await store.list(), []);
});
test('preserve a corrupt config rather than resetting it', async t => {
  const dir = await tempDir(t), store = new ProjectStore(dir);
  await writeFile(store.file, '{broken');
  await assert.rejects(store.save({ name: 'new', type: 'command', command: 'npm start', cwd: dir }), /损坏/);
  assert.equal(await (await import('node:fs/promises')).readFile(store.file, 'utf8'), '{broken');
});
test('revalidate entry files when launching, including deleted entries', async t => {
  const dir = await tempDir(t), store = new ProjectStore(dir), file = path.join(dir, 'start.cmd');
  await writeFile(file, '@echo off');
  const p = await store.save({ name: 'entry', path: file });
  await (await import('node:fs/promises')).unlink(file);
  await assert.rejects(store.get(p.id), /不存在/);
});
test('persist local runtime checks and retain them when an older client edits another field', async t => {
  const dir = await tempDir(t), store = new ProjectStore(dir);
  const p = await store.save({ name: 'web', type: 'command', command: 'original', cwd: dir, healthUrl: 'http://localhost:3000' });
  assert.equal(p.healthUrl, 'http://localhost:3000/');
  const { healthUrl, ...olderInput } = p;
  await store.save({ ...olderInput, icon: '🤖' });
  assert.equal((await store.get(p.id)).healthUrl, healthUrl);
  for (const bad of ['https://localhost/', 'http://example.com/', 'http://127.0.0.2/', 'http://user:password@localhost/', 'http://localhost/#fragment']) {
    await assert.rejects(store.save({ ...p, healthUrl: bad }), /本机 http/);
  }
  assert.equal((await store.get(p.id)).icon, '🤖');
});

test('persist the original stop command, retain it on unrelated edits, and allow explicitly clearing it', async t => {
  const dir = await tempDir(t), store = new ProjectStore(dir);
  const p = await store.save({ name: 'service', type: 'command', command: 'npm start', cwd: dir, stopCommand: 'npm run stop' });
  const { stopCommand, ...olderInput } = p;
  await store.save({ ...olderInput, name: 'renamed' });
  assert.equal((await new ProjectStore(dir).get(p.id)).stopCommand, stopCommand);
  await store.save({ ...olderInput, stopCommand: '' });
  assert.equal((await store.get(p.id)).stopCommand, '');
});
