const currentComposePattern = /^apps\/([^/]+)\/([^/]+)\/docker-compose\.yml$/u;

export function findRenovateComposePath(files) {
  const candidates = files.filter((file) => currentComposePattern.test(file.filename));
  const added = candidates.filter((file) => file.status === 'added');
  if (added.length !== 1) {
    throw new Error(`Renovate PR 必须且只能新增一个目标 Compose，实际为 ${added.length} 个`);
  }

  const targetComposePath = added[0].filename;
  const [, application, release] = currentComposePattern.exec(targetComposePath);
  const targetDirectory = `apps/${application}/${release}/`;
  const invalidFiles = files.filter(
    (file) => file.status !== 'added' || !file.filename.startsWith(targetDirectory)
  );
  if (invalidFiles.length > 0) {
    throw new Error(
      `Renovate PR 修改了目标版本目录之外的文件: ${invalidFiles.map((file) => file.filename).join(', ')}`
    );
  }

  return targetComposePath;
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
  const match = currentComposePattern.exec(composePath);
  const [, application, release] = match;
  const title = buildRenovatePrTitle({ application, release });
  if (pullRequest.title === title) return false;

  await github.request('PATCH', `/pulls/${pullRequest.number}`, { title });
  pullRequest.title = title;
  return true;
}
