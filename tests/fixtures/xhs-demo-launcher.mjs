import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function launcherFingerprint(directory, dataDir = path.join(directory, 'data')) {
  return createHash('sha256').update(`${path.resolve(directory)}\n${path.resolve(dataDir)}`).digest('hex').slice(0, 32);
}
const workspace = launcherFingerprint(root), app = "xhs-cover-simulator";
const lockFile = path.join(root, 'data', 'launcher.lock');
await writeFile(lockFile, JSON.stringify({ pid: process.pid, port: null, workspace }));
await writeFile(path.join(root, 'launcher-preparing.json'), JSON.stringify({ pid: process.pid }));
while (!await readFile(path.join(root, 'continue-launch'), 'utf8').catch(() => false)) await new Promise(resolve => setTimeout(resolve, 50));

// Use the same contract and a real candidate port, without any business code,
// dependency install, build, browser opening or network outside this machine.
const ports = [];
for (let candidate = 3001; candidate <= 3010; candidate++) ports.push(candidate);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ app, workspace }));
});
let port;
for (const candidate of ports.reverse()) {
  const started = await new Promise((resolve, reject) => {
    const error = e => { server.removeListener('listening', ready); e.code === 'EADDRINUSE' ? resolve(false) : reject(e); };
    const ready = () => { server.removeListener('error', error); resolve(true); };
    server.once('error', error); server.once('listening', ready); server.listen(candidate, '127.0.0.1');
  });
  if (started) { port = candidate; break; }
}
if (!port) throw new Error('No free local fixture port in 3001–3010.');
await writeFile(lockFile, JSON.stringify({ pid: process.pid, port, workspace }));
await writeFile(path.join(root, 'launcher-ready.json'), JSON.stringify({ pid: process.pid, port, workspace }));
process.once('SIGINT', async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await unlink(lockFile);
  await writeFile(path.join(root, 'launcher-stopped.json'), JSON.stringify({ pid: process.pid, signal: 'SIGINT' }));
});
