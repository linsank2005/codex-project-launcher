import { mkdir, readFile, rename, writeFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const supportedFiles = new Set(['.ps1', '.cmd', '.bat', '.lnk', '.exe', '.url']);
export function getDataDir() {
  return path.resolve(process.env.START_BUTTONS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'StartButtons'));
}
function clean(value, field, max, required = false) {
  if (typeof value !== 'string' && value !== undefined) throw new Error(`${field}必须是文本。`);
  const text = (value || '').trim();
  if ((required && !text) || text.length > max || text.includes('\0')) throw new Error(`请检查${field}。`);
  return text;
}
function unquote(value) {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
export function normalizeHealthUrl(value) {
  const text = clean(value, '运行检查地址', 2048);
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('请填写完整的本地运行检查地址，例如 http://127.0.0.1:3000/。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) {
    throw new Error('运行检查仅支持本机 http 地址：127.0.0.1、localhost 或 [::1]。');
  }
  return url.href;
}
export async function validateProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('快捷入口格式不正确。');
  const type = input.type || 'file';
  if (!['file', 'command'].includes(type)) throw new Error('启动方式不正确。');
  const project = {
    id: clean(input.id, 'ID', 64) || randomUUID(),
    name: clean(input.name, '项目名称', 80, true),
    icon: clean(input.icon, '图标', 24) || '🚀',
    type,
    path: unquote(clean(input.path, '入口路径', 2048)),
    command: clean(input.command, '启动命令', 8000),
    cwd: unquote(clean(input.cwd, '项目目录', 2048)),
    healthUrl: normalizeHealthUrl(input.healthUrl),
    stopCommand: clean(input.stopCommand, '停止命令', 8000),
  };
  if (!/^[a-zA-Z0-9_-]+$/.test(project.id)) throw new Error('快捷入口 ID 不正确。');
  if (type === 'file') {
    if (!path.isAbsolute(project.path)) throw new Error('请填写入口文件的完整路径。');
    if (!supportedFiles.has(path.extname(project.path).toLowerCase())) throw new Error('入口支持 .ps1、.cmd、.bat、.lnk、.exe 和 .url。');
    if (!(await stat(project.path).catch(() => null))?.isFile()) throw new Error('入口文件不存在，请检查路径。');
    project.command = '';
  } else {
    if (!project.command) throw new Error('请填写原来使用的 PowerShell 启动命令。');
    if (!project.cwd) throw new Error('命令启动需要填写项目目录。');
    project.path = '';
  }
  if (project.cwd && (!path.isAbsolute(project.cwd) || !(await stat(project.cwd).catch(() => null))?.isDirectory())) {
    throw new Error('项目目录不存在或不是完整路径。');
  }
  return project;
}
export class ProjectStore {
  constructor(dataDir = getDataDir()) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'projects.json');
    this.queue = Promise.resolve();
  }
  async list() {
    let text;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('项目配置文件损坏，请先修复或恢复 projects.json。'); }
    if (data.version !== 1 || !Array.isArray(data.projects) || data.projects.length > 200 ||
        data.projects.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || !['file', 'command'].includes(p.type)) ||
        new Set(data.projects.map(p => p.id)).size !== data.projects.length) {
      throw new Error('项目配置文件格式不正确，原文件已保留。');
    }
    return data.projects;
  }
  transact(action) {
    const result = this.queue.then(async () => {
      const projects = await this.list();
      const result = await action(projects);
      await mkdir(this.dataDir, { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, projects }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.file);
      } finally { await unlink(temp).catch(() => {}); }
      return result;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async save(input) {
    const project = await validateProject(input);
    return this.transact(projects => {
      const index = projects.findIndex(p => p.id === project.id);
      if (index >= 0) {
        if (input.healthUrl === undefined) project.healthUrl = projects[index].healthUrl || '';
        if (input.stopCommand === undefined) project.stopCommand = projects[index].stopCommand || '';
        projects[index] = project;
      }
      else {
        if (projects.length >= 200) throw new Error('最多保存 200 个快捷入口。');
        projects.push(project);
      }
      return project;
    });
  }
  async remove(id) {
    return this.transact(projects => {
      const index = projects.findIndex(p => p.id === id);
      if (index < 0) throw new Error('快捷入口不存在。');
      projects.splice(index, 1);
      return { removed: id };
    });
  }
  async get(id) {
    const project = (await this.list()).find(p => p.id === id);
    if (!project) throw new Error('快捷入口不存在，请刷新面板。');
    return validateProject(project);
  }
}
