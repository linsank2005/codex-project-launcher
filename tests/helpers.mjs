import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

export async function tempDir(t) {
  const root = await realpath(os.tmpdir());
  const dir = await mkdtemp(path.join(root, 'start-buttons-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(dir)), root, 'Cleanup must stay inside the test temp root.');
    assert.ok(path.basename(dir).startsWith('start-buttons-test-'));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return dir;
}
export async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Test entry did not create its marker: ${file}`);
}
