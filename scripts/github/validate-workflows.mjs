#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from '../vendor/yaml.mjs';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowDirectory = path.join(rootDirectory, '.github', 'workflows');

try {
  const files = (await fs.readdir(workflowDirectory))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  for (const file of files) {
    const source = await fs.readFile(path.join(workflowDirectory, file), 'utf8');
    const workflow = YAML.parse(source);
    if (!workflow || typeof workflow !== 'object' || !workflow.jobs || !workflow.on) {
      throw new Error(`${file} 缺少 on 或 jobs`);
    }
  }
  console.log(JSON.stringify({ event: 'workflows-valid', files }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'workflows-invalid', message: error.message }));
  process.exitCode = 1;
}
