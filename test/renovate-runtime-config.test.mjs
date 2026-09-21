import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('运行时配置扫描当前 Compose，但禁止把源 Compose 提交到更新分支', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'renovate-runtime-config-'));
  const output = path.join(temporaryDirectory, 'renovate-runtime.json');

  try {
    await execFileAsync(process.execPath, [
      '.github/scripts/renovate/prepare-runtime-config.mjs',
      '--root',
      process.cwd(),
      '--output',
      output,
    ]);
    const runtimeConfig = JSON.parse(await readFile(output, 'utf8'));

    assert.ok(runtimeConfig.includePaths.length > 0);
    assert.deepEqual(runtimeConfig.excludeCommitPaths, runtimeConfig.includePaths);
    assert.ok(runtimeConfig.includePaths.every((file) => file.endsWith('/docker-compose.yml')));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
