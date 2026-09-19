import { isDeepStrictEqual } from 'node:util';
import {
  applyImageUpgrades,
  calculateNextReleaseVersion,
  findPrimaryImage,
  parseCompose,
  validateCurrentManifest,
  validateGeneratedRelease,
  validateManifestAgainstCompose,
} from '../../renovate/lib/compose-release.mjs';

const CONTROL_PATTERN = /^\.renovate\/current\/([^/]+)\.json$/;

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

export async function validateRenovatePullRequest({
  changedFiles,
  baseTree,
  headTree,
  readBaseText,
  readHeadText,
}) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error('PR 没有文件变更');
  }

  for (const file of changedFiles) {
    if (file.status === 'removed' || file.status === 'renamed' || file.previous_filename) {
      throw new Error(`禁止删除或重命名文件: ${file.previous_filename || file.filename}`);
    }
  }

  const controlChanges = changedFiles.filter((file) => CONTROL_PATTERN.test(file.filename));
  if (controlChanges.length !== 1) {
    throw new Error(`PR 必须且只能修改一个 current manifest，实际为 ${controlChanges.length} 个`);
  }

  const controlChange = controlChanges[0];
  if (controlChange.status !== 'modified') {
    throw new Error('current manifest 必须是修改，不能新增、删除或重命名');
  }

  const controlPath = controlChange.filename;
  const applicationFromPath = CONTROL_PATTERN.exec(controlPath)[1];
  const [baseManifest, headManifest] = await Promise.all([
    readJson(readBaseText, controlPath),
    readJson(readHeadText, controlPath),
  ]);
  validateCurrentManifest(baseManifest);
  validateCurrentManifest(headManifest);

  if (baseManifest.application !== applicationFromPath || headManifest.application !== applicationFromPath) {
    throw new Error('current manifest 的 application 与文件名不一致');
  }

  const application = baseManifest.application;
  if (headManifest.application !== application) {
    throw new Error('PR 不得改变 current manifest 对应的应用');
  }

  const sourcePrefix = `apps/${application}/${baseManifest.release}/`;
  const targetPrefix = `apps/${application}/${headManifest.release}/`;

  if (sourcePrefix === targetPrefix) {
    throw new Error('PR 没有创建新的版本目录');
  }

  for (const file of changedFiles) {
    if (file.filename === controlPath) continue;
    if (!file.filename.startsWith(targetPrefix)) {
      throw new Error(`存在超出当前应用新版本目录范围的修改: ${file.filename}`);
    }
    if (file.status !== 'added') {
      throw new Error(`新版本目录中的文件必须全部是新增: ${file.filename}`);
    }
  }

  if ([...baseTree.keys()].some((file) => file.startsWith(targetPrefix))) {
    throw new Error(`目标版本目录在 base 中已经存在: ${targetPrefix}`);
  }

  assertHistoricalFilesUnchanged({ baseTree, headTree, application, targetPrefix });
  assertCompleteCopy({ baseTree, headTree, sourcePrefix, targetPrefix });

  const [sourceComposeText, targetComposeText] = await Promise.all([
    readBaseText(baseManifest.compose),
    readHeadText(headManifest.compose),
  ]);
  const sourceCompose = parseCompose(sourceComposeText, baseManifest.compose);
  const targetCompose = parseCompose(targetComposeText, headManifest.compose);
  validateManifestAgainstCompose(baseManifest, sourceCompose);
  validateManifestAgainstCompose(headManifest, targetCompose);

  const upgrades = buildManifestUpgrades(baseManifest, headManifest, controlPath);
  validateGeneratedRelease({
    sourceCompose,
    generatedCompose: targetCompose,
    upgrades,
    manifest: headManifest,
  });

  const currentPrimary = findPrimaryImage(sourceCompose);
  const newPrimary = findPrimaryImage(targetCompose);
  const releaseDirectories = collectReleaseDirectories(baseTree, application);
  const expected = calculateNextReleaseVersion({
    currentPrimaryVersion: currentPrimary.tag,
    newPrimaryVersion: newPrimary.tag,
    currentRelease: baseManifest.release,
    releaseDirectories,
  });

  if (headManifest.release !== expected.targetRelease) {
    throw new Error(
      `新版本目录错误: 期望 ${expected.targetRelease}，实际 ${headManifest.release}`
    );
  }

  const expectedComposePath = `apps/${application}/${expected.targetRelease}/docker-compose.yml`;
  if (headManifest.compose !== expectedComposePath || !headTree.has(expectedComposePath)) {
    throw new Error('新版本目录未包含预期的完整 docker-compose.yml');
  }

  return {
    application,
    controlPath,
    sourceDirectory: sourcePrefix.slice(0, -1),
    targetDirectory: targetPrefix.slice(0, -1),
    currentPrimaryImage: `${currentPrimary.repository}:${currentPrimary.tag}`,
    newPrimaryImage: `${newPrimary.repository}:${newPrimary.tag}`,
    currentRevision: expected.currentRevision,
    targetRevision: expected.targetRevision,
    revisionGaps: expected.revisionGaps,
    upgrades: upgrades.map((upgrade) => ({
      service: upgrade.depType,
      repository: upgrade.depName,
      currentValue: upgrade.currentValue,
      newValue: upgrade.newValue,
    })),
    changedFiles: changedFiles.map((file) => file.filename),
  };
}

