#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPostUpgrade } from './lib/compose-release.mjs';

const argumentsList = process.argv.slice(2);
const options = parseArguments(argumentsList);
// 未指定 --root 时，从脚本路径反推仓库根目录。
const rootDirectory = options.root
  ? path.resolve(options.root)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Renovate 会把整个 branch 的升级列表写入临时 JSON 文件。
const dataFile = options.dataFile || process.env.RENOVATE_POST_UPGRADE_COMMAND_DATA_FILE;

try {
  // 生成并输出发布计划，核心函数负责全部校验。
  if (!dataFile) {
    throw new Error('缺少 --data-file 或 RENOVATE_POST_UPGRADE_COMMAND_DATA_FILE');
  }
  const upgrades = JSON.parse(await fs.readFile(path.resolve(dataFile), 'utf8'));
  const plan = await runPostUpgrade({ rootDirectory, upgrades, dryRun: options.dryRun });
  console.log(JSON.stringify(plan, null, 2));
} catch (error) {
  // 失败关闭，防止 Renovate 提交无效版本。
  console.error(JSON.stringify({ event: 'compose-release-error', message: error.message }));
  process.exitCode = 1;
}

// 解析 Renovate 和本地 dry-run 使用的少量 CLI 参数。
function parseArguments(args) {
  const parsed = { dryRun: false, root: '', dataFile: '' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      parsed.dryRun = true;
    } else if (argument === '--root' || argument === '--data-file') {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} 缺少参数值`);
      parsed[argument === '--root' ? 'root' : 'dataFile'] = value;
      index += 1;
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }
  return parsed;
}
