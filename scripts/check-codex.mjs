import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { VERSION } from '../src/version.mjs';

const child = spawn('codex.exe', ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let id = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const request = pending.get(message.id);
  if (request && !message.method) {
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
child.stderr.on('data', () => {});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out.`)); }, 25000);
    pending.set(next, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: next, method, params }) + '\n');
  });
}
try {
  const initialized = await rpc('initialize', { clientInfo: { name: 'start-buttons-test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  console.log(JSON.stringify({ initialized }, null, 2));
  const response = await rpc('mcpServerStatus/list', { detail: 'full', limit: 100 });
  const own = (response.data || []).filter(server => server.pluginId === 'start-buttons@start-buttons-local' || /start.buttons/.test(server.name));
  if (own.length !== 1) throw new Error('Start Buttons was not found in the Codex MCP inventory.');
  if (own[0].toolsError) throw new Error(own[0].toolsError);
  if (Object.keys(own[0].tools || {}).length !== 7) throw new Error('Codex did not load all seven Start Buttons tools.');
  const currentUri = `ui://start-buttons/panel-${VERSION}.html`;
  if (own[0].serverInfo?.version !== VERSION) throw new Error('Codex loaded a different plugin version.');
  if (own[0].tools.open_dashboard._meta?.ui?.resourceUri !== currentUri || !own[0].resources?.some(resource => resource.uri === currentUri)) {
    throw new Error('Codex did not load the current versioned UI resource.');
  }
  console.log(JSON.stringify({ pluginId: own[0].pluginId, serverInfo: own[0].serverInfo, tools: Object.keys(own[0].tools), resources: own[0].resources, entrypoints: own[0].tools.open_dashboard._meta['openai/ui'].entrypoints }, null, 2));
  console.log('PASS: Codex loaded the installed plugin server, seven tools and its UI resource. Native sidebar rendering has not been evaluated.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { child.stdin.end(); child.kill(); lines.close(); for (const request of pending.values()) clearTimeout(request.timer); }
