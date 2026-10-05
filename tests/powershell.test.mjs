import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { resolvePowerShell } from '../src/powershell.mjs';

test('missing PowerShell 7 produces an actionable error instead of falling back to 5.1', async () => {
  await assert.rejects(resolvePowerShell({}), /未找到可用的 PowerShell 7/);
});
const bundled = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
test('Codex bundled PowerShell is found even when pwsh is absent from PATH', {
  skip: process.platform !== 'win32' || !(await stat(bundled).catch(() => null))?.isFile(),
}, async () => {
  const resolved = await resolvePowerShell({ USERPROFILE: process.env.USERPROFILE, PATH: '', SystemRoot: process.env.SystemRoot });
  assert.equal(resolved.path, bundled);
  assert.ok(Number(resolved.version.split('.')[0]) >= 7);
});
