import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPanelServer } from '../src/panel.mjs';
import { tempDir } from './helpers.mjs';

test('a relocated plugin loads over STDIO, returns its UI and calls shared local service tools', async t => {
  const dir = await tempDir(t), relocated = path.join(dir, 'installed plugin'), dataDir = path.join(dir, 'data');
  await cp('plugins/start-buttons', relocated, { recursive: true });
  const launched = [];
  let blockChecks = false;
  const panel = await createPanelServer({ dataDir, port: 0, template: '<script>/*START_BUTTONS_CONFIG*/</script>',
    checkStatuses: async projects => {
      assert.equal(blockChecks, false, 'Opening the dashboard must not wait for process or port probes.');
      return Object.fromEntries(projects.map(p => [p.id, { state: 'unknown', canLaunch: true }]));
    }, launch: async p => { launched.push(p); return { accepted: true }; } });
  t.after(() => panel.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(relocated, 'dist/mcp.mjs')], env: { ...process.env, START_BUTTONS_DATA_DIR: dataDir }, stderr: 'pipe' });
  const client = new Client({ name: 'start-buttons-test', version: '1.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const sidebarSvg = await readFile(path.join(relocated, 'assets', 'sidebar-icon.svg'), 'utf8');
  const sidebarIcons = [{ src: 'data:image/svg+xml;base64,' + Buffer.from(sidebarSvg).toString('base64'), mimeType: 'image/svg+xml', sizes: ['any'] }];
  assert.match(sidebarSvg, /viewBox="0 0 20 20"/);
  assert.match(sidebarSvg, /currentColor/);
  assert.doesNotMatch(sidebarSvg, /<script|<foreignObject|\b(?:href|src)=|#[0-9a-f]{3,8}/i);
  assert.deepEqual(client.getServerVersion().icons, sidebarIcons, 'The local MCP server supplies a relocatable sidebar fallback icon.');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 7);
  for (const name of ['stop_shortcut', 'restart_shortcut']) {
    const tool = tools.find(t => t.name === name);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
  }
  const open = tools.find(t => t.name === 'open_dashboard');
  const manifest = JSON.parse(await readFile(path.join(relocated, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(open.title, '打开项目启动台');
  assert.deepEqual(open.icons, sidebarIcons, 'tools/list must include the entrypoint icon, even with the older SDK.');
  const currentUri = `ui://start-buttons/panel-${manifest.version}.html`;
  assert.equal(open._meta.ui.resourceUri, currentUri, 'A release must not reuse the global app resource cache key.');
  assert.equal(client.getServerVersion().version, manifest.version);
  assert.equal(client.getServerVersion().title, 'Codex Project Launcher');
  assert.deepEqual((await client.listResources()).resources.map(r => r.uri), [currentUri]);
  assert.equal(open._meta['openai/ui'].entrypoints[0].type, 'global');
  const resource = await client.readResource({ uri: open._meta.ui.resourceUri });
  assert.equal(resource.contents[0].uri, currentUri);
  await assert.rejects(client.readResource({ uri: 'ui://start-buttons/panel-v1.html' }), /Resource.*not found/i,
    'The old unversioned resource must not silently serve another release.');
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.contents[0].text, /"mode":"mcp"/);
  assert.doesNotMatch(resource.contents[0].text, /START_BUTTONS_(CONFIG|CSS|JS)\*\//);
  assert.doesNotMatch(resource.contents[0].text, /PROJECT_DOCK_ICON\*\//);
  assert.match(resource.contents[0].text, /<title>项目启动台<\/title>/);
  assert.equal(manifest.interface.displayName, 'Codex Project Launcher');
  for (const field of ['logo', 'logoDark', 'composerIcon', 'composerIconDark']) {
    const relative = manifest.interface[field];
    assert.ok(relative.startsWith('./assets/') && !relative.includes('..'));
    const svg = await readFile(path.join(relocated, relative), 'utf8');
    assert.match(svg, /viewBox="0 0 96 96"/);
    assert.doesNotMatch(svg, /<script|<foreignObject|\b(?:href|src)=/i);
    assert.ok(resource.contents[0].text.includes('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')), 'The relocated UI uses the same bundled icon without fetching outside assets.');
  }
  const saved = await client.callTool({ name: 'save_shortcut', arguments: { name: 'MCP test', type: 'command', command: 'original', cwd: dataDir } });
  assert.equal(saved.isError, undefined);
  blockChecks = true;
  const dashboard = await client.callTool({ name: 'open_dashboard', arguments: {} });
  assert.equal(dashboard.structuredContent.projects.length, 1);
  assert.equal(dashboard.structuredContent.url, panel.info.url);
  assert.equal(dashboard.structuredContent.statuses, undefined);
  const seededResource = await client.readResource({ uri: currentUri });
  const config = JSON.parse(seededResource.contents[0].text.match(/window.START_BUTTONS_CONFIG = (.*);<\/script>/)[1]);
  assert.equal(config.initialData.projects[0].id, saved.structuredContent.project.id);
  blockChecks = false;
  const ack = await client.callTool({ name: 'launch_shortcut', arguments: { id: saved.structuredContent.project.id } });
  assert.equal(ack.structuredContent.accepted, true);
  assert.equal(launched.length, 1);
  const missing = await client.callTool({ name: 'launch_shortcut', arguments: { id: 'unknown' } });
  assert.equal(missing.isError, true);
  assert.equal(launched.length, 1);
});
