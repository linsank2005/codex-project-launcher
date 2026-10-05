import http from 'node:http';
const index = process.argv.indexOf('--port');
const port = index < 0 ? 0 : Number(process.argv[index + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid test port.');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ app: 'start-buttons-status-demo', status: 'ok' }));
});
server.listen(port, '127.0.0.1', () => console.log(`Status demo: http://127.0.0.1:${server.address().port}/health`));
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
