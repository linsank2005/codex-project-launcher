import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function embeddedPanel(hostContext, { initialData, connect } = {}) {
  const nodes = new Map(), calls = [], themes = [];
  function element() {
    return { textContent: '', dataset: {}, children: [], listeners: {}, classList: { toggle() {} },
      attributes: {}, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; } };
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const defaults = { name: '', icon: '🚀', type: 'file', path: '', command: '', cwd: '', healthUrl: '', stopCommand: '' };
  get('form').elements = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, { ...element(), value, focus() {} }]));
  get('form').reset = () => { for (const [name, value] of Object.entries(defaults)) get('form').elements[name].value = value; };
  let app;
  class HostApp {
    constructor() { app = this; }
    async connect() { await connect?.(); }
    getHostContext() { return hostContext; }
    async callServerTool(input) {
      calls.push(input);
      if (this.fail || this.failTool === input.name) throw new Error(this.errorMessage || 'connection failed');
      return { structuredContent: this.data || { projects: [] } };
    }
  }
  // Execute the actual view against a minimal DOM and the MCP host boundary;
  // neither the renderer nor its notification handler is duplicated here.
  const source = (await readFile(new URL('../web/ui.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, vm.createContext({ App: HostApp, applyDocumentTheme: theme => themes.push(theme), VERSION: 'test', window: { START_BUTTONS_CONFIG: { mode: 'mcp', initialData } },
    document: { getElementById: get, createElement: element, addEventListener() {} }, setInterval() {} }));
  await new Promise(resolve => setImmediate(resolve));
  return { app, get, calls, themes, launchButton: () => get('grid').children[0].children.find(c => c.className === 'launch') };
}

test('saved cards render before host connection, wait for verification and survive a late initial result', async () => {
  const project = { id: 'a', name: 'First paint', type: 'command', command: 'original' };
  let connected;
  const view = await embeddedPanel(undefined, { initialData: { projects: [project] },
    connect: () => new Promise(resolve => { connected = resolve; }) });
  const card = view.get('grid').children[0], launch = view.launchButton();
  assert.equal(view.get('count').textContent, '1 个项目快捷入口');
  assert.equal(launch.disabled, true);
  assert.equal(launch.children[0].textContent, '检查中…');
  assert.deepEqual(view.get('running-summary').children.map(c => c.attributes['aria-label']), ['1 个检查中']);
  await launch.listeners.click();
  assert.equal(view.calls.length, 0, 'No operation runs before verification.');
  view.app.data = { projects: [project], statuses: { a: { state: 'running', label: '运行中', canLaunch: false, canStop: true, canRestart: true } } };
  connected(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.calls.filter(c => c.name === 'list_shortcuts').length, 1);
  assert.equal(view.get('grid').children[0], card);
  assert.equal(card.children.find(c => c.className === 'lifecycle-actions').hidden, false);
  view.app.ontoolresult({ structuredContent: { projects: [project], url: 'http://127.0.0.1:47831/' } });
  assert.equal(launch.disabled, true);
  assert.equal(launch.children[0].textContent, '已运行', 'A late initial result must not erase a newer status.');
});

test('embedded panel follows initial and changed host themes without resetting project cards', async () => {
  const view = await embeddedPanel({ theme: 'light' });
  assert.deepEqual(view.themes, ['light']);
  view.app.ontoolresult({ structuredContent: { projects: [{ id: 'a', name: 'Theme change', type: 'command', command: 'original' }] } });
  const card = view.get('grid').children[0];
  view.app.onhostcontextchanged({ theme: 'dark' });
  view.app.onhostcontextchanged({ locale: 'zh-CN' });
  view.app.onhostcontextchanged({ theme: 'unsupported' });
  view.app.onhostcontextchanged({ theme: 'light' });
  assert.deepEqual(view.themes, ['light', 'dark', 'light']);
  assert.equal(view.get('grid').children[0], card);
});

