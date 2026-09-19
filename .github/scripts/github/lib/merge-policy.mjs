const SEMVER_TAG_PATTERN = /^v?(?<major>0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function decideAutoMergePolicy(upgrades) {
  if (!Array.isArray(upgrades) || upgrades.length === 0) {
    throw new Error('无法为没有镜像更新的 PR 决定合并策略');
  }

  const unclassified = upgrades.filter(
    (upgrade) => getSemverMajor(upgrade.currentValue) === null || getSemverMajor(upgrade.newValue) === null
  );
  if (unclassified.length > 0) {
    return {
      autoMerge: false,
      category: 'unclassified',
      summary: '存在无法按语义版本识别的镜像 tag：' + formatUpgrades(unclassified),
    };
  }

  const majorUpdates = upgrades.filter(
    (upgrade) => getSemverMajor(upgrade.currentValue) !== getSemverMajor(upgrade.newValue)
  );
  if (majorUpdates.length > 0) {
    return {
      autoMerge: false,
      category: 'major',
      summary: '检测到大版本镜像更新：' + formatUpgrades(majorUpdates),
    };
  }

  return {
    autoMerge: true,
    category: 'non-major',
    summary: '所有镜像均为非大版本更新',
  };
}

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

function getSemverMajor(tag) {
  if (typeof tag !== 'string') return null;
  const match = SEMVER_TAG_PATTERN.exec(tag);
  return match ? Number(match.groups.major) : null;
}

function formatUpgrades(upgrades) {
  return upgrades
    .map((upgrade) => upgrade.repository + ':' + upgrade.currentValue + ' → ' + upgrade.newValue)
    .join('，');
}
