const SOURCE_COMPOSE_PATTERN = /^apps\/([a-z0-9][a-z0-9-]*)\/([^/]+)\/docker-compose\.yml$/;

export class PullRequestNotEligibleError extends Error {}

export function validatePullRequestIdentity({ pullRequest, repository, expectedAuthors }) {
  const failures = [];
  if (pullRequest.head?.repo?.full_name !== repository) failures.push('PR 不是来自本仓库分支');
  if (!pullRequest.head?.ref?.startsWith('renovate/')) failures.push('PR 分支名不属于 renovate/*');
  if (!expectedAuthors.includes(pullRequest.user?.login)) failures.push('PR 作者不是预期 Renovate Bot');
  if (pullRequest.draft) failures.push('PR 仍处于 draft 状态');

  if (failures.length > 0) {
    throw new PullRequestNotEligibleError(failures.join('；'));
  }
  return true;
}

// Renovate 的固定流程会新增一个版本目录，Compose 内容交给 LLM 审查。
export function validateRenovatePullRequest({ changedFiles }) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error('PR 没有文件变更');
  }

  const composeChanges = changedFiles.filter(
    (file) => file.status === 'added' && SOURCE_COMPOSE_PATTERN.test(file.filename)
  );
  if (composeChanges.length !== 1) {
    throw new Error(`PR 必须且只能新增一个版本 Compose 文件，实际为 ${composeChanges.length} 个`);
  }

  const composePath = composeChanges[0].filename;
  const [, application, targetRelease] = SOURCE_COMPOSE_PATTERN.exec(composePath);
  return {
    application,
    targetRelease,
    composePath,
    changedFiles: changedFiles.map((file) => file.filename),
  };
}