test('status details are accessible by click and connection errors have their own summary', async () => {
  const view = await embeddedPanel();
  view.app.ontoolresult({ structuredContent: { projects: [{ id: 'a', name: 'Fixture', type: 'command' }],
    statuses: { a: { state: 'unknown', label: '待确认', detail: 'Cannot associate launcher', checkedAt: '2026-10-04T01:00:00Z' } } } });
  const card = view.get('grid').children[0], badge = card.children.find(c => c.className === 'card-head').children[1];
  badge.listeners.click();
  assert.equal(view.get('status-dialog').open, true); assert.equal(view.get('status-detail').textContent, 'Cannot associate launcher');
  view.app.fail = true;
  await view.get('refresh').listeners.click();
  assert.deepEqual(view.get('running-summary').children.map(c => c.attributes['aria-label']), ['0 个运行中', '1 个连接中断']);
  assert.match(view.get('status-suggestion').textContent, /并不表示项目已经关闭/);
});
test('stop and restart are available only for verified projects and call the selected saved ID', async () => {
  const view = await embeddedPanel();
  view.app.ontoolresult({ structuredContent: { projects: [{ id: 'a', name: 'Fixture', type: 'command' }],
    statuses: { a: { state: 'running', label: '运行中', canLaunch: false, canStop: true, canRestart: true } } } });
  const card = view.get('grid').children[0], controls = card.children.find(c => c.className === 'lifecycle-actions');
  assert.equal(controls.hidden, false); assert.equal(controls.children[0].disabled, false);
  await controls.children[0].listeners.click();
  assert.equal(view.calls.find(c => c.name === 'stop_shortcut').arguments.id, 'a');
  view.app.ontoolresult({ structuredContent: { projects: [{ id: 'a', name: 'Fixture', type: 'command' }],
    statuses: { a: { state: 'running', label: '运行中', canStop: false, canRestart: false } } } });
  const next = view.get('grid').children[0].children.find(c => c.className === 'lifecycle-actions');
  await next.children[1].listeners.click();
  assert.equal(view.calls.filter(c => c.name === 'restart_shortcut').length, 0);
});

test('embedded panel consumes standard host results immediately and disables or re-enables the project as status changes', async () => {
  const view = await embeddedPanel(), project = { id: 'a', name: 'Host update', type: 'command', command: 'original' };
  view.app.ontoolresult({ content: [], structuredContent: { projects: [project], statuses: { a: { state: 'running', label: '运行中', canLaunch: false, launchBlockReason: 'already running' } } } });
  assert.equal(view.get('grid').children.length, 1);
  assert.equal(view.get('count').textContent, '1 个项目快捷入口');
  assert.equal(view.launchButton().disabled, true);
  assert.equal(view.launchButton().title, 'already running');
  await view.launchButton().listeners.click();
  assert.equal(view.calls.filter(c => c.name === 'launch_shortcut').length, 0);
  view.app.ontoolresult({ content: [{ type: 'text', text: JSON.stringify({ projects: [project], statuses: { a: { state: 'offline', label: '未连接', canLaunch: true } } }) }] });
  assert.equal(view.launchButton().disabled, false);
  assert.equal(view.launchButton().children[0].textContent, '启动项目');
});

test('host errors and malformed notifications preserve current projects and show a usable error', async () => {
  const view = await embeddedPanel(), project = { id: 'a', name: 'Original', type: 'command', command: 'original' };
  view.app.ontoolresult({ structuredContent: { projects: [project] } });
  view.app.ontoolresult({ isError: true, content: [{ type: 'text', text: 'host failed' }] });
  assert.equal(view.get('notice').textContent, 'host failed');
  assert.equal(view.get('grid').children.length, 1);
  assert.doesNotThrow(() => view.app.ontoolresult({ content: [] }));
  assert.match(view.get('notice').textContent, /未收到/);
  assert.equal(view.get('grid').children.length, 1);
});

test('starting projects have a separate summary and stopped projects restore the launch button', async () => {
  const view = await embeddedPanel(), project = { id: 'xhs', name: '小红书', type: 'file', path: 'start-windows.cmd' };
  view.app.ontoolresult({ structuredContent: { projects: [project], statuses: { xhs: { state: 'unknown', label: '启动中', canLaunch: false } } } });
  assert.deepEqual(view.get('running-summary').children.map(c => c.attributes['aria-label']), ['0 个运行中', '1 个启动中']);
  assert.equal(view.launchButton().children[0].textContent, '启动中…');
  view.app.ontoolresult({ structuredContent: { projects: [project], statuses: { xhs: { state: 'offline', label: '未运行', canLaunch: true } } } });
  assert.deepEqual(view.get('running-summary').children.map(c => c.attributes['aria-label']), ['0 个运行中', '1 个未运行']);
  assert.equal(view.launchButton().disabled, false);
});

