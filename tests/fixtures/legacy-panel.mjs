import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dataDir = process.env.START_BUTTONS_DATA_DIR;
const token = 'a'.repeat(64), version = process.env.FIXTURE_VERSION || '0.2.3';
const server = http.createServer(async (req, res) => {
  if (req.headers['x-start-buttons-token'] !== token) { res.writeHead(403); return res.end('{}'); }
  if (req.url === '/api/health') return res.end(JSON.stringify({ app: 'start-buttons', version, dataDir }));
  if (req.url === '/api/projects') {
    const projects = JSON.parse(await readFile(path.join(dataDir, 'projects.json'), 'utf8')).projects;
    return res.end(JSON.stringify({ projects, statuses: Object.fromEntries(projects.map(p => [p.id, { state: 'offline' }])) }));
  }
  res.writeHead(404); res.end('{}');
});
await mkdir(dataDir, { recursive: true });
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  await writeFile(path.join(dataDir, 'runtime.json'), JSON.stringify({ app: 'start-buttons', version, port, token, pid: process.pid, dataDir, url: `http://127.0.0.1:${port}/` }));
});
