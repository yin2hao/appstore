#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRepositoryCurrentManifests } from './lib/compose-release.mjs';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

try {
  const manifests = await validateRepositoryCurrentManifests(rootDirectory);
  console.log(JSON.stringify({
    event: 'current-manifests-valid',
    applications: manifests.map((manifest) => ({
      application: manifest.application,
      release: manifest.release,
      compose: manifest.compose,
    })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'current-manifests-invalid', message: error.message }));
  process.exitCode = 1;
}
