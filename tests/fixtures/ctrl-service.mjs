import http from 'node:http';
import fs from 'node:fs';

const server = http.createServer((req, res) => {
  res.end('ctrl-c-demo');
  if (req.url === '/stop-fixture') {
    fs.writeFileSync('ctrl-received.json', JSON.stringify({ signal: 'stop-command', pid: process.pid }));
    server.close(() => process.exit(0));
  }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync('ctrl-ready.json', JSON.stringify({ pid: process.pid, port: server.address().port, stdinIsTTY: Boolean(process.stdin.isTTY) })));
process.once('SIGINT', () => {
  fs.writeFileSync('ctrl-received.json', JSON.stringify({ signal: 'SIGINT', pid: process.pid }));
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
