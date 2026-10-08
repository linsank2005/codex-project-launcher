import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createPanelServer } from '../src/panel.mjs';
import { LaunchJournal } from '../src/launch-journal.mjs';
import { stopProject } from '../src/stop.mjs';
import { checkProjectStatuses, inspectProjectProcesses, launchKey } from '../src/status.mjs';
import { tempDir } from './helpers.mjs';

const born = '2026-10-04T01:00:00.000Z';
const project = { id: 'a', type: 'command', command: 'original', cwd: process.cwd() };
const root = { pid: 10, born, name: 'pwsh.exe' }, business = { pid: 11, parent: 10, born, name: 'node.exe' };
test('launch journal survives reopening and retains birth identities instead of trusting PID alone', async t => {
  const dir = await tempDir(t), journal = new LaunchJournal(dir);
  journal.records.set('a', { accepted: true, entryKey: launchKey(project), pid: 10, startedAt: born, at: born, settled: true,
    processes: [{ pid: 11, born }], message: 'original' });
  await journal.save();
  const reopened = new LaunchJournal(dir); await reopened.load();
  const launch = reopened.records.get('a');
  assert.equal(launch.pid, 10); assert.equal(launch.settled, true); assert.deepEqual(launch.processes, [{ pid: 11, born }]);
  const options = { launches: Object.fromEntries(reopened.records), startupProcesses: async () => [business] };
  assert.equal((await checkProjectStatuses([project], options)).a.state, 'running', 'A detached business child remains identifiable after its parent exits.');
  assert.equal((await checkProjectStatuses([project], { ...options, startupProcesses: async () => [{ ...business, born: '2026-10-04T02:00:00Z' }] })).a.state, 'offline');
  assert.equal((await checkProjectStatuses([{ ...project, command: 'changed' }], options)).a.state, 'unknown');
});
test('invalid launch journal is preserved and cannot supply stop targets', async t => {
  const dir = await tempDir(t), journal = new LaunchJournal(dir);
  for (const bad of ['invalid JSON', JSON.stringify({ version: 1, records: [] }), JSON.stringify({ version: 1, records: { a: { entryKey: launchKey(project), at: born, processes: [{ pid: 11, born: 'invalid' }] } } })]) {
    await writeFile(journal.file, bad);
    await assert.rejects(journal.load(), /启动记录/);
    assert.equal(await readFile(journal.file, 'utf8'), bad);
  }
});
test('normal stop signals the owned console and succeeds only after business processes exit', async () => {
  let checks = 0, signaled;
  const result = await stopProject(project, { inspect: async () => ++checks === 1 ? { roots: [root], owned: [root, business], business: [business] }
    : { roots: [root], owned: [root], business: [] }, signal: async (...args) => { signaled = args; } });
  assert.equal(result.stopped, true); assert.equal(signaled[0], root.pid);
  assert.deepEqual(signaled[1], [root, business].map(p => ({ pid: p.pid, born: p.born })));
});
test('unknown ownership or multiple consoles never receive a stop signal', async () => {
  let signals = 0;
  for (const state of [{ roots: [], owned: [], business: [] }, { roots: [root, { ...root, pid: 12 }], owned: [root, business], business: [business] }]) {
    await assert.rejects(stopProject(project, { inspect: async () => state, signal: async () => { signals++; } }));
  }
  assert.equal(signals, 0);
});

test('a CMD question returns before exit and its answer continues the same console without another Ctrl+C', async () => {
  const prompt = { prompt: 'Terminate batch job (Y/N)?', position: '4:26' };
  const initial = await stopProject(project, { inspect: async () => ({ roots: [root], owned: [root, business], business: [business] }),
    signal: async () => ({ confirmation: prompt }) });
  assert.equal(initial.stopped, false);
  assert.equal(initial.confirmation.targetPid, root.pid);
  for (const answer of [true, false]) {
    let signals = 0;
    const result = await stopProject(project, { confirmation: initial.confirmation, answer,
      signal: async (targetPid, expected, options) => {
        signals++; assert.equal(targetPid, root.pid);
        assert.deepEqual(expected, [root, business].map(p => ({ pid: p.pid, born: p.born })));
        assert.equal(options.action, 'answer'); assert.equal(options.answer, answer); assert.equal(options.prompt, prompt.prompt);
      }, inspect: async () => ({ roots: [], owned: [], business: [] }) });
    assert.equal(signals, 1); assert.equal(result.stopped, true);
    assert.equal(Boolean(result.cancelled), !answer);
  }
  await assert.rejects(stopProject(project, { confirmation: initial.confirmation, answer: 'Y', signal: async () => assert.fail('Invalid input must not reach the console.') }), /是或否/);
});

