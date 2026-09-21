#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverCurrentComposeFiles } from './lib/compose-release.mjs';

const options = parseArguments(process.argv.slice(2));
const rootDirectory = options.root
  ? path.resolve(options.root)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

try {
  const currentComposes = await discoverCurrentComposeFiles(rootDirectory);
  const globalConfigPath = path.join(rootDirectory, '.github', 'renovate-global.json');
  const globalConfig = JSON.parse(await fs.readFile(globalConfigPath, 'utf8'));
  const currentComposePaths = currentComposes.map((compose) => compose.composePath);
  const runtimeConfig = {
    ...globalConfig,
    includePaths: currentComposePaths,
    // Renovate 仍需修改 package file 后才能把 upgrades 传给 post-upgrade，
    // 但最终提交必须排除源 Compose，只提交脚本创建的新版本目录。
    excludeCommitPaths: [
      ...new Set([...(globalConfig.excludeCommitPaths || []), ...currentComposePaths]),
    ],
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    event: 'renovate-runtime-config-prepared',
    output: options.output,
    excludeCommitPaths: runtimeConfig.excludeCommitPaths,
    applications: currentComposes.map(({ application, release, composePath }) => ({
      application,
      release,
      composePath,
    })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'renovate-runtime-config-failed', message: error.message }));
  process.exitCode = 1;
}

function parseArguments(args) {
  const parsed = { root: '', output: '' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--root' || argument === '--output') {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} 缺少参数值`);
      parsed[argument === '--root' ? 'root' : 'output'] = value;
      index += 1;
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }
  if (!parsed.output) throw new Error('缺少 --output');
  return parsed;
}
