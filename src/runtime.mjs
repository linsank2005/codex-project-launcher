import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentPanel, DEFAULT_PORT } from './panel.mjs';
import { getDataDir } from './store.mjs';
import { VERSION } from './version.mjs';

export async function ensurePanel(dataDir = getDataDir()) {
  const existing = await currentPanel(dataDir);
  if (existing) {
    if (existing.version !== VERSION) throw new Error('面板仍在运行旧版本。请双击“安装插件.cmd”完成更新，再刷新面板。');
    return existing;
  }
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel.mjs'), '--daemon'], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, START_BUTTONS_DATA_DIR: dataDir },
  });
  let startError;
  child.once('error', error => { startError = error; });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startError) throw startError;
    await new Promise(resolve => setTimeout(resolve, 100));
    const info = await currentPanel(dataDir);
    if (info) return info;
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
