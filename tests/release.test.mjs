import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseFiles, assertPublicFile, zipFiles, prepareRelease } from '../scripts/prepare-release.mjs';
import { VERSION } from '../src/version.mjs';
import { windowsPowerShellPath } from '../src/powershell.mjs';
import { tempDir } from './helpers.mjs';

test('public source is complete and excludes local history, discovery scripts, configuration, and old screenshots', async () => {
  const source = await releaseFiles(process.cwd(), true), windows = await releaseFiles(process.cwd(), false);
  const names = new Set(source.map(f => f.name));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'docs/assets/project-launcher-demo.png', 'docs/USAGE.md', '.agents/plugins/marketplace.json', 'plugins/start-buttons/.mcp.json',
    'plugins/start-buttons/.codex-plugin/plugin.json', 'plugins/start-buttons/dist/stop-console.ps1', 'scripts/build.mjs',
    'tests/lifecycle-native.test.mjs', 'src/launch-journal.mjs', '.github/workflows/ci.yml']) assert.ok(names.has(name), name);
  assert.ok(!names.has('scripts/seed-discovered.mjs'));
  assert.ok(!source.some(f => f.name.startsWith('artifacts/') || f.name.startsWith('.git/')));
  assert.ok(!windows.some(f => /^(src|tests|web)\//.test(f.name)));
  for (const f of windows) assert.ok(names.has(f.name));
  assert.match((await readFile('THIRD_PARTY_NOTICES.txt', 'utf8')), /@modelcontextprotocol\/sdk.*1\.31\.0/);
});

test('public instructions resolve local Markdown links and package metadata uses the release name and version consistently', async () => {
  const files = await releaseFiles(process.cwd(), true), names = new Set(files.map(f => f.name));
  for (const name of ['README.md', 'docs/USAGE.md', 'docs/PUBLIC_RELEASE.md']) {
    const source = files.find(f => f.name === name).bytes.toString('utf8');
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1];
      if (/^https?:\/\/|^#/.test(target)) continue;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), target.split('#')[0]));
      assert.ok(names.has(relative), `${name} points to a missing public file: ${relative}`);
    }
  }
  const pkg = JSON.parse(files.find(f => f.name === 'package.json').bytes);
  const lock = JSON.parse(files.find(f => f.name === 'package-lock.json').bytes);
  assert.equal(pkg.name, 'codex-project-launcher');
  assert.equal(lock.name, pkg.name); assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(pkg.version, VERSION); assert.equal(lock.version, VERSION); assert.equal(lock.packages[''].version, VERSION);
  const readme = files.find(f => f.name === 'README.md').bytes.toString();
  assert.ok(readme.includes(`codex-project-launcher-${VERSION}-windows.zip`));
  assert.ok(readme.includes('https://github.com/linsank2005/codex-project-launcher/releases/latest'));
});

test('named source and Windows archives include verifiable checksums and match their approved public file lists', async t => {
  const dir = await tempDir(t), files = await releaseFiles(process.cwd(), true);
  for (const file of files) {
    const target = path.join(dir, file.name);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.bytes);
  }
  const result = await prepareRelease(dir);
  assert.equal(result.version, VERSION);
  assert.equal(result.sourceFiles, files.length);
  for (const [index, kind] of ['source', 'windows'].entries()) {
    const name = `codex-project-launcher-${VERSION}-${kind}.zip`;
    const bytes = await readFile(path.join(dir, 'release', name));
    assert.equal(result.checksums[index], `${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    assert.deepEqual(bytes, zipFiles(await releaseFiles(dir, kind === 'source')));
  }
  assert.equal(await readFile(path.join(dir, 'release', 'SHA256SUMS.txt'), 'utf8'), result.checksums.join('\n') + '\n');
});

test('release rejects private runtime files, local user paths and credentials without displaying their values', () => {
  for (const file of ['.env', '.git/config', 'projects.json', 'launches.json', 'runtime.json', 'scripts/seed-discovered.mjs']) {
    assert.throws(() => assertPublicFile(file, Buffer.from('{}')), /release file/);
  }
  const privatePath = ['C:', 'Users', 'private-demo', 'project'].join('/');
  const token = 'gh' + 'p_' + 'a'.repeat(32);
  for (const value of [privatePath, token]) assert.throws(() => assertPublicFile('README.md', Buffer.from(value)), /credential/);
  assert.doesNotThrow(() => assertPublicFile('README.md', Buffer.from('D:/Projects/demo/start.ps1')));
});

test('release lockfile describes the installed dependency versions and exact dependency constraints', async () => {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  for (const [name, expected] of Object.entries(lock.packages)) {
    if (!name) continue;
    let installed;
    try { installed = JSON.parse(await readFile(path.join(name, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && expected.optional) continue; throw error; }
    assert.equal(expected.version, installed.version, name);
    assert.deepEqual(expected.dependencies || {}, installed.dependencies || {}, `${name} dependencies`);
  }
});

test('standard Windows ZIP reader restores hidden manifests, Unicode filenames and exact bytes', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t), file = path.join(dir, 'test.zip');
  const contents = [{ name: '.agents/plugins/marketplace.json', bytes: Buffer.from('{"name":"demo"}') },
    { name: '插件/启动.cmd', bytes: Buffer.from('你好\r\n') }];
  await writeFile(file, zipFiles(contents));
  const literal = s => "'" + s.replace(/'/g, "''") + "'";
  const code = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead(${literal(file)}); try { [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, ${literal(path.join(dir, 'out'))}) } finally { $zip.Dispose() }`;
  await promisify(execFile)(windowsPowerShellPath(), ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 });
  for (const entry of contents) assert.deepEqual(await readFile(path.join(dir, 'out', entry.name)), entry.bytes);
});
