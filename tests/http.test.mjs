import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPanelServer, currentPanel } from '../src/panel.mjs';
import { tempDir } from './helpers.mjs';
import { VERSION } from '../src/version.mjs';

const template = '<script>window.START_BUTTONS_CONFIG = /*START_BUTTONS_CONFIG*/;</script>';
test('panel upgrades require authentication, a newer version and no unfinished project operation', async t => {
  let finish;
  const panel = await setup(t, () => new Promise(resolve => { finish = resolve; }), async projects =>
    Object.fromEntries(projects.map(p => [p.id, { state: 'offline', canLaunch: true }])));
  const newer = `${VERSION.split('.').slice(0, 2).join('.')}.${Number(VERSION.split('.')[2]) + 1}`;
  assert.equal((await panel.call('shutdown', { targetVersion: newer }, { 'x-start-buttons-token': 'wrong' })).status, 403);
  assert.equal((await panel.call('shutdown', { targetVersion: VERSION })).status, 409);
  assert.equal((await panel.call('shutdown', { targetVersion: 'invalid' })).status, 400);
  const { project } = await (await panel.call('save', { name: 'busy', type: 'command', command: 'original', cwd: panel.dataDir })).json();
  const launching = panel.call('launch', { id: project.id });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await panel.call('shutdown', { targetVersion: newer })).status, 409);
  finish({ accepted: true }); await launching;
  assert.equal((await panel.call('shutdown', { targetVersion: newer })).status, 200);
  await panel.close();
  assert.equal(await currentPanel(panel.dataDir), null);
});
async function setup(t, launch, checkStatuses) {
  const dataDir = await tempDir(t);
  const panel = await createPanelServer({ dataDir, port: 0, template, launch, checkStatuses });
  t.after(() => panel.close());
  const call = (endpoint, input, extra = {}) => fetch(panel.info.url + 'api/' + endpoint, {
    method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-start-buttons-token': panel.info.token, ...extra },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { ...panel, call, dataDir };
}
test('panel persists add/edit/remove and only launches the saved entry selected by ID', async t => {
  const launched = [], panel = await setup(t, async p => { launched.push(p); return { accepted: true }; });
  const saved = await (await panel.call('save', { name: '测试', type: 'command', command: 'original', cwd: panel.dataDir })).json();
  assert.equal(saved.projects.length, 1);
  assert.equal((await panel.call('launch', { id: saved.project.id })).status, 200);
  assert.equal(launched[0].command, 'original');
  assert.equal((await panel.call('launch', { id: 'missing', command: 'arbitrary' })).status, 400);
  assert.equal(launched.length, 1);
  await panel.call('remove', { id: saved.project.id });
  assert.deepEqual((await (await panel.call('projects')).json()).projects, []);
  assert.equal((await currentPanel(panel.dataDir)).port, panel.info.port);
});

test('launch rechecks live status, blocks a running project and allows a restart after it stops', async t => {
  let running = false, calls = 0;
  const panel = await setup(t, async () => { calls++; running = true; return { accepted: true }; }, async projects =>
    Object.fromEntries(projects.map(p => [p.id, { state: running ? 'running' : 'offline', canLaunch: !running, launchBlockReason: 'already running' }])));
  const { project } = await (await panel.call('save', { name: 'service', type: 'command', command: 'original', cwd: panel.dataDir })).json();
  assert.equal((await panel.call('launch', { id: project.id })).status, 200);
  const duplicate = await panel.call('launch', { id: project.id });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).status.state, 'running');
  assert.equal(calls, 1);
  running = false;
  assert.equal((await panel.call('launch', { id: project.id })).status, 200);
  assert.equal(calls, 2);
});

test('unrelated service occupying the configured address is not reported as this project and blocks its launch', async t => {
  const service = http.createServer((req, res) => res.end('another project'));
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => { service.closeAllConnections(); return new Promise(resolve => service.close(resolve)); });
  let calls = 0;
  const panel = await setup(t, async () => { calls++; return { accepted: true }; });
  const { project, statuses } = await (await panel.call('save', { name: 'not started', type: 'command', command: 'original', cwd: panel.dataDir, healthUrl: `http://127.0.0.1:${service.address().port}/` })).json();
  assert.equal(statuses[project.id].state, 'unknown');
  assert.equal(statuses[project.id].canLaunch, false);
  assert.equal((await panel.call('launch', { id: project.id })).status, 409);
  assert.equal(calls, 0);
});

test('two saved aliases of the same entry cannot launch concurrently', async t => {
  let release, calls = 0;
  const panel = await setup(t, () => { calls++; return new Promise(resolve => { release = () => resolve({ accepted: true }); }); });
  const save = async name => (await (await panel.call('save', { name, type: 'command', command: 'same entry', cwd: panel.dataDir })).json()).project;
  const first = await save('first'), alias = await save('alias');
  const pending = panel.call('launch', { id: first.id });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await panel.call('launch', { id: alias.id })).status, 409);
  release(); assert.equal((await pending).status, 200);
  assert.equal(calls, 1);
});
test('local APIs reject missing token, hostile Origin and Host', async t => {
  const panel = await setup(t);
  assert.equal((await fetch(panel.info.url + 'api/projects')).status, 403);
  assert.equal((await panel.call('projects', undefined, { Origin: 'https://outside.example' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(panel.info.url + 'api/projects', { headers: { Host: 'outside.example', 'x-start-buttons-token': panel.info.token } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  const page = await fetch(panel.info.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('overlapping launch requests are rejected until the first handoff completes', async t => {
  let release;
  const panel = await setup(t, () => new Promise(resolve => { release = () => resolve({ accepted: true }); }));
  const p = (await (await panel.call('save', { name: 'one', type: 'command', command: 'original', cwd: panel.dataDir })).json()).project;
  const first = panel.call('launch', { id: p.id });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await panel.call('launch', { id: p.id })).status, 409);
  release(); assert.equal((await first).status, 200);
});
test('UTF-8 JSON remains intact across network chunk boundaries and size limits are enforced', async t => {
  const panel = await setup(t);
  const body = Buffer.from(JSON.stringify({ name: '中文项目', type: 'command', command: 'original', cwd: panel.dataDir }));
  const cut = body.indexOf(Buffer.from('中文')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(panel.info.url + 'api/save', { method: 'POST', headers: { 'x-start-buttons-token': panel.info.token } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', x => { text += x; }); res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject); req.write(body.subarray(0, cut)); setTimeout(() => req.end(body.subarray(cut)), 10);
  });
  assert.equal(result.project.name, '中文项目');
  assert.equal((await panel.call('save', { name: 'x'.repeat(70000) })).status, 413);
});
test('launch feedback is retained per project while an accepted launch alone leaves runtime unknown', async t => {
  const panel = await setup(t, async () => ({ accepted: true, pid: 1234, message: 'accepted only' }));
  const save = async name => (await (await panel.call('save', { name, type: 'command', command: 'original', cwd: panel.dataDir })).json()).project;
  const first = await save('first'), second = await save('second');
  await panel.call('launch', { id: first.id });
  await panel.call('launch', { id: second.id });
  const snapshot = await (await panel.call('projects')).json();
  assert.equal(snapshot.launches[first.id].message, 'accepted only');
  assert.equal(snapshot.launches[second.id].message, 'accepted only');
  assert.equal(snapshot.statuses[first.id].state, 'unknown');
  assert.equal(snapshot.statuses[second.id].state, 'unknown');
  await panel.call('remove', { id: first.id });
  assert.equal((await (await panel.call('projects')).json()).launches[first.id], undefined);
});
