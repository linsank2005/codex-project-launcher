import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelCall } from './runtime.mjs';
import { pageHtml } from './panel.mjs';
import { ProjectStore } from './store.mjs';
import { VERSION } from './version.mjs';

const entrypointIcons = [{ src: 'data:image/svg+xml;base64,' + (await readFile(new URL('../assets/sidebar-icon.svg', import.meta.url))).toString('base64'), mimeType: 'image/svg+xml', sizes: ['any'] }];
const server = new McpServer({ name: 'start-buttons', title: 'Codex Project Launcher', version: VERSION, icons: entrypointIcons }, {
  instructions: 'Codex Project Launcher is a Windows shortcut panel. Read saved entries and launch, stop or restart only the entry explicitly selected by the user. list_shortcuts returns per-project statuses and canLaunch/canStop/canRestart. HTTP accessibility alone does not prove project identity: running requires a verified listener owned by the saved entry or a supported local launcher health response matching the app and workspace identity. The supported XHS start-windows.cmd launcher is checked automatically across its dynamic ports and its lock file; an idle console or stale lock is not running. Unknown means identity could not be confirmed. Process checks do not prove business health. Launch associations are saved locally and revalidated by PID and creation time after panel restart. launch_shortcut rechecks status and rejects duplicate starts or an occupied configured service address. stop_shortcut verifies ownership before requesting normal exit. restart_shortcut waits for exit and rechecks status before starting; failed stops never trigger a second launch. Never rewrite existing startup files or force-kill projects. open_dashboard returns an MCP Apps UI and a local URL when the host does not render that UI.',
});
// The host retains global app resources by URI; a release must have a new key.
const uri = `ui://start-buttons/panel-${VERSION}.html`;
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
function result(data) { return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
function safe(handler) { return async args => { try { return result(await handler(args)); } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; } }; }
registerAppResource(server, 'start-buttons-panel', uri, {}, async () => ({ contents: [{
  uri, mimeType: RESOURCE_MIME_TYPE,
  text: pageHtml(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel.html'), 'utf8'),
    { mode: 'mcp', initialData: { projects: await new ProjectStore().list() } }),
  _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
}] }));
registerAppTool(server, 'open_dashboard', {
  title: '打开项目启动台', description: '显示所有已保存项目的快捷启动按钮。返回项目启动台及本地面板地址。', inputSchema: {}, annotations: readOnly,
  _meta: { ui: { resourceUri: uri }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
}, safe(() => panelCall('projects?initial=1')));
server.registerTool('list_shortcuts', { title: '读取项目快捷入口', description: '读取已保存的快捷入口，不启动项目。', inputSchema: {}, annotations: readOnly, _meta: { ui: { visibility: ['model', 'app'] } } }, safe(() => panelCall('projects')));
server.registerTool('save_shortcut', {
  title: '保存项目快捷入口', description: '保存用户提供的已有启动文件或 PowerShell 命令，不执行该入口。', annotations: write,
  inputSchema: { id: z.string().optional(), name: z.string(), icon: z.string().optional(), type: z.enum(['file', 'command']), path: z.string().optional(), command: z.string().optional(), cwd: z.string().optional(), healthUrl: z.string().optional(), stopCommand: z.string().optional() },
  _meta: { ui: { visibility: ['model', 'app'] } },
}, safe(args => panelCall('save', args)));
server.registerTool('remove_shortcut', {
  title: '移除项目快捷入口', description: '只移除面板中的入口，不删除项目文件。', inputSchema: { id: z.string() }, annotations: { ...write, destructiveHint: true }, _meta: { ui: { visibility: ['model', 'app'] } },
}, safe(args => panelCall('remove', args)));
server.registerTool('launch_shortcut', {
  title: '启动已保存项目', description: '通过 Windows 启动用户选择的已有文件或 PowerShell 命令。项目在自己的终端或应用窗口中运行。', inputSchema: { id: z.string() }, annotations: write, _meta: { ui: { visibility: ['model', 'app'] } },
}, safe(args => panelCall('launch', args)));
for (const [name, endpoint, title] of [['stop_shortcut', 'stop', '停止已保存项目'], ['restart_shortcut', 'restart', '重启已保存项目']]) {
  server.registerTool(name, { title, description: '仅处理用户明确选择的已保存项目。核验进程归属后请求正常退出；重启必须先确认业务进程退出，不强制结束。',
    inputSchema: { id: z.string() }, annotations: { ...write, destructiveHint: true }, _meta: { ui: { visibility: ['model', 'app'] } } },
  safe(args => panelCall(endpoint, args)));
}
// SDK 1.31 accepts icons in the protocol but drops them in registerTool().
// Add the entrypoint icon at the public transport boundary until that SDK supports it.
class EntrypointIconTransport extends StdioServerTransport {
  async send(message) {
    if (Array.isArray(message.result?.tools)) {
      message = { ...message, result: { ...message.result, tools: message.result.tools.map(tool =>
        tool.name === 'open_dashboard' ? { ...tool, icons: entrypointIcons } : tool) } };
    }
    return super.send(message);
  }
}
await server.connect(new EntrypointIconTransport());
