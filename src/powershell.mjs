import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const envValue = (env, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

export async function resolvePowerShell(env = process.env) {
  const candidates = (envValue(env, 'PATH') || '').split(path.delimiter)
    .map(dir => dir.replace(/^"|"$/g, '')).filter(dir => path.isAbsolute(dir))
    .map(dir => path.join(dir, 'pwsh.exe'));
  for (const name of ['ProgramFiles', 'ProgramW6432']) {
    const dir = envValue(env, name);
    if (dir) candidates.push(path.join(dir, 'PowerShell', '7', 'pwsh.exe'));
  }
  const local = envValue(env, 'LOCALAPPDATA'), profile = envValue(env, 'USERPROFILE');
  if (local) candidates.push(path.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  if (profile) candidates.push(path.join(profile, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'));
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      const { stdout } = await run(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Write($PSVersionTable.PSVersion.ToString())'], {
        windowsHide: true, timeout: 3000, encoding: 'utf8', env,
      });
      const version = stdout.trim();
      if (/^\d+\.\d+\./.test(version) && Number(version.split('.')[0]) >= 7) return { path: candidate, version };
    } catch { /* A missing executable or unusable app alias is not a PowerShell 7 runtime. */ }
  }
  throw new Error('未找到可用的 PowerShell 7。请安装 PowerShell 7 并重新打开面板；不能用 Windows PowerShell 5.1 执行这些脚本。');
}

export function windowsPowerShellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