test('a prompt that appears after the first signal is still detected after business exit', async () => {
  let checks = 0, signals = 0;
  const result = await stopProject(project, { inspect: async () => ++checks === 1
    ? { roots: [root], owned: [root, business], business: [business] } : { roots: [root], owned: [root], business: [] },
    signal: async (pid, expected, options) => {
      signals++;
      if (!options) return { mayConfirm: true };
      assert.equal(options.action, 'read');
      return { confirmation: { prompt: 'Terminate batch job (Y/N)?', position: '4:26' } };
    } });
  assert.equal(result.stopped, false); assert.equal(signals, 2); assert.ok(result.confirmation);
});

test('an idle old terminal does not hide the single active terminal; two active terminals still block automatic stop', async () => {
  const p = { id: 'file', type: 'file', path: path.resolve('start.ps1') };
  const active = { ...root, command: `pwsh.exe -File "${p.path}"` };
  const idle = { ...active, pid: 12 };
  const options = { startupProcesses: async () => [active, business, idle] };
  const state = (await checkProjectStatuses([p], options)).file;
  assert.equal(state.canStop, true);
  assert.deepEqual((await inspectProjectProcesses(p, options)).roots.map(r => r.pid), [active.pid]);
  const second = { ...business, pid: 13, parent: idle.pid };
  assert.equal((await checkProjectStatuses([p], { startupProcesses: async () => [active, business, idle, second] })).file.canStop, false);
});
test('a configured stop command is used and an unresponsive service is not reported stopped', async () => {
  let commands = 0, signals = 0;
  await assert.rejects(stopProject({ ...project, stopCommand: 'original stop' }, { timeoutMs: 0,
    inspect: async () => ({ roots: [root], owned: [root, business], business: [business] }),
    command: async p => { commands++; assert.equal(p.stopCommand, 'original stop'); }, signal: async () => { signals++; } }), /仍在运行/);
  assert.equal(commands, 1); assert.equal(signals, 0);
});

async function panelCall(panel, route, input) {
  const response = await fetch(panel.info.url + 'api/' + route, { method: input ? 'POST' : 'GET',
    headers: { 'x-start-buttons-token': panel.info.token, 'Content-Type': 'application/json' }, body: input ? JSON.stringify(input) : undefined });
  return { response, data: await response.json() };
}
test('HTTP restart waits for verified stop; operation locks include saved aliases and preserve other projects', async t => {
  const dir = await tempDir(t); let running = true, release, launchCalls = 0;
  const panel = await createPanelServer({ dataDir: dir, port: 0, template: '/*START_BUTTONS_CONFIG*/',
    checkStatuses: async projects => Object.fromEntries(projects.map(p => [p.id, { state: running ? 'running' : 'offline', canLaunch: !running, canStop: running }])),
    stop: async () => new Promise(resolve => { release = () => { running = false; resolve({ stopped: true }); }; }),
    launch: async () => { assert.equal(running, false); launchCalls++; running = true; return { accepted: true }; } });
  t.after(() => panel.close());
  const save = async name => (await panelCall(panel, 'save', { ...project, id: undefined, name, cwd: dir })).data.project;
  const first = await save('first'), alias = await save('alias');
  const restart = panelCall(panel, 'restart', { id: first.id });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await panelCall(panel, 'launch', { id: alias.id })).response.status, 409);
  assert.equal((await panelCall(panel, 'stop', { id: alias.id })).response.status, 409);
  assert.equal(launchCalls, 0); release();
  assert.equal((await restart).response.status, 200); assert.equal(launchCalls, 1);
});
test('restart does not launch after a failed stop or an occupied address', async t => {
  for (const verified of [false, true]) {
    const dir = await tempDir(t); let calls = 0, stopped = false;
    const panel = await createPanelServer({ dataDir: dir, port: 0, template: '',
      checkStatuses: async projects => Object.fromEntries(projects.map(p => [p.id, { state: stopped ? 'offline' : 'running', canStop: true, canLaunch: false }])),
      stop: async () => { stopped = true; return { stopped: verified }; }, launch: async () => { calls++; } });
    t.after(() => panel.close());
    const saved = (await panelCall(panel, 'save', { ...project, name: 'blocked', cwd: dir })).data.project;
    assert.equal((await panelCall(panel, 'restart', { id: saved.id })).response.ok, false);
    assert.equal(calls, 0);
  }
});

