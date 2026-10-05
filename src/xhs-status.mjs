import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

async function smallFile(file) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('状态文件过大或不是普通文件。');
    return { text: await handle.readFile('utf8'), modified: stat.mtimeMs };
  } finally { await handle.close(); }
}

// Read the known launcher's contract; never import or execute project code.
// Explicit healthUrl settings continue to use the normal configured check.
export async function discoverXhsCheck(project, env = process.env) {
  if (project.healthUrl || project.type !== 'file' || path.basename(project.path || '').toLowerCase() !== 'start-windows.cmd') return null;
  try {
    const root = await realpath(path.dirname(path.resolve(project.path)));
    const [entry, manifest, launcher] = await Promise.all([
      smallFile(project.path), smallFile(path.join(root, 'package.json')), smallFile(path.join(root, 'scripts', 'launch.mjs')),
    ]);
    const pkg = JSON.parse(manifest.text);
    if (pkg.name !== 'xiaohongshu-cover-simulator' || pkg.scripts?.launch !== 'node scripts/launch.mjs' ||
        !/^\s*node\s+scripts[\\/]launch\.mjs\s*$/im.test(entry.text) ||
        !launcher.text.includes('launcher.lock') || !launcher.text.includes('"xhs-cover-simulator"') ||
        !launcher.text.includes('export function launcherFingerprint(') ||
        !/createHash\((["'])sha256\1\)\.update\(`\$\{path\.resolve\(directory\)\}\\n\$\{path\.resolve\(dataDir\)\}`\)\.digest\((["'])hex\2\)\.slice\(0,\s*32\)/.test(launcher.text) ||
        !/for\s*\(let candidate = 3001; candidate <= 3010; candidate\+\+\)/.test(launcher.text)) return null;
    const dataDir = path.resolve(root, env.SIMULATOR_DATA_DIR || 'data');
    const workspace = createHash('sha256').update(`${root}\n${dataDir}`).digest('hex').slice(0, 32);
    return { root, workspace, lockFile: path.join(dataDir, 'launcher.lock'), ports: Array.from({ length: 10 }, (_, i) => 3001 + i) };
  } catch { return null; }
}

async function healthProbe(profile, port, request, timeoutMs) {
  const url = `http://127.0.0.1:${port}/api/health`;
  let response;
  try {
    response = await request(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', cache: 'no-store' });
    if (!response.ok) return { port, received: true, uncertain: true };
    const reader = response.body?.getReader();
    if (!reader) return { port, received: true, uncertain: true };
    let text = '', size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) return { port, received: true, uncertain: true };
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    let data;
    try { data = JSON.parse(text); } catch { return { port, received: true, uncertain: true }; }
    return { port, received: true, match: data?.app === 'xhs-cover-simulator' && data.workspace === profile.workspace, url };
  } catch (error) {
    const refused = error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED';
    return { port, uncertain: !refused, timeout: error.name === 'TimeoutError' || error.name === 'AbortError' };
  } finally { await response?.body?.cancel().catch(() => {}); }
}

function lockOwner(profile, lock, modified, records) {
  const record = records.find(p => p.pid === lock.pid);
  if (!record || (record.name || '').toLowerCase() !== 'node.exe' || !Number.isFinite(Date.parse(record.born)) || Date.parse(record.born) > modified) return null;
  const command = (record.command || '').replace(/\//g, '\\').toLowerCase();
  const script = path.join(profile.root, 'scripts', 'launch.mjs').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)"?(?:${script}|scripts\\\\launch\\.mjs)"?(?=\\s|$)`).test(command) ? record : null;
}

export async function checkXhsRuntime(profile, { request = fetch, timeoutMs = 1500, records = [], business = [], recordError, listeners = [], portError } = {}) {
  const status = (state, label, detail, blocked = false, reason = '') => ({ state, label, detail, blocked, reason });
  const lockRead = (async () => {
    try {
      const { text, modified } = await smallFile(profile.lockFile);
      const lock = JSON.parse(text);
      if (!Number.isInteger(lock.pid) || lock.pid <= 0 || lock.workspace !== profile.workspace ||
          (lock.port !== null && !profile.ports.includes(lock.port))) throw new Error('状态文件与此项目不匹配。');
      return { lock, modified };
    } catch (error) { return error.code === 'ENOENT' ? {} : { error: error.message }; }
  })();
  const [lockState, probes] = await Promise.all([lockRead, Promise.all(profile.ports.map(port => healthProbe(profile, port, request, timeoutMs)))]);
  const match = probes.find(p => p.match);
  if (match) return status('running', '运行中', `已核验小红书服务及此项目目录的身份：${match.url}`);
  if (lockState.error) return status('unknown', '状态文件异常', `无法确认启动状态：${lockState.error}`, true, '原启动器的状态文件无法确认，请检查原终端提示后再启动。');
  const owner = lockState.lock && lockOwner(profile, lockState.lock, lockState.modified, records);
  if (owner && lockState.lock.port === null) return status('unknown', '启动中', '原启动器正在准备依赖、构建或等待服务就绪。', true, '原启动器仍在准备项目，请等待就绪或在原终端中关闭。');
  if (owner || business.length) return status('running', '运行中 · 未就绪', '检测到此项目的启动或业务进程，健康接口暂未就绪。');
  if (recordError) return status('unknown', '进程检查失败', '健康接口未确认运行，且无法读取进程状态。', true, '无法确认原启动器是否仍在运行，请恢复进程检查后重试。');
  const allOccupied = profile.ports.every(port => probes.some(p => p.port === port && p.received) || listeners.some(l => l.port === port && ['127.0.0.1', '0.0.0.0', '::'].includes(l.address)));
  if (probes.some(p => p.uncertain)) return status('unknown', probes.some(p => p.timeout) ? '检查超时' : '服务检查异常',
    '未检测到此项目进程，但候选端口的健康检查尚未完成；请稍后刷新。', true, '服务身份尚未核验，请稍后刷新状态。');
  if (portError) return status('unknown', '端口检查失败', '健康接口未确认运行，且无法读取端口状态。', true, '无法确认候选端口是否可用，请恢复端口检查后重试。');
  return status('offline', '未运行', '未检测到此项目的启动进程或匹配项目身份的本地服务；空终端与失效的启动记录不算运行。', allOccupied,
    allOccupied ? '3001–3010 端口均被其他服务占用，请先释放一个端口。' : '');
}
