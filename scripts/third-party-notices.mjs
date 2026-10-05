import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Includes build-time dependencies as well as code bundled into the plugin.
export async function writeThirdPartyNotices(root = process.cwd()) {
  const packages = [];
  const visit = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = path.join(folder, entry.name);
      if (entry.name.startsWith('@')) { await visit(directory); continue; }
      const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort();
      if (!names.length && !info.name.startsWith('@esbuild/')) throw new Error(`Missing license text for ${info.name}.`);
      const licenses = names.length ? await Promise.all(names.map(async name => `${name}\n${await readFile(path.join(directory, name), 'utf8')}`))
        : [`Platform binary covered by esbuild/LICENSE.md\n${await readFile(path.join(root, 'node_modules/esbuild/LICENSE.md'), 'utf8')}`];
      packages.push({ name: info.name, version: info.version, license: info.license, text: licenses.join('\n\n') });
      try { await visit(path.join(directory, 'node_modules')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  await visit(path.join(root, 'node_modules'));
  packages.sort((a, b) => a.name.localeCompare(b.name));
  const text = 'Codex Project Launcher third-party notices\nGenerated from installed, lockfile-pinned dependencies. Includes development tooling.\n\n' +
    packages.map(p => `${'='.repeat(72)}\n${p.name} ${p.version} (${p.license})\n${'='.repeat(72)}\n${p.text}`).join('\n\n');
  await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '') + '\n', 'utf8');
}
