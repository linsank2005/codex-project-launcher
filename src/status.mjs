import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeHealthUrl } from './store.mjs';
import { windowsPowerShellPath } from './powershell.mjs';
import { discoverXhsCheck, checkXhsRuntime } from './xhs-status.mjs';
import { validIdentity } from './launch-journal.mjs';

const run = promisify(execFile);
const executableKey = value => path.resolve(value).toLowerCase();
let processProbe;
async function processSnapshot() {
  if (process.platform !== 'win32') throw new Error('当前系统无法检查 Windows 进程。');
  if (processProbe) return processProbe;
  processProbe = (async () => {
    const code = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $session=(Get-Process -Id $PID).SessionId; $records=@(Get-CimInstance Win32_Process -Filter ('SessionId=' + $session) | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $born=if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {$null}; @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; name=$_.Name; exe=$_.ExecutablePath; command=$_.CommandLine; born=$born } }); ConvertTo-Json -InputObject $records -Compress";
    const { stdout } = await run(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 6000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    });
    const records = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!Array.isArray(records)) throw new Error('无法读取进程状态。');
    return records;
  })();
  try { return await processProbe; } finally { processProbe = undefined; }
}
export async function runningExecutablePaths() {
  return new Set((await processSnapshot()).filter(p => typeof p.exe === 'string' && p.exe).map(p => executableKey(p.exe)));
}
const wrappers = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'openconsole.exe', 'windowsterminal.exe', 'wt.exe']);
const scriptEntry = p => p.type === 'file' && ['.ps1', '.cmd', '.bat'].includes(path.extname(p.path || '').toLowerCase());
const exeEntry = p => p.type === 'file' && path.extname(p.path || '').toLowerCase() === '.exe';
export function launchKey(project) {
  return createHash('sha256').update(JSON.stringify([project.type, project.path, project.command, project.cwd])).digest('hex');
}
export function latestLaunch(project, launches = {}) {
  const key = launchKey(project);
  return Object.values(launches).filter(r => r.accepted && r.entryKey === key)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}
