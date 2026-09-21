const currentComposePattern = /^apps\/([^/]+)\/([^/]+)\/docker-compose\.yml$/u;

export function findRenovateComposePath(files) {
  const candidates = files.filter((file) => currentComposePattern.test(file.filename));
  if (candidates.length === 0) return null;

  // 动态编排更新会同时保留旧 Compose 和新增版本目录，优先选择新增的目标版本。
  const added = candidates.filter((file) => file.status === 'added');
  const selected = added.length > 0 ? added : candidates;
  const applications = new Set(selected.map((file) => currentComposePattern.exec(file.filename)[1]));
  if (applications.size !== 1) return null;

  selected.sort((left, right) => left.filename.localeCompare(right.filename, 'en', { numeric: true }));
  return selected.at(-1).filename;
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
