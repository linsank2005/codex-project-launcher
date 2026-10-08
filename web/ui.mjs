import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import { VERSION } from '../src/version.mjs';

const config = window.START_BUTTONS_CONFIG;
const byId = id => document.getElementById(id);
const form = byId('form');
const editor = byId('editor');
let projects = [], editingId, app, removalPending = false;
let projectKey, statuses = {}, refreshPromise;
const cards = new Map(), pending = new Set();
const pendingActions = new Map();
const icons = [['🚀', '火箭'], ['🧮', '计算'], ['📝', '笔记'], ['📑', '文档'], ['📁', '文件夹'], ['📊', '图表'], ['🤖', '机器人'], ['🎬', '视频'], ['🎮', '游戏'], ['🌐', '网页'], ['🎨', '设计'], ['🛠️', '工具']];
const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
function notify(message, error = false, context = '') {
  const notice = byId('notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  notice.dataset.context = context;
}
function syncIcon() {
  for (const button of byId('icon-choices').children) button.setAttribute('aria-pressed', String(button.dataset.icon === form.elements.icon.value));
}
for (const [icon, label] of icons) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-choice'; button.textContent = icon;
  button.dataset.icon = icon; button.title = label; button.setAttribute('aria-label', `选择${label}图标`);
  button.addEventListener('click', () => { form.elements.icon.value = icon; syncIcon(); });
  byId('icon-choices').append(button);
}
form.elements.icon.addEventListener('input', syncIcon);
byId('version').textContent = VERSION;
function updateStatuses() {
  let running = 0, offline = 0, unknown = 0, starting = 0, disconnected = 0, checking = 0;
  for (const project of projects) {
    const status = statuses[project.id] || { state: 'checking', label: '检查中', detail: '正在读取运行状态。', canLaunch: false };
    if (status.label === '连接中断') disconnected++;
    else if (status.state === 'checking') checking++;
    else if (status.state === 'running') running++; else if (status.state === 'offline') offline++; else if (status.label === '启动中') starting++; else unknown++;
    const card = cards.get(project.id);
    if (!card) continue;
    card.badge.dataset.state = status.state;
    text(card.badge, `${status.state === 'running' ? '✓' : status.state === 'offline' ? '○' : '–'} ${status.label}`);
    card.badge.title = status.detail || '';
    card.launch.disabled = pending.has(project.id) || status.canLaunch === false;
    const action = pendingActions.get(project.id) || status.operation;
    text(card.launchLabel, action === 'stop' ? '停止中…' : action === 'restart' ? '重启中…' : pending.has(project.id) ? '正在发起启动…' : status.state === 'checking' ? '检查中…' : status.canLaunch === false ? (status.state === 'running' ? '已运行' : status.label === '启动中' ? '启动中…' : '暂不能启动') : '启动项目');
    card.launch.title = status.launchBlockReason || '';
    card.controls.hidden = status.state !== 'running' && !action;
    card.stop.disabled = pending.has(project.id) || !status.canStop;
    card.restart.disabled = pending.has(project.id) || !status.canRestart;
    card.stop.title = card.restart.title = status.stopReason || '';
  }
  const summary = [{ state: 'running', label: '运行中', count: running },
    { state: 'offline', label: '未运行', count: offline },
    { state: 'starting', label: '启动中', count: starting },
    { state: 'unknown', label: '待确认', count: unknown },
    { state: 'disconnected', label: '连接中断', count: disconnected },
    { state: 'checking', label: '检查中', count: checking }].filter(s => s.count || (s.state === 'running' && !checking));
  const summaryNode = byId('running-summary'), key = JSON.stringify(summary);
  if (summaryNode.dataset.counts !== key) {
    summaryNode.dataset.counts = key;
    summaryNode.replaceChildren();
    for (const status of summary) {
      const chip = document.createElement('span'); chip.className = 'status-chip'; chip.dataset.state = status.state;
      chip.setAttribute('aria-label', `${status.count} 个${status.label}`);
      const dot = document.createElement('span'); dot.className = 'status-dot'; dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.textContent = status.label;
      const count = document.createElement('strong'); count.textContent = String(status.count);
      chip.append(dot, label, count); summaryNode.append(chip);
    }
  }
  if (byId('status-dialog').open) renderStatusDetail(byId('status-dialog').dataset.projectId);
}
function renderStatusDetail(id) {
  const project = projects.find(p => p.id === id), status = statuses[id];
  text(byId('status-title'), project ? `${project.name} · 运行详情` : '项目运行详情');
  text(byId('status-label'), status?.label || '检查中');
  text(byId('status-detail'), status?.detail || '正在读取运行状态。');
  text(byId('status-time'), status?.checkedAt ? new Date(status.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未取得最新检查结果');
  const suggestion = !status ? '正在检查项目状态，请稍候。' : status.label === '连接中断' ? '刷新面板重新连接；连接中断并不表示项目已经关闭。'
    : status?.state === 'unknown' ? '可在编辑中填写本地服务地址；如检查超时，请稍后重新检查。'
    : status?.state === 'running' && !status.canStop ? status.stopReason || '请在原窗口退出，或填写原项目的停止命令。'
    : status?.state === 'running' ? '可请求正常停止；重启会先等待业务进程退出。' : '项目未运行，可以从卡片启动。';
  text(byId('status-suggestion'), suggestion);
}
function openStatusDetail(id) {
  byId('status-dialog').dataset.projectId = id;
  renderStatusDetail(id); byId('status-dialog').showModal();
}
byId('status-close').addEventListener('click', () => byId('status-dialog').close());
async function call(name, args = {}) {
  if (config.mode === 'mcp') {
    const result = await app.callServerTool({ name, arguments: args },
      ['stop_shortcut', 'restart_shortcut'].includes(name) ? { timeout: 65000 } : undefined);
    return toolData(result);
  }
  const routes = { list_shortcuts: 'projects', save_shortcut: 'save', remove_shortcut: 'remove', launch_shortcut: 'launch', stop_shortcut: 'stop', restart_shortcut: 'restart' };
  const read = name === 'list_shortcuts';
  const response = await fetch(`/api/${routes[name]}`, {
    method: read ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-start-buttons-token': config.token },
    body: read ? undefined : JSON.stringify(args),
    signal: AbortSignal.timeout(['stop_shortcut', 'restart_shortcut'].includes(name) ? 65000 : 20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败。');
  return result;
}
function toolData(result) {
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '操作失败。');
  if (result.structuredContent) return result.structuredContent;
  const value = result.content?.find(c => c.type === 'text')?.text;
  if (!value) throw new Error('未收到面板数据，请刷新面板。');
  return JSON.parse(value);
}
function render(data) {
  if (!Array.isArray(data?.projects)) return;
  if (data.statuses) statuses = data.statuses;
  const nextKey = JSON.stringify(data.projects);
  if (nextKey === projectKey) { updateStatuses(); return; }
  projectKey = nextKey;
  projects = data.projects;
  const grid = byId('grid');
  grid.replaceChildren();
  cards.clear();
  byId('empty').hidden = projects.length > 0;
  byId('count').textContent = `${projects.length} 个项目快捷入口`;
  for (const project of projects) {
    const card = document.createElement('article');
    card.className = 'card';
    const edit = document.createElement('button');
    edit.className = 'icon-button edit'; edit.textContent = '⋯'; edit.setAttribute('aria-label', `编辑 ${project.name}`);
    edit.addEventListener('click', () => openEditor(project));
    const icon = document.createElement('div'); icon.className = 'project-icon'; icon.textContent = project.icon || '🚀'; icon.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('button'); badge.type = 'button'; badge.className = 'run-badge';
    badge.setAttribute('aria-label', `查看 ${project.name} 运行详情`);
    badge.addEventListener('click', () => openStatusDetail(project.id));
    const head = document.createElement('div'); head.className = 'card-head'; head.append(icon, badge);
    const title = document.createElement('h2'); title.textContent = project.name;
    const launch = document.createElement('button'); launch.className = 'launch'; launch.setAttribute('aria-label', `启动 ${project.name}`);
    const launchLabel = document.createElement('span'); launchLabel.textContent = '启动项目';
    const arrow = document.createElement('span'); arrow.className = 'action-icon'; arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6Z" fill="currentColor"/></svg>';
    launch.append(launchLabel, arrow);
    launch.disabled = pending.has(project.id);
    launch.addEventListener('click', async () => {
      if (pending.has(project.id) || !statuses[project.id] || statuses[project.id].canLaunch === false) return;
      pending.add(project.id);
      pendingActions.set(project.id, 'launch');
      launch.disabled = true; launchLabel.textContent = '正在发起启动…';
      try {
        await call('launch_shortcut', { id: project.id });
        if (byId('notice').dataset.context === 'operation') byId('notice').hidden = true;
      } catch (error) { notify(`${project.name}：${error.message}`, true, 'operation'); }
      finally {
        pending.delete(project.id);
        pendingActions.delete(project.id);
        updateStatuses(); refresh();
      }
    });
    const controls = document.createElement('div'); controls.className = 'lifecycle-actions'; controls.hidden = true;
    const stop = document.createElement('button'), restart = document.createElement('button');
    for (const [button, action, label] of [[stop, 'stop', '停止'], [restart, 'restart', '重启']]) {
      button.type = 'button'; button.className = 'secondary'; button.textContent = label;
      button.setAttribute('aria-label', `${label} ${project.name}`);
      button.addEventListener('click', async () => {
        if (pending.has(project.id) || !statuses[project.id]?.[action === 'stop' ? 'canStop' : 'canRestart']) return;
        pending.add(project.id); pendingActions.set(project.id, action); updateStatuses();
        try {
          await call(action + '_shortcut', { id: project.id });
          if (byId('notice').dataset.context === 'operation') byId('notice').hidden = true;
        } catch (error) { notify(`${project.name}：${error.message}`, true, 'operation'); }
        finally { pending.delete(project.id); pendingActions.delete(project.id); updateStatuses(); refresh(); }
      });
    }
    controls.append(stop, restart);
    card.append(edit, head, title, launch, controls); grid.append(card);
    cards.set(project.id, { badge, launch, launchLabel, controls, stop, restart });
  }
  updateStatuses();
}
function refresh() {
  if (refreshPromise) return refreshPromise;
  byId('refresh').disabled = true;
  refreshPromise = (async () => {
    try {
      render(await call('list_shortcuts'));
      const checkedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      byId('checked-at').textContent = `${checkedAt} 更新 · 每 5 秒`;
      byId('refresh').title = `${checkedAt} 已检查 · 每 5 秒自动更新，点击立即刷新`;
      if (byId('notice').dataset.context === 'connection') byId('notice').hidden = true;
    } catch (error) {
      statuses = Object.fromEntries(projects.map(p => [p.id, { state: 'unknown', label: '连接中断', detail: '无法取得最新状态，请刷新面板。' }]));
      updateStatuses(); notify(error.message, true, 'connection');
    } finally { refreshPromise = undefined; byId('refresh').disabled = false; }
  })();
  return refreshPromise;
}
byId('refresh').addEventListener('click', refresh);
function updateType() {
  const command = form.elements.type.value === 'command';
  byId('path-field').hidden = command; byId('command-field').hidden = !command;
  form.elements.path.required = !command; form.elements.command.required = command; form.elements.cwd.required = command;
  byId('cwd-hint').textContent = command ? '（必填）' : '（可选）';
  byId('cwd-description').textContent = command ? '先进入这个目录，再执行原来的启动命令。' : '脚本默认在入口文件所在目录启动；快捷方式沿用自身配置。';
}
function openEditor(project) {
  editingId = project?.id; removalPending = false;
  form.reset();
  for (const field of ['name', 'icon', 'type', 'path', 'command', 'cwd', 'healthUrl', 'stopCommand']) {
    if (project && project[field] !== undefined) form.elements[field].value = project[field];
  }
  byId('dialog-title').textContent = project ? '编辑项目' : '添加项目';
  byId('form-error').hidden = true; byId('remove').hidden = !project; byId('remove').textContent = '移除入口';
  byId('status-fields').open = Boolean(project?.healthUrl);
  syncIcon(); updateType(); editor.showModal(); form.elements.name.focus();
}
byId('add').addEventListener('click', () => openEditor());
byId('first-add').addEventListener('click', () => openEditor());
byId('close').addEventListener('click', () => editor.close());
byId('cancel').addEventListener('click', () => editor.close());
form.elements.type.addEventListener('change', updateType);
form.addEventListener('submit', async event => {
  event.preventDefault(); byId('save').disabled = true; byId('form-error').hidden = true;
  const input = Object.fromEntries(new FormData(form)); if (editingId) input.id = editingId;
  try { render(await call('save_shortcut', input)); editor.close(); notify('快捷入口已保存。'); }
  catch (error) { byId('form-error').textContent = error.message; byId('form-error').hidden = false; }
  finally { byId('save').disabled = false; }
});
byId('remove').addEventListener('click', async () => {
  if (!removalPending) { removalPending = true; byId('remove').textContent = '确认移除此入口'; return; }
  byId('remove').disabled = true;
  try { render(await call('remove_shortcut', { id: editingId })); editor.close(); notify('入口已移除，项目文件保留。'); }
  catch (error) { byId('form-error').textContent = error.message; byId('form-error').hidden = false; }
  finally { byId('remove').disabled = false; }
});
async function init() {
  try {
    render(config.initialData);
    if (config.mode === 'mcp') {
      app = new App({ name: '项目启动台', version: VERSION });
      app.ontoolresult = result => {
        try { render(toolData(result)); } catch (error) { notify(error.message, true); }
      };
      const syncTheme = context => {
        if (context?.theme === 'light' || context?.theme === 'dark') applyDocumentTheme(context.theme);
      };
      app.onhostcontextchanged = syncTheme;
      await app.connect(undefined, { timeout: 15000 });
      syncTheme(app.getHostContext());
    }
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  } catch (error) { byId('count').textContent = '连接未完成'; notify(error.message, true); }
}
init();