function buildManifestUpgrades(baseManifest, headManifest, packageFile) {
  const baseWithoutMutableFields = {
    ...baseManifest,
    release: '<release>',
    compose: '<compose>',
    images: baseManifest.images.map(({ tag, ...image }) => ({ ...image, tag: '<tag>' })),
  };
  const headWithoutMutableFields = {
    ...headManifest,
    release: '<release>',
    compose: '<compose>',
    images: headManifest.images.map(({ tag, ...image }) => ({ ...image, tag: '<tag>' })),
  };
  if (!isDeepStrictEqual(baseWithoutMutableFields, headWithoutMutableFields)) {
    throw new Error('current manifest 包含 release、compose 和 image tag 之外的修改');
  }

  const upgrades = [];
  for (let index = 0; index < baseManifest.images.length; index += 1) {
    const before = baseManifest.images[index];
    const after = headManifest.images[index];
    if (before.tag === after.tag) continue;
    upgrades.push({
      packageFile,
      depName: before.repository,
      depType: before.service,
      currentValue: before.tag,
      newValue: after.tag,
    });
  }
  if (upgrades.length === 0) {
    throw new Error('current manifest 中没有 image tag 更新');
  }
  return upgrades;
}

function assertHistoricalFilesUnchanged({ baseTree, headTree, application, targetPrefix }) {
  const appPrefix = `apps/${application}/`;
  for (const [file, entry] of baseTree.entries()) {
    if (!file.startsWith(appPrefix) || file.startsWith(targetPrefix)) continue;
    const headEntry = headTree.get(file);
    if (!headEntry || headEntry.sha !== entry.sha) {
      throw new Error(`历史版本或应用元数据发生变化: ${file}`);
    }
  }
}

function assertCompleteCopy({ baseTree, headTree, sourcePrefix, targetPrefix }) {
  const sourceFiles = [...baseTree.keys()]
    .filter((file) => file.startsWith(sourcePrefix))
    .map((file) => file.slice(sourcePrefix.length))
    .sort();
  const targetFiles = [...headTree.keys()]
    .filter((file) => file.startsWith(targetPrefix))
    .map((file) => file.slice(targetPrefix.length))
    .sort();

  if (!isDeepStrictEqual(sourceFiles, targetFiles)) {
    throw new Error('新版本目录不是当前版本目录的完整副本');
  }

  for (const relativeFile of sourceFiles) {
    if (relativeFile === 'docker-compose.yml') continue;
    const sourceEntry = baseTree.get(`${sourcePrefix}${relativeFile}`);
    const targetEntry = headTree.get(`${targetPrefix}${relativeFile}`);
    if (sourceEntry.sha !== targetEntry.sha) {
      throw new Error(`新版本目录中的非 Compose 文件被意外修改: ${relativeFile}`);
    }
  }
}

function collectReleaseDirectories(tree, application) {
  const composeSuffix = '/docker-compose.yml';
  const prefix = `apps/${application}/`;
  return [...tree.keys()]
    .filter((file) => file.startsWith(prefix) && file.endsWith(composeSuffix))
    .map((file) => file.slice(prefix.length, -composeSuffix.length))
    .filter((release) => release && !release.includes('/'))
    .sort();
}

async function readJson(reader, file) {
  const text = await reader(file);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`无法解析 JSON ${file}: ${error.message}`);
  }
}