for (const answer of [true, false]) {
  test(`HTTP pending restart survives refresh, validates its answer, and ${answer ? 'restarts only after Yes' : 'never restarts after No'}`, async t => {
    const dir = await tempDir(t); let running = true, stops = 0, launchCalls = 0;
    const panel = await createPanelServer({ dataDir: dir, port: 0, template: '',
      checkStatuses: async projects => Object.fromEntries(projects.map(p => [p.id, { state: running ? 'running' : 'offline', canLaunch: !running, canStop: running }])),
      stop: async (p, options) => {
        stops++;
        if (options.confirmation) {
          assert.equal(options.answer, answer); assert.equal(options.confirmation.targetPid, root.pid);
          return { stopped: true, cancelled: !options.answer };
        }
        running = false;
        return { stopped: false, confirmation: { prompt: 'Terminate batch job (Y/N)?', position: '4:26', targetPid: root.pid, processes: [root] } };
      }, launch: async () => { launchCalls++; running = true; return { accepted: true }; } });
    t.after(() => panel.close());
    const saved = (await panelCall(panel, 'save', { ...project, name: 'confirm', cwd: dir })).data.project;
    const alias = (await panelCall(panel, 'save', { ...project, id: 'alias', name: 'same entry', cwd: dir })).data.project;
    const pending = (await panelCall(panel, 'restart', { id: saved.id })).data;
    assert.equal(launchCalls, 0); assert.equal(pending.stopped, false);
    const snapshot = (await panelCall(panel, 'projects')).data;
    assert.equal(snapshot.statuses[saved.id].label, '等待关闭确认');
    assert.equal(snapshot.statuses[alias.id].canLaunch, false);
    assert.equal(snapshot.statuses[saved.id].confirmation.token, pending.confirmation.token);
    assert.equal(pending.confirmation.processes, undefined, 'Only a server-side ownership record supplies console targets.');
    assert.deepEqual((await panelCall(panel, 'restart', { id: saved.id })).data, pending);
    assert.equal(stops, 1);
    for (const route of ['launch', 'stop']) assert.equal((await panelCall(panel, route, { id: alias.id })).response.status, 409);
    for (const route of ['save', 'remove']) assert.equal((await panelCall(panel, route, { ...saved, command: 'changed' })).response.status, 409);
    assert.equal((await panelCall(panel, 'shutdown', { targetVersion: '99.0.0' })).response.status, 409);
    const args = { id: saved.id, confirmationToken: pending.confirmation.token, answer };
    assert.equal((await panelCall(panel, 'restart', { ...args, answer: 'Y' })).response.status, 400);
    assert.equal((await panelCall(panel, 'restart', { ...args, confirmationToken: '0'.repeat(64) })).response.status, 409);
    assert.equal((await panelCall(panel, 'stop', args)).response.status, 409);
    assert.equal((await panelCall(panel, 'restart', { ...args, id: alias.id })).response.status, 409);
    assert.equal(stops, 1);
    const result = await panelCall(panel, 'restart', args);
    assert.equal(result.response.status, 200); assert.equal(launchCalls, answer ? 1 : 0);
    assert.equal(Boolean(result.data.cancelled), !answer);
    assert.equal((await panelCall(panel, 'restart', args)).response.status, 409, 'An answer token cannot be replayed.');
    const after = (await panelCall(panel, 'projects')).data;
    assert.equal(after.statuses[saved.id].confirmation, undefined);
    if (!answer) assert.equal(after.launches[saved.id].settled, true);
  });
}
test('panel reload restores receipts, persists discovered descendants, and ignores changed entries', async t => {
  const dir = await tempDir(t);
  const options = { dataDir: dir, port: 0, template: '',
    checkStatuses: async (projects, { launches }) => checkProjectStatuses(projects, { launches, startupProcesses: async () => [root, business] }),
    launch: async () => ({ accepted: true, pid: root.pid, startedAt: born }) };
  const first = await createPanelServer(options);
  const saved = (await panelCall(first, 'save', { ...project, name: 'persisted', cwd: dir })).data.project;
  await panelCall(first, 'launch', { id: saved.id }); await panelCall(first, 'projects'); await first.close();
  const second = await createPanelServer(options); t.after(() => second.close());
  const snapshot = (await panelCall(second, 'projects')).data;
  assert.equal(snapshot.statuses[saved.id].state, 'running'); assert.equal(snapshot.launches[saved.id].settled, true);
  assert.ok(snapshot.launches[saved.id].processes.some(p => p.pid === business.pid));
  const changed = (await panelCall(second, 'save', { ...saved, command: 'different' })).data;
  assert.equal(changed.statuses[saved.id].state, 'unknown');
  for (const route of ['stop', 'restart']) {
    assert.equal((await fetch(second.info.url + 'api/' + route, { method: 'POST', body: JSON.stringify({ id: saved.id }) })).status, 403);
  }
});
