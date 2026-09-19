export function buildRenovatePullRequestTitle(report) {
  if (!report?.application || !report?.targetRelease) {
    throw new Error('缺少应用名称或目标 release，无法生成 PR 标题');
  }
  return 'chore(deps): update ' + report.application + ' tag to ' + report.targetRelease;
}

export function getRenovateBranchDeletionPath(headRef) {
  if (typeof headRef !== 'string' || !headRef.startsWith('renovate/')) {
    throw new Error('只允许删除 renovate/* 分支');
  }
  const segments = headRef.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Renovate 分支名不安全');
  }
  return '/git/refs/heads/' + segments.map(encodeURIComponent).join('/');
}
