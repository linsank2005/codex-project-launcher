import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensurePanel } from '../src/runtime.mjs';
import { tempDir } from './helpers.mjs';

test('new plugin refuses to reuse an old panel daemon without stopping it', async t => {
  const dataDir = await tempDir(t), token = 'a'.repeat(64);
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-start-buttons-token'], token);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: 'start-buttons', version: '0.1.0', dataDir }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await writeFile(path.join(dataDir, 'runtime.json'), JSON.stringify({ port: server.address().port, token, pid: process.pid, version: '0.1.1' }));
  await assert.rejects(ensurePanel(dataDir), /旧版本.*安装插件/);
  assert.equal(server.listening, true);
});