function startupRoots(project, records) {
  const entry = executableKey(project.path), ext = path.extname(entry), escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return records.filter(record => {
    const name = (record.name || '').toLowerCase(), command = (record.command || '').replace(/\//g, '\\').toLowerCase();
    if (ext === '.ps1') return ['powershell.exe', 'pwsh.exe'].includes(name) && new RegExp(`\\s-file\\s+"?${escaped}(?=["\\s]|$)`).test(command);
    if (name !== 'cmd.exe') return false;
    const tail = command.match(/\s\\[ck]\s*(.*)$/)?.[1]?.replace(/^"+/, '');
    return tail?.startsWith(entry) && (!tail[entry.length] || /["\s]/.test(tail[entry.length]));
  });
}
function ownedProcesses(project, records, launch) {
  const roots = scriptEntry(project) ? startupRoots(project, records) : exeEntry(project)
    ? records.filter(r => r.exe && executableKey(r.exe) === executableKey(project.path)) : [];
  if (launch?.pid && launch.startedAt) {
    const root = records.find(r => r.pid === launch.pid && Number.isFinite(Date.parse(r.born)) && Date.parse(r.born) === Date.parse(launch.startedAt));
    if (root && !roots.some(r => r.pid === root.pid)) roots.push(root);
  }
  const anchors = (launch?.processes || []).filter(validIdentity).flatMap(identity =>
    records.filter(r => r.pid === identity.pid && Date.parse(r.born) === Date.parse(identity.born)));
  const visited = new Set(), queue = [...roots, ...anchors], owned = [];
  while (queue.length) {
    const parent = queue.shift();
    if (visited.has(parent.pid)) continue;
    visited.add(parent.pid);
    owned.push(parent);
    for (const child of records.filter(p => p.parent === parent.pid && Date.parse(p.born) >= Date.parse(parent.born))) {
      queue.push(child);
    }
  }
  const business = owned.filter(p => !wrappers.has((p.name || '').toLowerCase()));
  // A restart may leave the old shell open. Only roots still hosting business
  // processes can receive a stop request; an idle shell is not another service.
  const activeRoots = business.length ? roots.filter(root => {
    const descendants = new Set(), pending = [root];
    while (pending.length) {
      const parent = pending.shift();
      if (descendants.has(parent.pid)) continue;
      descendants.add(parent.pid);
      pending.push(...owned.filter(p => p.parent === parent.pid && Date.parse(p.born) >= Date.parse(parent.born)));
    }
    return business.some(p => descendants.has(p.pid));
  }) : roots;
  return { roots: activeRoots, owned, business };
}
export async function inspectProjectProcesses(project, { launches = {}, startupProcesses = processSnapshot } = {}) {
  const records = await startupProcesses();
  return { ...ownedProcesses(project, records, latestLaunch(project, launches)), records };
}
export function statusFromStartupProcesses(project, records) {
  const { roots, business } = ownedProcesses({ ...project, type: 'file' }, records);
  return business.length
    ? { state: 'running', label: '运行中', detail: '原启动入口下有正在运行的业务子进程；此检查仅确认进程存在。' }
    : { state: 'unknown', label: '待确认', detail: roots.length ? '启动窗口仍在，未检测到业务子进程。可填写本地服务地址进一步确认。' : '未检测到原入口的业务子进程。可填写本地服务地址进一步确认。' };
}

const listenerProbes = new Map();
export async function listeningPorts(ports) {
  if (process.platform !== 'win32') throw new Error('当前系统无法检查 Windows 监听端口。');
  const key = [...new Set(ports)].sort((a, b) => a - b).join(',');
  if (!key || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) return [];
  if (listenerProbes.has(key)) return listenerProbes.get(key);
  const probe = (async () => {
    const code = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $ports=@(${key}); $records=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in $ports } | ForEach-Object { @{ pid=[int]$_.OwningProcess; port=[int]$_.LocalPort; address=$_.LocalAddress } }); ConvertTo-Json -InputObject $records -Compress`;
    const { stdout } = await run(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 6000, maxBuffer: 256 * 1024, encoding: 'utf8',
    });
    const records = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!Array.isArray(records)) throw new Error('无法读取监听端口。');
    return records;
  })();
  listenerProbes.set(key, probe);
  try { return await probe; } finally { listenerProbes.delete(key); }
}
function matchesAddress(listener, url) {
  if (listener.port !== Number(url.port || 80)) return false;
  const addresses = url.hostname === '[::1]' ? ['::1', '::'] : url.hostname === 'localhost'
    ? ['127.0.0.1', '0.0.0.0', '::1', '::'] : ['127.0.0.1', '0.0.0.0', '::'];
  return addresses.includes(listener.address);
}
export async function checkProjectStatuses(projects, { request = fetch, executablePaths = runningExecutablePaths, startupProcesses = processSnapshot, portOwners = listeningPorts, launches = {}, timeoutMs = 1500 } = {}) {
  const checkedAt = new Date().toISOString();
  const xhsChecks = new Map((await Promise.all(projects.map(async p => [p.id, await discoverXhsCheck(p)]))).filter(([, check]) => check));
  const executables = projects.filter(p => !p.healthUrl && exeEntry(p));
  const needRecords = projects.some(p => scriptEntry(p) || (p.healthUrl && exeEntry(p)) || p.stopCommand ||
    latestLaunch(p, launches)?.startedAt || latestLaunch(p, launches)?.processes?.length);
  const urls = new Map();
  for (const p of projects) if (p.healthUrl) {
    try { urls.set(p.id, new URL(normalizeHealthUrl(p.healthUrl))); } catch { /* Invalid checks are reported per project below. */ }
  }
  let paths, records = [], listeners = [], processError, recordError, portError;
  await Promise.all([
    executables.length ? executablePaths().then(value => { paths = value; }, error => { processError = error.message; }) : undefined,
    needRecords ? startupProcesses().then(value => { records = value; }, error => { recordError = error.message; }) : undefined,
    urls.size || xhsChecks.size ? portOwners([...urls.values()].map(u => Number(u.port || 80)).concat([...xhsChecks.values()].flatMap(c => c.ports))).then(value => { listeners = value; }, error => { portError = error.message; }) : undefined,
  ]);
  const results = await Promise.all(projects.map(async project => {
    const launch = latestLaunch(project, launches);
    const { roots, owned, business } = ownedProcesses(project, records, launch);
    const starting = launch?.startedAt && !launch.settled && Date.now() - Date.parse(launch.at) < 10000 && (roots.length || recordError);
    const result = (state, label, detail, method, occupied = false, reasonOverride = '') => {
      const blocked = state === 'running' || occupied || Boolean(starting);
      const reason = reasonOverride || (state === 'running' ? '项目已在运行，请先正常停止，再重新启动。'
        : occupied ? '运行检查地址已有服务响应或端口已占用。请先关闭原服务，或检查此项目的服务地址。'
          : starting ? '此入口刚刚发起启动，请稍候再检查状态。' : '');
      const consoleRoot = roots.length === 1 && (scriptEntry(project) || project.type === 'command' ||
        ['cmd.exe', 'pwsh.exe', 'powershell.exe', 'node.exe', 'python.exe'].includes((roots[0].name || '').toLowerCase()));
      const canStop = state === 'running' && !recordError && business.length > 0 && owned.every(validIdentity) &&
        (Boolean(project.stopCommand) || consoleRoot);
      const stopReason = canStop ? '' : state !== 'running' ? '尚未核验此项目正在运行，请先查看状态原因。'
        : recordError ? '进程检查不可用，无法确认停止目标。' : '无法确定独立的启动终端，可在编辑中填写原项目的停止命令，或在原窗口退出。';
      return [project.id, { state, label, detail, method, checkedAt, canLaunch: !blocked, launchBlockReason: reason,
        canStop, canRestart: canStop, stopReason,
        ...(launch && !recordError ? { observedProcesses: owned.filter(validIdentity).map(p => ({ pid: p.pid, born: p.born })).slice(0, 256) } : {}),
      }];
    };
    if (xhsChecks.has(project.id)) {
      const status = await checkXhsRuntime(xhsChecks.get(project.id), { request, timeoutMs, records, business, recordError, listeners, portError });
      return result(status.state, status.label, status.detail, 'launcher', status.blocked, status.reason);
    }
    if (project.healthUrl) {
      let url;
      try { url = normalizeHealthUrl(project.healthUrl); }
      catch (error) { return result('unknown', '检查配置', error.message, 'http'); }
      const parsed = new URL(url);
      let owners = listeners.filter(l => matchesAddress(l, parsed));
      // Prefer IPv4 listeners for an explicit IPv4 URL. A v6-only socket on the
      // same port must not be mistaken for the server that answered IPv4.
      if (parsed.hostname === '127.0.0.1' && owners.some(l => l.address !== '::')) owners = owners.filter(l => l.address !== '::');
      const verifiedOwner = owners.length > 0 && owners.every(l => business.some(p => p.pid === l.pid));
      const occupied = owners.length > 0;
      try {
        const response = await request(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', cache: 'no-store' });
        await response.body?.cancel();
        if (verifiedOwner) return result('running', response.ok ? '运行中' : '运行中 · 未就绪', `已核验响应端口属于此入口；HTTP ${response.status}：${url}`, 'http');
        return result('unknown', response.ok ? '地址可访问 · 待确认' : '地址未就绪 · 待确认',
          `HTTP ${response.status}，尚不能确认该地址属于此项目${recordError || portError ? '（进程或端口检查不可用）' : ''}：${url}`, 'http', true);
      } catch (error) {
        if (business.length) return result('running', '进程运行中 · 未就绪', `检测到此入口的业务进程，服务地址暂不可访问：${url}`, 'process', occupied);
        if (error.name === 'TimeoutError' || error.name === 'AbortError') return result('unknown', '检查超时', `暂时无法确认服务状态：${url}`, 'http', occupied);
        return result('offline', '未连接', `本地服务暂不可访问：${url}`, 'http', occupied);
      }
    }
    if (executables.includes(project)) {
      if (processError) return result('unknown', '待确认', processError, 'process');
      return paths.has(executableKey(project.path))
        ? result('running', '运行中', '检测到该 EXE 的进程，未检查程序内部功能。', 'process')
        : result('offline', '未运行', '当前未检测到该 EXE 的进程。', 'process');
    }
    if (scriptEntry(project) || launch?.startedAt || launch?.processes?.length || launch?.stoppedAt || launch?.settled) {
      if (recordError) return result('unknown', starting ? '启动中' : '待确认', recordError, 'process');
      if (business.length) return result('running', '运行中', '检测到此入口的业务进程；进程存在不证明内部业务健康。', 'process');
      if (launch?.settled || launch?.stoppedAt) return result('offline', '未运行', '已核验的业务进程已经退出；保留的空终端不算运行。', 'process');
      return result('unknown', starting ? '启动中' : '待确认', roots.length ? '启动窗口仍在，未检测到业务进程。' : '未检测到此入口的业务进程。', 'process');
    }
    return result('unknown', '待确认', '编辑项目并填写本地运行检查地址，即可自动显示服务状态。', 'none');
  }));
  return Object.fromEntries(results);
}
