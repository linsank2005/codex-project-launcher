import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const validIdentity = p => p && Number.isInteger(p.pid) && p.pid > 0 && Number.isFinite(Date.parse(p.born));
export class LaunchJournal {
  constructor(dataDir) { this.file = path.join(dataDir, 'launches.json'); this.records = new Map(); this.queue = Promise.resolve(); }
  async load() {
    let data;
    try { data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('启动记录损坏，原文件已保留。请备份后修复 launches.json。'); }
    const entries = data && typeof data.records === 'object' && !Array.isArray(data.records) && data.records ? Object.entries(data.records) : [];
    if (data?.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records) || entries.length > 200 || entries.some(([id, r]) =>
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !r || !/^[a-f0-9]{64}$/.test(r.entryKey) || !Number.isFinite(Date.parse(r.at)) ||
      (r.processes !== undefined && (!Array.isArray(r.processes) || r.processes.length > 256 || r.processes.some(p => !validIdentity(p)))))) {
      throw new Error('启动记录格式不正确，原文件已保留。请备份后修复 launches.json。');
    }
    this.records = new Map(entries.map(([id, r]) => [id, {
      entryKey: r.entryKey, at: r.at, accepted: r.accepted === true, settled: r.settled === true,
      ...(validIdentity({ pid: r.pid, born: r.startedAt }) ? { pid: r.pid, startedAt: r.startedAt } : {}),
      message: typeof r.message === 'string' ? r.message.slice(0, 2000) : '', error: r.error === true,
      ...(Number.isFinite(Date.parse(r.stoppedAt)) ? { stoppedAt: r.stoppedAt } : {}),
      processes: (r.processes || []).map(p => ({ pid: p.pid, born: p.born })),
    }]));
  }
  save() {
    const job = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, records: Object.fromEntries(this.records) }, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, this.file);
      } finally { await unlink(temp).catch(() => {}); }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
