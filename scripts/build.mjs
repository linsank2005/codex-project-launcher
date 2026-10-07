import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { VERSION } from '../src/version.mjs';
import { writeThirdPartyNotices } from './third-party-notices.mjs';

for (const file of ['package.json', 'plugins/start-buttons/.codex-plugin/plugin.json']) {
  if (JSON.parse(await readFile(file, 'utf8')).version !== VERSION) throw new Error(`Version mismatch in ${file}.`);
}

const out = 'plugins/start-buttons/dist';
await mkdir(out, { recursive: true });
const ui = await build({ entryPoints: ['web/ui.mjs'], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true, legalComments: 'none' });
const css = await readFile('web/style.css', 'utf8');
const icon = 'data:image/svg+xml;base64,' + (await readFile('plugins/start-buttons/assets/icon.svg')).toString('base64');
const html = (await readFile('web/panel.html', 'utf8'))
  .replaceAll('/*PROJECT_DOCK_ICON*/', icon)
  .replace('/*START_BUTTONS_CSS*/', () => css)
  .replace('/*START_BUTTONS_JS*/', () => ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
await writeFile(`${out}/panel.html`, html);
for (const [entry, output] of [['src/panel-entry.mjs', 'panel.mjs'], ['src/mcp.mjs', 'mcp.mjs']]) {
  await build({ entryPoints: [entry], outfile: `${out}/${output}`, bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    legalComments: 'eof' });
}
await copyFile('src/launch.ps1', `${out}/launch.ps1`);
await copyFile('src/stop-console.ps1', `${out}/stop-console.ps1`);
await copyFile('src/upgrade-panel.ps1', `${out}/upgrade-panel.ps1`);
await writeThirdPartyNotices();
await copyFile('THIRD_PARTY_NOTICES.txt', 'plugins/start-buttons/THIRD_PARTY_NOTICES.txt');
await copyFile('LICENSE', 'plugins/start-buttons/LICENSE');
console.log('Built self-contained local plugin: plugins/start-buttons (Node.js 22+).');
