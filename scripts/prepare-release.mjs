import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { VERSION } from '../src/version.mjs';

const rootFiles = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'CHANGELOG.md', 'docs/PUBLIC_RELEASE.md', 'docs/USAGE.md', 'docs/assets/project-launcher-demo.png',
  '.agents/plugins/marketplace.json', '安装插件.cmd', '启动面板.cmd'];
const scripts = ['build.mjs', 'third-party-notices.mjs', 'prepare-release.mjs', 'install-plugin.ps1', 'check-codex.mjs'];

async function tree(root, relative) {
  const results = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Release refuses symlink: ${name}`);
    if (entry.isDirectory()) results.push(...await tree(root, name));
    else if (entry.isFile()) results.push(name);
  }
  return results;
}
export function assertPublicFile(name, bytes) {
  if (/(^|\/)(\.git|node_modules|\.tmp|artifacts|release)(\/|$)/.test(name) ||
      /(^|\/)(projects|launches|runtime)\.json$|(^|\/)\.env(?:\.|$)|seed-discovered|(?:^|\/)\.codex\/|backups/i.test(name)) {
    throw new Error(`Private or unnecessary release file: ${name}`);
  }
  const normalized = bytes.toString('utf8').replace(/\\+/g, '/');
  const privatePath = /\b[A-Z]:\/(?:Users\/[^\s"'<>]+|AI-Tools\/|Soft\/Codex\/|Work\/)/i;
  const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;
  if (privatePath.test(normalized) || secret.test(normalized)) throw new Error(`Possible private path or credential in: ${name}`);
}
export async function releaseFiles(root, source) {
  const files = [...rootFiles, ...await tree(root, 'plugins/start-buttons'), 'scripts/install-plugin.ps1'];
  if (source) files.push('package.json', 'package-lock.json', '.gitignore', 'AGENTS.md', '.github/workflows/ci.yml',
    ...scripts.filter(n => n !== 'install-plugin.ps1').map(n => `scripts/${n}`), ...await tree(root, 'src'), ...await tree(root, 'web'),
    ...(await tree(root, 'tests')).filter(n => /\.(mjs|ps1)$/.test(n)));
  const contents = [];
  for (const name of [...new Set(files)].sort()) {
    const bytes = await readFile(path.join(root, name));
    assertPublicFile(name, bytes); contents.push({ name, bytes });
  }
  const manifest = JSON.parse(contents.find(f => f.name === 'plugins/start-buttons/.codex-plugin/plugin.json').bytes);
  if (manifest.version !== VERSION) throw new Error('Release plugin version mismatch.');
  if (source && JSON.parse(contents.find(f => f.name === 'package.json').bytes).version !== VERSION) throw new Error('Release package version mismatch.');
  const html = contents.find(f => f.name === 'plugins/start-buttons/dist/panel.html').bytes.toString();
  if (!html.includes(VERSION) || !html.includes('stop_shortcut') || !html.includes('status-dialog')) throw new Error('Build the current plugin before release.');
  return contents;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}
// Standard ZIP with stored entries: no extra runtime dependency, UTF-8 filenames,
// deterministic timestamps, and explicit inclusion of hidden plugin manifests.
export function zipFiles(files) {
  const entries = [], central = []; let offset = 0;
  for (const { name, bytes } of files) {
    const filename = Buffer.from(name, 'utf8'), checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(33, 14); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    entries.push(local, filename, bytes); central.push(record, filename); offset += local.length + filename.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, centralBytes, end]);
}
export async function prepareRelease(root = process.cwd()) {
  // Validate both packages before replacing any existing output.
  const source = await releaseFiles(root, true), windows = await releaseFiles(root, false);
  const directory = path.join(root, 'release'); await mkdir(directory, { recursive: true });
  const checksums = [];
  for (const [kind, files] of [['source', source], ['windows', windows]]) {
    const name = `codex-project-launcher-${VERSION}-${kind}.zip`, bytes = zipFiles(files);
    await writeFile(path.join(directory, name), bytes);
    checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  return { version: VERSION, sourceFiles: source.length, windowsFiles: windows.length, checksums };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareRelease(), null, 2));
}
