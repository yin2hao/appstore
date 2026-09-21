import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRenovatePrTitle,
  findCurrentManifestPath,
  updateRenovatePrTitle,
} from '../.github/scripts/github/lib/renovate-pr-title.mjs';

test('Renovate PR title includes the generated compose release', () => {
  assert.equal(
    buildRenovatePrTitle({ application: 'videobackup-next', release: '1.0.0-1' }),
    'chore(deps): update videobackup-next tag to v1.0.0-1'
  );
  assert.equal(
    buildRenovatePrTitle({ application: 'videobackup-next', release: 'v1.0.0-1' }),
    'chore(deps): update videobackup-next tag to v1.0.0-1'
  );
});

test('current manifest path is only selected for a single compose PR', () => {
  assert.equal(
    findCurrentManifestPath([{ filename: '.renovate/current/videobackup-next.json' }]),
    '.renovate/current/videobackup-next.json'
  );
  assert.equal(findCurrentManifestPath([{ filename: 'README.md' }]), null);
  assert.equal(
    findCurrentManifestPath([
      { filename: '.renovate/current/one.json' },
      { filename: '.renovate/current/two.json' },
    ]),
    null
  );
});

test('Renovate PR title is updated from the manifest on the PR branch', async () => {
  const calls = [];
  const github = {
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, body });
      if (method === 'GET') {
        return {
          content: Buffer.from(JSON.stringify({ application: 'videobackup-next', release: '1.0.0-2' })).toString('base64'),
        };
      }
      return {};
    },
  };
  const pullRequest = {
    number: 36,
    title: 'chore(deps): update videobackup-next tag',
    head: { ref: 'renovate/videobackup-next-tag' },
  };

  assert.equal(
    await updateRenovatePrTitle({
      github,
      pullRequest,
      changedFiles: [{ filename: '.renovate/current/videobackup-next.json' }],
    }),
    true
  );
  assert.equal(pullRequest.title, 'chore(deps): update videobackup-next tag to v1.0.0-2');
  assert.deepEqual(calls, [
    {
      method: 'GET',
      endpoint: '/contents/.renovate/current/videobackup-next.json?ref=renovate%2Fvideobackup-next-tag',
      body: undefined,
    },
    {
      method: 'PATCH',
      endpoint: '/pulls/36',
      body: { title: 'chore(deps): update videobackup-next tag to v1.0.0-2' },
    },
  ]);
});
