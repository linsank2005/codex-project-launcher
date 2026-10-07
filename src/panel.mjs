import http from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore, getDataDir } from './store.mjs';
import { launchProject, openBrowser } from './launcher.mjs';
import { VERSION } from './version.mjs';
import { checkProjectStatuses, launchKey } from './status.mjs';
import { LaunchJournal } from './launch-journal.mjs';
import { stopProject } from './stop.mjs';
import { compareVersions } from './versions.mjs';

export const DEFAULT_PORT = 47831;
const root = path.dirname(fileURLToPath(import.meta.url));
export function pageHtml(template, config) {
  return template.replace('/*START_BUTTONS_CONFIG*/', () => JSON.stringify(config).replace(/</g, '\\u003c'));
}
export async function createPanelServer({ dataDir = getDataDir(), port = DEFAULT_PORT, launch = launchProject, stop = stopProject, checkStatuses = checkProjectStatuses, template } = {}) {
  const store = new ProjectStore(dataDir);
  template ??= await readFile(path.join(root, 'panel.html'), 'utf8');
  const token = randomBytes(32).toString('hex');
  const inFlight = new Map();
  const journal = new LaunchJournal(dataDir);
  await journal.load();
  const launches = journal.records;
  const savedIds = new Set((await store.list()).map(p => p.id));
  for (const id of launches.keys()) if (!savedIds.has(id)) launches.delete(id);
  const liveStatuses = async projects => {
    const observed = Object.fromEntries(launches);
    const statuses = await checkStatuses(projects, { launches: observed });
    const runningKeys = new Set(projects.filter(p => statuses[p.id]?.state === 'running').map(launchKey));
    let changed = false;
    for (const [id, record] of Object.entries(observed)) {
      if (record.accepted && !record.settled && runningKeys.has(record.entryKey) && launches.get(id) === record) { record.settled = true; changed = true; }
    }
    for (const project of projects) {
      const status = statuses[project.id];
      const record = launches.get(project.id);
      if (record?.accepted && record.entryKey === launchKey(project) && status?.observedProcesses &&
          JSON.stringify(record.processes || []) !== JSON.stringify(status.observedProcesses)) {
        record.processes = status.observedProcesses; changed = true;
      }
      if (status) delete status.observedProcesses;
      if (status && inFlight.has(launchKey(project))) Object.assign(status, { canLaunch: false, canStop: false, canRestart: false,
        operation: inFlight.get(launchKey(project)), launchBlockReason: '项目操作尚未完成，请稍候。' });
    }
    if (changed) await journal.save();
    return statuses;
  };
  const snapshot = async () => {
    const projects = await store.list();
    return { projects, statuses: await liveStatuses(projects), launches: Object.fromEntries(launches) };
  };
  let info, close, closePromise, closing = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const host = `127.0.0.1:${info.port}`;
      if (req.headers.host !== host) return json(403, { error: '不允许的面板地址。' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403, { error: '不允许跨站调用面板。' });
      const pathname = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        });
        return res.end(pageHtml(template, { mode: 'local', token, url: info.url }));
      }
      if (req.headers['x-start-buttons-token'] !== token) return json(403, { error: '面板授权已失效，请重新打开面板。' });
      if (closing) return json(503, { error: '面板正在更新，请重新打开插件。' });
      if (req.method === 'GET' && pathname === '/api/health') return json(200, { app: 'start-buttons', version: VERSION, dataDir });
      if (req.method === 'GET' && pathname === '/api/projects') return json(200, await snapshot());
      if (req.method !== 'POST') return json(404, { error: '接口不存在。' });
      const chunks = [];
      let bodySize = 0;
      for await (const chunk of req) {
        bodySize += chunk.length;
        if (bodySize <= 65536) chunks.push(chunk);
      }
      if (bodySize > 65536) return json(413, { error: '请求内容过大。' });
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: '请求格式不正确。' }); }
      if (pathname === '/api/shutdown') {
        if (compareVersions(input?.targetVersion, VERSION) <= 0) return json(409, { error: '只有新版插件可以更新面板，旧聊天不会降级面板。' });
        if (inFlight.size) return json(409, { error: '项目操作尚未完成，请稍后再打开新版面板。' });
        closing = true;
        await journal.queue;
        res.once('finish', () => { void close(); });
        return json(200, { stopping: true });
      }
      if (pathname === '/api/save') return json(200, { project: await store.save(input), ...await snapshot() });
      if (pathname === '/api/remove') { await store.remove(input.id); launches.delete(input.id); await journal.save(); return json(200, await snapshot()); }
      if (['/api/launch', '/api/stop', '/api/restart'].includes(pathname)) {
        const project = await store.get(input.id), key = launchKey(project);
        if (inFlight.has(key)) return json(409, { error: '此入口正在处理启动或停止，请稍候。' });
        const operation = pathname.slice('/api/'.length);
        inFlight.set(key, operation);
        try {
          // Check the underlying state before applying the operation lock to the UI.
          const status = (await checkStatuses([project], { launches: Object.fromEntries(launches) }))[project.id];
          if (operation !== 'launch' && status?.state !== 'offline') {
            if (!status?.canStop) return json(409, { error: status?.stopReason || '无法核验停止目标，请在原窗口退出。', status });
            const stopped = await stop(project, { launches: Object.fromEntries(launches) });
            if (!stopped.stopped) throw new Error('尚未确认业务进程退出，未重新启动。');
            const now = new Date().toISOString(), receipt = launches.get(project.id);
            launches.set(project.id, { ...receipt, accepted: true, settled: true, entryKey: key, at: now,
              stoppedAt: now, processes: [], message: stopped.message || '项目已停止。' });
            await journal.save();
            if (operation === 'stop') return json(200, stopped);
          } else if (operation === 'stop') return json(200, { stopped: true, message: '项目已停止，无需再次操作。' });
          const current = operation === 'restart' ? (await checkStatuses([project], { launches: Object.fromEntries(launches) }))[project.id] : status;
          if (current?.canLaunch === false || current?.state === 'running') return json(409, { error: current.launchBlockReason || '项目已在运行，请先关闭原程序。', status: current });
          const result = await launch(project);
          launches.set(input.id, { message: result.message || '已发起启动。', accepted: result.accepted, pid: result.pid, startedAt: result.startedAt, entryKey: key, at: new Date().toISOString() });
          await journal.save();
          return json(200, result);
        } catch (error) {
          if ((await store.list()).some(p => p.id === input.id)) {
            launches.set(input.id, { ...launches.get(input.id), entryKey: key, message: error.message, error: true, at: new Date().toISOString() });
            await journal.save();
          }
          throw error;
        }
        finally { inFlight.delete(key); }
      }
      return json(404, { error: '接口不存在。' });
    } catch (error) { if (!res.writableEnded) json(400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  info = { app: 'start-buttons', version: VERSION, port: server.address().port, token, url: `http://127.0.0.1:${server.address().port}/`, pid: process.pid, dataDir };
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'runtime.json'), JSON.stringify(info), { mode: 0o600 });
  close = () => closePromise ??= (async () => {
    closing = true;
    await journal.queue;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try {
      const record = JSON.parse(await readFile(path.join(dataDir, 'runtime.json'), 'utf8'));
      if (record.token === token) await unlink(path.join(dataDir, 'runtime.json'));
    } catch { /* Another instance may already have replaced its record. */ }
  })();
  return { server, store, info, close };
}
export async function currentPanel(dataDir = getDataDir()) {
  try {
    const info = JSON.parse(await readFile(path.join(dataDir, 'runtime.json'), 'utf8'));
    if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{64}$/.test(info.token)) return null;
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { 'x-start-buttons-token': info.token }, signal: AbortSignal.timeout(800) });
    const health = await response.json();
    if (response.ok && health.app === 'start-buttons' && health.dataDir === dataDir) return { ...info, version: health.version, url: `http://127.0.0.1:${info.port}/` };
  } catch { /* Missing or stale runtime record. */ }
  return null;
}
