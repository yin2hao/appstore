const currentManifestPattern = /^\.renovate\/current\/([^/]+)\.json$/u;

export function findCurrentManifestPath(files) {
  const paths = files
    .map((file) => file.filename)
    .filter((filename) => currentManifestPattern.test(filename));
  if (paths.length !== 1) return null;
  return paths[0];
}

export function buildRenovatePrTitle({ application, release }) {
  if (!application || !release) {
    throw new Error('编排 manifest 缺少 application 或 release');
  }
  const displayRelease = release.startsWith('v') ? release : `v${release}`;
  return `chore(deps): update ${application} tag to ${displayRelease}`;
}

export async function updateRenovatePrTitle({ github, pullRequest, changedFiles }) {
  const manifestPath = findCurrentManifestPath(changedFiles);
  if (!manifestPath) return false;

  const ref = encodeURIComponent(pullRequest.head.ref);
  const encodedPath = manifestPath.split('/').map(encodeURIComponent).join('/');
  const response = await github.request('GET', `/contents/${encodedPath}?ref=${ref}`);
  const manifest = JSON.parse(Buffer.from(response.content, 'base64').toString('utf8'));
  const title = buildRenovatePrTitle(manifest);
  if (pullRequest.title === title) return false;

  await github.request('PATCH', `/pulls/${pullRequest.number}`, { title });
  pullRequest.title = title;
  return true;
}
