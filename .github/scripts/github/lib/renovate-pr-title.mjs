const currentComposePattern = /^apps\/([^/]+)\/([^/]+)\/docker-compose\.yml$/u;

export function findRenovateComposePath(files) {
  const paths = files
    .map((file) => file.filename)
    .filter((filename) => currentComposePattern.test(filename));
  if (paths.length !== 1) return null;
  return paths[0];
}

export function buildRenovatePrTitle({ application, release }) {
  if (!application || !release) {
    throw new Error('编排路径缺少 application 或 release');
  }
  const displayRelease = release.startsWith('v') ? release : `v${release}`;
  return `chore(deps): update ${application} tag to ${displayRelease}`;
}

export async function updateRenovatePrTitle({ github, pullRequest, changedFiles }) {
  const composePath = findRenovateComposePath(changedFiles);
  if (!composePath) return false;
  const match = currentComposePattern.exec(composePath);
  const [, application, release] = match;
  const title = buildRenovatePrTitle({ application, release });
  if (pullRequest.title === title) return false;

  await github.request('PATCH', `/pulls/${pullRequest.number}`, { title });
  pullRequest.title = title;
  return true;
}
