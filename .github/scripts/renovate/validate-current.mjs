#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCurrentComposeFiles } from './lib/compose-release.mjs';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

try {
  const currentComposes = await discoverCurrentComposeFiles(rootDirectory);
  console.log(JSON.stringify({
    event: 'current-compose-files-valid',
    applications: currentComposes.map((compose) => ({
      application: compose.application,
      release: compose.release,
      compose: compose.composePath,
    })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'current-manifests-invalid', message: error.message }));
  process.exitCode = 1;
}
