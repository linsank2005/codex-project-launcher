import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolvePowerShell, windowsPowerShellPath } from './powershell.mjs';

export function helperPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'launch.ps1');
}
export async function launchProject(project, { windowStyle = 'Normal', keepOpen = true, helper = helperPath() } = {}) {
  if (process.platform !== 'win32') throw new Error('这个 MVP 的启动功能需要 Windows。');
  const requiresPowerShell = project.type === 'command' || path.extname(project.path || '').toLowerCase() === '.ps1';
  const shell = requiresPowerShell ? await resolvePowerShell() : { path: windowsPowerShellPath() };
  const payload = Buffer.from(JSON.stringify({ ...project, windowStyle, keepOpen, powershellPath: shell.path }), 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(shell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Payload', payload], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errorOutput = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows 启动入口超时，请检查文件关联或启动权限。')); }, 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { errorOutput += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(errorOutput.trim() || 'Windows 未能启动此入口。'));
      try { resolve({ ...JSON.parse(output.replace(/^\uFEFF/, '').trim()), ...(requiresPowerShell ? { powershell: shell } : {}), message: '已发起启动，请在原程序或终端中查看运行情况。' }); }
      catch { reject(new Error('无法读取 Windows 启动结果。')); }
    });
  });
}
export async function openBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('面板地址不正确。');
  const encoded = Buffer.from(`Start-Process -FilePath '${url}'`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('未能打开默认浏览器。')));
  });
}
