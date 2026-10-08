import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsPowerShellPath, resolvePowerShell } from './powershell.mjs';
import { inspectProjectProcesses, launchKey } from './status.mjs';
import { validIdentity } from './launch-journal.mjs';

const run = promisify(execFile);
export async function sendConsoleStop(targetPid, processes, options = {}) {
  const payload = Buffer.from(JSON.stringify({ targetPid, processes, ...options }), 'utf8').toString('base64');
  const { stdout } = await run(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./stop-console.ps1', import.meta.url)), '-Payload', payload],
  { windowsHide: true, timeout: 12000, maxBuffer: 512 * 1024, encoding: 'utf8' });
  const reply = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (!reply.sent) throw new Error(reply.message || '未能发送停止请求。');
  return reply;
}
async function runStopCommand(project) {
  const shell = await resolvePowerShell();
  const cwd = project.cwd || path.dirname(project.path);
  const payload = Buffer.from(JSON.stringify({ cwd, command: project.stopCommand }), 'utf8').toString('base64');
  const code = `$ErrorActionPreference='Stop'; $entry=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json; Set-Location -LiteralPath $entry.cwd; & ([scriptblock]::Create($entry.command)); if ($LASTEXITCODE) { exit $LASTEXITCODE }`;
  await run(shell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 12000, maxBuffer: 512 * 1024 });
}
export async function stopProject(project, { launches = {}, inspect = inspectProjectProcesses, signal = sendConsoleStop,
  command = runStopCommand, confirmation, answer, timeoutMs = 15000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let expected, targetPid, reply;
  if (confirmation) {
    if (typeof answer !== 'boolean') throw new Error('关闭确认必须选择是或否。');
    ({ processes: expected, targetPid } = confirmation);
    reply = await signal(targetPid, expected, { action: 'answer', prompt: confirmation.prompt, position: confirmation.position, answer });
  } else {
    const before = await inspect(project, { launches });
    if (!before.business.length || before.owned.some(p => !validIdentity(p))) throw new Error('无法核验此项目的业务进程，未执行停止。请先刷新状态。');
    expected = before.owned.map(p => ({ pid: p.pid, born: p.born }));
    if (project.stopCommand) await command(project);
    else {
      if (before.roots.length !== 1) throw new Error('存在多个或缺失的启动终端，无法确定停止目标。可填写原项目的停止命令。');
      targetPid = before.roots[0].pid;
      reply = await signal(targetPid, expected);
    }
  }
  const pending = result => ({ stopped: false, confirmation: { ...result, targetPid, processes: expected } });
  if (reply?.confirmation) return pending(reply.confirmation);
  const deadline = Date.now() + timeoutMs;
  const key = launchKey(project);
  const tracked = { ...Object.fromEntries(Object.entries(launches).filter(([, receipt]) => receipt.entryKey !== key)),
    __stop_observation: { accepted: true, entryKey: key,
    at: new Date().toISOString(), processes: expected } };
  do {
    const after = await inspect(project, { launches: tracked });
    if (confirmation && !answer) return { cancelled: true, stopped: !after.business.length, message: '已选择否；后续状态按实际进程更新，未重新启动。' };
    if (!after.business.length) {
      if (reply?.mayConfirm && after.owned.some(p => p.pid === targetPid && Date.parse(p.born) === Date.parse(expected.find(e => e.pid === targetPid)?.born))) {
        const read = await signal(targetPid, expected, { action: 'read' });
        if (read.confirmation) return pending(read.confirmation);
      }
      return { stopped: true, message: '项目业务进程已退出。' };
    }
    if (Date.now() >= deadline) break;
    await pause(350);
  } while (Date.now() < deadline);
  throw new Error('已请求正常退出，但业务进程仍在运行。未强制结束，也未重新启动。请在原窗口查看原因。');
}
