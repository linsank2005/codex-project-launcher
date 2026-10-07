import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { windowsPowerShellPath } from '../src/powershell.mjs';
import { createPanelServer } from '../src/panel.mjs';
import { VERSION } from '../src/version.mjs';
import { tempDir } from './helpers.mjs';

const native = { skip: process.platform !== 'win32', timeout: 25000 };
test('marketplace manifest starts a relocated plugin and preserves Unicode over the PowerShell STDIO bridge', native, async t => {
  let client, panel;
  t.after(async () => { await client?.close(); await panel?.close(); });
  const dir = await tempDir(t), plugin = path.join(dir, '插件 cache'), dataDir = path.join(dir, 'data');
  await cp('plugins/start-buttons', plugin, { recursive: true });
  const config = JSON.parse(await readFile(path.join(plugin, '.mcp.json'), 'utf8')).mcpServers.start_buttons;
  const env = { ...process.env, START_BUTTONS_DATA_DIR: dataDir };
  panel = await createPanelServer({ dataDir, port: 0, template: '' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: path.resolve(plugin, config.cwd), env, stderr: 'pipe' });
  client = new Client({ name: 'marketplace-manifest-test', version: '1.0' });
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, VERSION);
  assert.equal((await client.listTools()).tools.length, 7);
  const result = await client.callTool({ name: 'save_shortcut', arguments: { name: '中文市场 🚀', icon: '🎨', type: 'command', command: 'original', cwd: dir } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.project.name, '中文市场 🚀');
  assert.equal(result.structuredContent.project.icon, '🎨');
});

test('bootstrap uses a bundled Node runtime even when PATH has no Node entry', native, async t => {
  let client;
  t.after(async () => { await client?.close(); });
  const dir = await tempDir(t), plugin = path.join(dir, 'cache'), profile = path.join(dir, 'profile');
  await cp('plugins/start-buttons', plugin, { recursive: true });
  const bundled = path.join(profile, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe');
  await mkdir(path.dirname(bundled), { recursive: true }); await cp(process.execPath, bundled);
  const config = JSON.parse(await readFile(path.join(plugin, '.mcp.json'), 'utf8')).mcpServers.start_buttons;
  client = new Client({ name: 'bundled-runtime-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: windowsPowerShellPath(), args: config.args, cwd: plugin,
    env: { ...process.env, PATH: '', Path: '', USERPROFILE: profile, ProgramFiles: '', ProgramW6432: '', LOCALAPPDATA: dir }, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 7);
});

test('missing Node produces a clear install instruction without contaminating MCP stdout', native, async t => {
  const dir = await tempDir(t);
  await assert.rejects(promisify(execFile)(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-File', path.resolve('plugins/start-buttons/scripts/start-mcp.ps1')], {
    env: { ...process.env, PATH: '', Path: '', USERPROFILE: dir, ProgramFiles: '', ProgramW6432: '', LOCALAPPDATA: dir }, windowsHide: true, timeout: 10000,
  }), error => error.code === 1 && error.stdout === '' && /requires Node\.js 22\+/.test(error.stderr) && /nodejs\.org/.test(error.stderr));
});
