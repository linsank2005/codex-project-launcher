import { spawn, execFile } from 'node:child_process';
import { mkdir, open, readFile, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentPanel, DEFAULT_PORT } from './panel.mjs';
import { getDataDir } from './store.mjs';
import { VERSION } from './version.mjs';
import { compareVersions } from './versions.mjs';
import { windowsPowerShellPath } from './powershell.mjs';

const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transitions = new Map();
const root = path.dirname(fileURLToPath(import.meta.url));
const versionMatches = info => {
  if (!info) return false;
  const order = compareVersions(info.version, VERSION);
  if (order > 0) throw new Error('项目启动台已更新到更新版本。请新建 Codex 聊天使用新版插件，旧聊天不会降级面板。');
  return order === 0;
};

async function withTransitionLock(dataDir, action) {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'panel-start.lock'), nonce = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); acquired = true; }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const bytes = await readFile(file, 'utf8');
        let dead = false;
        try {
          const owner = JSON.parse(bytes);
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
          } else dead = Date.now() - (await stat(file)).mtimeMs > 30000;
        } catch { dead = Date.now() - (await stat(file)).mtimeMs > 30000; }
        if (dead && await readFile(file, 'utf8') === bytes) await unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await sleep(100);
    }
  }
  if (!acquired) throw new Error('面板正在由另一个聊天更新，请稍后再试。');
  try { return await action(); }
  finally {
    const owner = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (owner?.nonce === nonce) await unlink(file).catch(() => {});
  }
}

async function retirePanel(existing, dataDir) {
  const headers = { 'x-start-buttons-token': existing.token, 'Content-Type': 'application/json' };
  const response = await fetch(`${existing.url}api/shutdown`, {
    method: 'POST', headers, body: JSON.stringify({ targetVersion: VERSION }), signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) {
    // Older releases did not have an authenticated shutdown API.
    const snapshotResponse = await fetch(`${existing.url}api/projects`, { headers, signal: AbortSignal.timeout(15000) });
    const snapshot = await snapshotResponse.json();
    if (!snapshotResponse.ok || !snapshot.statuses || Object.values(snapshot.statuses).some(status => status.operation)) {
      throw new Error('项目操作尚未完成，请稍后再打开新版面板。');
    }
    const cacheRoot = path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex'), 'plugins', 'cache', 'start-buttons-local', 'start-buttons');
    const payload = Buffer.from(JSON.stringify({ pid: existing.pid, port: existing.port, cacheRoot }), 'utf8').toString('base64');
    try {
      await run(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'upgrade-panel.ps1'), '-Payload', payload], { windowsHide: true, timeout: 15000 });
    } catch { throw new Error('无法核验旧面板进程，未关闭任何项目。请关闭旧面板进程后重新打开插件。'); }
  } else if (!response.ok) {
    const result = await response.json(); throw new Error(result.error || '旧面板暂时无法更新，请稍后再试。');
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const active = await currentPanel(dataDir);
    if (!active || active.token !== existing.token) return;
    await sleep(100);
  }
  throw new Error('旧面板尚未退出，请稍后再打开插件。');
}

export async function ensurePanel(dataDir = getDataDir()) {
  dataDir = path.resolve(dataDir);
  const existing = await currentPanel(dataDir);
  if (versionMatches(existing)) return existing;
  if (transitions.has(dataDir)) return transitions.get(dataDir);
  const transition = withTransitionLock(dataDir, async () => {
    const current = await currentPanel(dataDir);
    if (versionMatches(current)) return current;
    if (current) await retirePanel(current, dataDir);
    const replacement = await currentPanel(dataDir);
    if (versionMatches(replacement)) return replacement;
    if (replacement) throw new Error('面板正在切换版本，请稍后再试。');
    return startPanel(dataDir);
  });
  transitions.set(dataDir, transition);
  try { return await transition; } finally { transitions.delete(dataDir); }
}

async function startPanel(dataDir) {
  const child = spawn(process.execPath, [path.join(root, 'panel.mjs'), '--daemon'], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, START_BUTTONS_DATA_DIR: dataDir },
  });
  let startError;
  child.once('error', error => { startError = error; });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startError) throw startError;
    await sleep(100);
    const info = await currentPanel(dataDir);
    if (versionMatches(info)) return info;
  }
  throw new Error(`无法启动本地面板。请检查端口 ${process.env.START_BUTTONS_PORT || DEFAULT_PORT} 是否被占用，或双击“启动面板.cmd”查看原因。`);
}
export async function panelCall(endpoint, input, dataDir = getDataDir()) {
  const info = await ensurePanel(dataDir);
  const response = await fetch(`${info.url}api/${endpoint}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'x-start-buttons-token': info.token, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(['stop', 'restart'].includes(endpoint) ? 60000 : 20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '面板操作失败。');
  return result;
}