test('status chips count each state independently and update without rebuilding project cards', async () => {
  const view = await embeddedPanel();
  const projects = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id, type: 'command', command: id }));
  const statuses = { a: { state: 'running', label: '运行中' }, b: { state: 'offline', label: '未运行' },
    c: { state: 'offline', label: '未连接' }, d: { state: 'unknown', label: '启动中' }, e: { state: 'unknown', label: '待确认' } };
  view.app.ontoolresult({ structuredContent: { projects, statuses } });
  const card = view.get('grid').children[0];
  assert.deepEqual(view.get('running-summary').children.map(c => c.attributes['aria-label']), ['1 个运行中', '2 个未运行', '1 个启动中', '1 个待确认']);
  statuses.d = { state: 'running', label: '运行中' }; statuses.e = { state: 'offline', label: '未运行' };
  view.app.ontoolresult({ structuredContent: { projects, statuses } });
  assert.deepEqual(view.get('running-summary').children.map(c => c.attributes['aria-label']), ['2 个运行中', '3 个未运行']);
  assert.equal(view.get('grid').children[0], card);
});

test('compact cards omit startup paths, entry descriptions and receipt text while editing keeps the original configuration', async () => {
  const view = await embeddedPanel(), project = { id: 'a', name: 'Workspace', icon: '🎨', type: 'file',
    path: 'D:/Projects/demo/start.cmd', cwd: 'D:/Projects/demo', healthUrl: 'http://127.0.0.1:3000/', stopCommand: './stop.ps1' };
  view.app.ontoolresult({ structuredContent: { projects: [project, { id: 'b', name: 'Command', type: 'command', command: 'npm run dev' }],
    statuses: { a: { state: 'offline', label: '未运行', canLaunch: true, method: 'none' } },
    launches: { a: { at: '2026-10-05T01:00:00Z', message: '项目业务进程已退出。' } } } });
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  for (const card of view.get('grid').children) {
    const nodes = descendants(card);
    assert.ok(!nodes.some(n => ['entry-type', 'entry-path', 'status-hint', 'card-feedback'].includes(n.className)));
    const visibleText = nodes.map(n => n.textContent).join(' ');
    for (const hiddenText of [project.path, 'npm run dev', '已有启动入口', '项目业务进程已退出']) assert.ok(!visibleText.includes(hiddenText));
    assert.ok(nodes.some(n => n.className === 'run-badge'));
    assert.ok(nodes.some(n => n.className === 'launch'));
  }
  view.get('grid').children[0].children.find(n => n.className === 'icon-button edit').listeners.click();
  assert.equal(view.get('editor').open, true);
  for (const field of ['name', 'icon', 'type', 'path', 'cwd', 'healthUrl', 'stopCommand']) assert.equal(view.get('form').elements[field].value, project[field]);
  assert.equal(view.get('icon-choices').children.find(n => n.dataset.icon === '🎨').attributes['aria-pressed'], 'true');
});

for (const action of ['launch', 'stop', 'restart']) {
  test(`${action} errors remain visible above compact cards after a successful status refresh and clear after retry`, async () => {
    const view = await embeddedPanel(), project = { id: 'a', name: 'Fixture', type: 'command', command: 'original' };
    view.app.data = { projects: [project], statuses: { a: { state: action === 'launch' ? 'offline' : 'running', label: '测试状态',
      canLaunch: action === 'launch', canStop: true, canRestart: true } } };
    view.app.ontoolresult({ structuredContent: view.app.data });
    view.app.failTool = action + '_shortcut'; view.app.errorMessage = 'The original service did not respond.';
    const button = action === 'launch' ? view.launchButton()
      : view.get('grid').children[0].children.find(n => n.className === 'lifecycle-actions').children[action === 'stop' ? 0 : 1];
    await button.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.get('notice').hidden, false);
    assert.equal(view.get('notice').textContent, 'Fixture：The original service did not respond.');
    assert.equal(view.get('notice').dataset.context, 'operation');
    assert.equal(view.get('grid').children.length, 1);
    assert.equal(button.disabled, false);
    view.app.failTool = undefined;
    await button.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.get('notice').hidden, true);
    assert.equal(view.calls.filter(c => c.name === action + '_shortcut').length, 2);
  });
}
