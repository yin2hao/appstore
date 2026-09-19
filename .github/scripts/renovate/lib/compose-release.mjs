import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import YAML from '../../vendor/yaml.mjs';

const CONTROL_FILE_PATTERN = /^\.renovate\/current\/[^/]+\.json$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

// 解析 Compose YAML，并要求存在有效 services 对象。
export function parseCompose(source, sourceName = 'docker-compose.yml') {
  let compose;

  try {
    compose = YAML.parse(source, { maxAliasCount: 100 });
  } catch (error) {
    throw new Error(`无法解析 Compose YAML ${sourceName}: ${error.message}`);
  }

  if (!compose || typeof compose !== 'object' || Array.isArray(compose)) {
    throw new Error(`Compose ${sourceName} 的根节点必须是对象`);
  }

  if (!compose.services || typeof compose.services !== 'object' || Array.isArray(compose.services)) {
    throw new Error(`Compose ${sourceName} 缺少有效的 services 对象`);
  }

  return compose;
}

// 将镜像拆分为 repository、tag 和可选 digest。
export function parseImageReference(reference, context = 'image') {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new Error(`${context} 必须是非空字符串`);
  }

  const value = reference.trim();
  const digestIndex = value.indexOf('@');
  const withoutDigest = digestIndex === -1 ? value : value.slice(0, digestIndex);
  const digest = digestIndex === -1 ? '' : value.slice(digestIndex + 1);
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');

  if (lastColon <= lastSlash || lastColon === withoutDigest.length - 1) {
    throw new Error(`${context} 必须包含明确的镜像 tag: ${reference}`);
  }

  const repository = withoutDigest.slice(0, lastColon);
  const tag = withoutDigest.slice(lastColon + 1);

  if (!repository) {
    throw new Error(`${context} 缺少镜像仓库名: ${reference}`);
  }

  validatePrimaryVersion(tag);

  return { repository, tag, digest };
}

// 按 Compose 声明顺序选择第一个有效 image。
export function findPrimaryImage(compose) {
  for (const [service, definition] of Object.entries(compose.services)) {
    if (!definition || typeof definition !== 'object' || !('image' in definition)) {
      continue;
    }

    try {
      return { service, reference: definition.image, ...parseImageReference(definition.image, `${service}.image`) };
    } catch (error) {
      if (typeof definition.image === 'string' && definition.image.trim()) {
        throw error;
      }
    }
  }

  throw new Error('Compose 中不存在具有有效 tag 的 image，无法确定 primary image');
}

// 返回 primary image tag，不强制规范版本格式。
export function parsePrimaryVersion(image) {
  const parsed = typeof image === 'string' ? parseImageReference(image, 'primary image') : image;
  validatePrimaryVersion(parsed.tag);
  return parsed.tag;
}

// 拒绝无法安全转换为目录名的 tag。
export function validatePrimaryVersion(version) {
  if (typeof version !== 'string' || !version) {
    throw new Error('primary image tag 不能为空');
  }

  if (!DOCKER_TAG.test(version)) {
    throw new Error(`primary image tag 不是合法且路径安全的 Docker tag: ${version}`);
  }

  if (version.includes('..') || /[\\/\u0000-\u001f\u007f]/u.test(version)) {
    throw new Error(`primary image tag 包含不安全的路径内容: ${version}`);
  }

  if (WINDOWS_DEVICE_NAME.test(version) || /[. ]$/u.test(version)) {
    throw new Error(`primary image tag 无法安全映射为目录名: ${version}`);
  }

  return version;
}

// 解析旧格式目录和带 revision 的目录。
export function parseReleaseDirectoryName(name, expectedPrimaryVersion) {
  if (typeof name !== 'string' || !name) {
    throw new Error('版本目录名不能为空');
  }

  if (expectedPrimaryVersion) {
    validatePrimaryVersion(expectedPrimaryVersion);

    if (name === expectedPrimaryVersion) {
      return { primaryVersion: expectedPrimaryVersion, revision: 1, legacy: true };
    }

    const prefix = `${expectedPrimaryVersion}-`;
    if (!name.startsWith(prefix)) {
      throw new Error(`版本目录 ${name} 与 primary version ${expectedPrimaryVersion} 不一致`);
    }

    const suffix = name.slice(prefix.length);
    if (!/^[1-9]\d*$/u.test(suffix)) {
      throw new Error(`版本目录 ${name} 的 compose revision 无效`);
    }

    return { primaryVersion: expectedPrimaryVersion, revision: Number(suffix), legacy: false };
  }

  const match = /^(.*)-([1-9]\d*)$/u.exec(name);
  if (!match) {
    validatePrimaryVersion(name);
    return { primaryVersion: name, revision: 1, legacy: true };
  }

  validatePrimaryVersion(match[1]);
  return { primaryVersion: match[1], revision: Number(match[2]), legacy: false };
}

// 定位 current manifest 明确指向的版本目录。
export async function findLatestReleaseDirectory(rootDirectory, manifest) {
  validateCurrentManifest(manifest);
  const applicationDirectory = path.join(rootDirectory, 'apps', manifest.application);
  const releaseDirectory = path.join(applicationDirectory, manifest.release);
  const composePath = path.join(rootDirectory, ...manifest.compose.split('/'));
  const expectedComposePath = path.join(releaseDirectory, 'docker-compose.yml');

  if (path.resolve(composePath) !== path.resolve(expectedComposePath)) {
    throw new Error(`current manifest 的 compose 路径与 release 不一致: ${manifest.compose}`);
  }

  const [releaseStat, composeStat] = await Promise.all([
    statOrNull(releaseDirectory),
    statOrNull(composePath),
  ]);

  if (!releaseStat?.isDirectory()) {
    throw new Error(`current manifest 指向的版本目录不存在: ${toPosix(path.relative(rootDirectory, releaseDirectory))}`);
  }

  if (!composeStat?.isFile()) {
    throw new Error(`current manifest 指向的 Compose 不存在: ${manifest.compose}`);
  }

  return { applicationDirectory, releaseDirectory, composePath };
}

// 按 primary/revision 规则计算下一个版本目录。
export function calculateNextReleaseVersion({
  currentPrimaryVersion,
  newPrimaryVersion,
  currentRelease,
  releaseDirectories,
  allowExistingNext = false,
}) {
  validatePrimaryVersion(currentPrimaryVersion);
  validatePrimaryVersion(newPrimaryVersion);

  const currentState = inspectRevisions(releaseDirectories, currentPrimaryVersion);
  const current = parseReleaseDirectoryName(currentRelease, currentPrimaryVersion);

  if (!currentState.revisions.has(current.revision)) {
    throw new Error(`current release ${currentRelease} 未出现在应用版本目录中`);
  }

  const nextRevisionAlreadyExists =
    allowExistingNext &&
    newPrimaryVersion === currentPrimaryVersion &&
    currentState.highestRevision === current.revision + 1 &&
    currentState.revisions.get(currentState.highestRevision) ===
      `${currentPrimaryVersion}-${currentState.highestRevision}`;

  if (current.revision !== currentState.highestRevision && !nextRevisionAlreadyExists) {
    throw new Error(
      `current release ${currentRelease} 不是 ${currentPrimaryVersion} 的最高 revision ${currentState.highestRevision}`
    );
  }

  if (newPrimaryVersion !== currentPrimaryVersion) {
    return {
      currentRevision: current.revision,
      targetRevision: 1,
      targetRelease: `${newPrimaryVersion}-1`,
      revisionGaps: currentState.gaps,
    };
  }

  const targetRevision = nextRevisionAlreadyExists
    ? currentState.highestRevision
    : currentState.highestRevision + 1;
  return {
    currentRevision: current.revision,
    targetRevision,
    targetRelease: `${currentPrimaryVersion}-${targetRevision}`,
    revisionGaps: currentState.gaps,
  };
}

// 将 branch 中的全部升级应用到 Compose 副本。
export function applyImageUpgrades(compose, upgrades) {
  if (!Array.isArray(upgrades) || upgrades.length === 0) {
    throw new Error('Renovate upgrades 必须是非空数组');
  }

  const result = structuredClone(compose);
  const updatedServices = new Set();
  const applied = [];

  for (const upgrade of upgrades) {
    validateUpgrade(upgrade);
    const service = upgrade.depType;

    if (updatedServices.has(service)) {
      throw new Error(`同一 service 出现重复升级记录: ${service}`);
    }

    const definition = result.services[service];
    if (!definition || typeof definition !== 'object' || !definition.image) {
      throw new Error(`升级记录指向不存在或没有 image 的 service: ${service}`);
    }

    const current = parseImageReference(definition.image, `${service}.image`);
    if (current.repository !== upgrade.depName) {
      throw new Error(
        `service ${service} 的镜像仓库为 ${current.repository}，与 Renovate 的 ${upgrade.depName} 不一致`
      );
    }

    if (current.tag !== upgrade.currentValue) {
      throw new Error(
        `service ${service} 的当前 tag 为 ${current.tag}，与 Renovate 的 ${upgrade.currentValue} 不一致`
      );
    }

    validatePrimaryVersion(upgrade.newValue);
    definition.image = `${current.repository}:${upgrade.newValue}${current.digest ? `@${current.digest}` : ''}`;
    updatedServices.add(service);
    applied.push({
      service,
      repository: current.repository,
      currentValue: current.tag,
      newValue: upgrade.newValue,
    });
  }

  return { compose: result, applied };
}

// 确保新目录之外的文件均未变化。
export function validateImmutableHistory(beforeSnapshot, afterSnapshot, ignoredPrefixes = []) {
  const before = filterSnapshot(beforeSnapshot, ignoredPrefixes);
  const after = filterSnapshot(afterSnapshot, ignoredPrefixes);

  if (!isDeepStrictEqual(before, after)) {
    throw new Error('检测到历史版本目录被修改、删除或重命名');
  }

  return true;
}

// 校验生成的 Compose 和 manifest 与升级计划一致。
export function validateGeneratedRelease({ sourceCompose, generatedCompose, upgrades, manifest }) {
  const expected = applyImageUpgrades(sourceCompose, upgrades).compose;

  if (!isDeepStrictEqual(expected, generatedCompose)) {
    throw new Error('新版本 Compose 与 Renovate upgrades 的预期结果不一致');
  }

  validateManifestAgainstCompose(manifest, generatedCompose);
  return true;
}

// 校验 current manifest 的结构和路径安全性。
export function validateCurrentManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('current manifest 必须是 JSON 对象');
  }

  if (manifest.schemaVersion !== 1) {
    throw new Error(`不支持的 current manifest schemaVersion: ${manifest.schemaVersion}`);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/u.test(manifest.application || '')) {
    throw new Error(`current manifest application 无效: ${manifest.application}`);
  }

  if (typeof manifest.release !== 'string' || !manifest.release) {
    throw new Error('current manifest release 不能为空');
  }

  if (
    manifest.release === '.' ||
    manifest.release === '..' ||
    manifest.release.includes('..') ||
    /[\\/\u0000-\u001f\u007f]/u.test(manifest.release) ||
    /[. ]$/u.test(manifest.release) ||
    WINDOWS_DEVICE_NAME.test(manifest.release)
  ) {
    throw new Error(`current manifest release 不是安全的目录名: ${manifest.release}`);
  }

  const expectedCompose = `apps/${manifest.application}/${manifest.release}/docker-compose.yml`;
  if (manifest.compose !== expectedCompose) {
    throw new Error(`current manifest compose 必须是 ${expectedCompose}`);
  }

  if (!Array.isArray(manifest.images) || manifest.images.length === 0) {
    throw new Error('current manifest images 必须是非空数组');
  }

  const services = new Set();
  for (const image of manifest.images) {
    if (!image || typeof image !== 'object') {
      throw new Error('current manifest image 必须是对象');
    }
    if (typeof image.service !== 'string' || !image.service || services.has(image.service)) {
      throw new Error(`current manifest service 无效或重复: ${image.service}`);
    }
    parseImageReference(`${image.repository}:${image.tag}`, `current manifest ${image.service}`);
    services.add(image.service);
  }

  return manifest;
}

// 校验 manifest 镜像顺序和仓库是否匹配 Compose service。
export function validateManifestAgainstCompose(manifest, compose, options = {}) {
  validateCurrentManifest(manifest);
  const composeImages = extractComposeImages(compose);

  if (composeImages.length !== manifest.images.length) {
    throw new Error('current manifest images 数量与 Compose 不一致');
  }

  for (let index = 0; index < composeImages.length; index += 1) {
    const actual = composeImages[index];
    const declared = manifest.images[index];
    if (actual.service !== declared.service || actual.repository !== declared.repository) {
      throw new Error(`current manifest 第 ${index + 1} 个镜像与 Compose 声明顺序不一致`);
    }
    if (!options.allowTagMismatch && actual.tag !== declared.tag) {
      throw new Error(`current manifest 中 ${declared.service} 的 tag 与 Compose 不一致`);
    }
  }

  return true;
}

// 按声明顺序提取所有有效 service image。
export function extractComposeImages(compose) {
  const images = [];
  for (const [service, definition] of Object.entries(compose.services)) {
    if (!definition || typeof definition !== 'object' || !definition.image) {
      continue;
    }
    images.push({ service, ...parseImageReference(definition.image, `${service}.image`) });
  }
  if (images.length === 0) {
    throw new Error('Compose 中不存在有效 image');
  }
  return images;
}

// 执行一次 Renovate branch 的校验、生成和持久化。
export async function runPostUpgrade({ rootDirectory, upgrades, dryRun = false }) {
  const root = path.resolve(rootDirectory);
  const packageFiles = new Set(upgrades.map((upgrade) => normalizeRepositoryPath(upgrade.packageFile)));

  if (packageFiles.size !== 1) {
    throw new Error(`一次 branch 只能更新一个 Compose control file，实际为 ${packageFiles.size} 个`);
  }

  const [controlPath] = packageFiles;
  if (!CONTROL_FILE_PATTERN.test(controlPath)) {
    throw new Error(`Renovate packageFile 不是受支持的 current manifest: ${controlPath}`);
  }

  const controlAbsolutePath = path.join(root, ...controlPath.split('/'));
  // 读取 Renovate 刚刚更新的控制状态。
  const manifest = JSON.parse(await fs.readFile(controlAbsolutePath, 'utf8'));
  validateCurrentManifest(manifest);

  const expectedControlPath = `.renovate/current/${manifest.application}.json`;
  if (controlPath !== expectedControlPath) {
    throw new Error(`current manifest 路径必须是 ${expectedControlPath}`);
  }

  for (const upgrade of upgrades) {
    validateUpgrade(upgrade);
    if (normalizeRepositoryPath(upgrade.packageFile) !== controlPath) {
      throw new Error('本次 upgrades 包含多个 Compose control file');
    }
  }

  // 定位并解析不可变的源版本。
  const current = await findLatestReleaseDirectory(root, manifest);
  const sourceText = await fs.readFile(current.composePath, 'utf8');
  const sourceCompose = parseCompose(sourceText, manifest.compose);
  validateManifestAgainstCompose(manifest, sourceCompose, { allowTagMismatch: true });
  validateRenovatedManifest(manifest, sourceCompose, upgrades);

  const alreadyApplied = upgrades.every((upgrade) => {
    const definition = sourceCompose.services[upgrade.depType];
    if (!definition?.image) return false;
    const image = parseImageReference(definition.image, `${upgrade.depType}.image`);
    return image.repository === upgrade.depName && image.tag === upgrade.newValue;
  });

  if (alreadyApplied) {
    validateManifestAgainstCompose(manifest, sourceCompose);
    const primary = findPrimaryImage(sourceCompose);
    parseReleaseDirectoryName(manifest.release, primary.tag);
    return buildPlan({
      manifest,
      sourceRelease: manifest.release,
      targetRelease: manifest.release,
      currentPrimary: primary,
      newPrimary: primary,
      currentRevision: parseReleaseDirectoryName(manifest.release, primary.tag).revision,
      targetRevision: parseReleaseDirectoryName(manifest.release, primary.tag).revision,
      upgrades,
      plannedFiles: [],
      dryRun,
      idempotent: true,
      revisionGaps: [],
    });
  }

  const partiallyApplied = upgrades.some((upgrade) => {
    const definition = sourceCompose.services[upgrade.depType];
    if (!definition?.image) return false;
    const image = parseImageReference(definition.image, `${upgrade.depType}.image`);
    return image.repository === upgrade.depName && image.tag === upgrade.newValue;
  });
  if (partiallyApplied) {
    throw new Error('current Compose 只应用了部分 Renovate upgrades，拒绝继续');
  }

  // 应用所有分组镜像升级，再计算新版本目录名。
  const currentPrimary = findPrimaryImage(sourceCompose);
  const applied = applyImageUpgrades(sourceCompose, upgrades);
  const generatedCompose = applied.compose;
  const newPrimary = findPrimaryImage(generatedCompose);
  const releaseDirectories = await listDirectories(current.applicationDirectory);
  const next = calculateNextReleaseVersion({
    currentPrimaryVersion: currentPrimary.tag,
    newPrimaryVersion: newPrimary.tag,
    currentRelease: manifest.release,
    releaseDirectories,
    allowExistingNext: true,
  });
  const targetDirectory = path.join(current.applicationDirectory, next.targetRelease);
  const targetComposePath = path.join(targetDirectory, 'docker-compose.yml');
  const sourceFiles = await listFiles(current.releaseDirectory);
  const plannedFiles = sourceFiles.map((file) =>
    toPosix(path.join('apps', manifest.application, next.targetRelease, file))
  );
  plannedFiles.push(controlPath);

  const nextManifest = {
    ...manifest,
    release: next.targetRelease,
    compose: `apps/${manifest.application}/${next.targetRelease}/docker-compose.yml`,
    images: extractComposeImages(generatedCompose).map(({ service, repository, tag }) => ({
      service,
      repository,
      tag,
    })),
  };
  const plan = buildPlan({
    manifest,
    sourceRelease: manifest.release,
    targetRelease: next.targetRelease,
    currentPrimary,
    newPrimary,
    currentRevision: next.currentRevision,
    targetRevision: next.targetRevision,
    upgrades,
    plannedFiles,
    dryRun,
    idempotent: false,
    revisionGaps: next.revisionGaps,
  });

  // dry-run 在任何磁盘修改前直接返回计划。
  if (dryRun) {
    return plan;
  }

  // 创建历史快照，防止静默修改旧版本。
  const historyBefore = await snapshotDirectory(current.applicationDirectory);
  const targetStat = await statOrNull(targetDirectory);

  if (targetStat) {
    if (!targetStat.isDirectory()) {
      throw new Error(`目标版本路径已存在但不是目录: ${next.targetRelease}`);
    }
    await validateExistingTarget({
      sourceDirectory: current.releaseDirectory,
      targetDirectory,
      expectedCompose: generatedCompose,
    });
  } else {
    await fs.cp(current.releaseDirectory, targetDirectory, { recursive: true, errorOnExist: true });
    await fs.writeFile(targetComposePath, YAML.stringify(generatedCompose), 'utf8');
  }

  const writtenCompose = parseCompose(
    await fs.readFile(targetComposePath, 'utf8'),
    nextManifest.compose
  );
  validateGeneratedRelease({
    sourceCompose,
    generatedCompose: writtenCompose,
    upgrades,
    manifest: nextManifest,
  });

  // 新版本校验成功后才更新 current 指针。
  await fs.writeFile(controlAbsolutePath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
  const historyAfter = await snapshotDirectory(current.applicationDirectory);
  const ignoredPrefix = `${next.targetRelease}/`;
  validateImmutableHistory(historyBefore, historyAfter, [ignoredPrefix]);
  return plan;
}

// 校验所有应用的 current manifest，不修改仓库。
export async function validateRepositoryCurrentManifests(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const appsDirectory = path.join(root, 'apps');
  const controlDirectory = path.join(root, '.renovate', 'current');
  const appNames = await listDirectories(appsDirectory);
  const controlFiles = (await fs.readdir(controlDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const manifests = [];

  for (const app of appNames) {
    const versionDirectories = await listDirectories(path.join(appsDirectory, app));
    const hasCompose = await anyAsync(versionDirectories, async (release) =>
      Boolean(await statOrNull(path.join(appsDirectory, app, release, 'docker-compose.yml')))
    );
    if (!hasCompose) continue;

    const expectedFile = `${app}.json`;
    if (!controlFiles.includes(expectedFile)) {
      throw new Error(`应用 ${app} 缺少 .renovate/current/${expectedFile}`);
    }

    const manifest = JSON.parse(await fs.readFile(path.join(controlDirectory, expectedFile), 'utf8'));
    const current = await findLatestReleaseDirectory(root, manifest);
    const compose = parseCompose(await fs.readFile(current.composePath, 'utf8'), manifest.compose);
    validateManifestAgainstCompose(manifest, compose);
    const primary = findPrimaryImage(compose);
    parseReleaseDirectoryName(manifest.release, primary.tag);
    manifests.push(manifest);
  }

  const expectedControlFiles = new Set(manifests.map((manifest) => `${manifest.application}.json`));
  const extras = controlFiles.filter((file) => !expectedControlFiles.has(file));
  if (extras.length > 0) {
    throw new Error(`存在没有对应应用的 current manifest: ${extras.join(', ')}`);
  }

  return manifests;
}

function inspectRevisions(releaseDirectories, primaryVersion) {
  const revisions = new Map();

  for (const name of releaseDirectories) {
    let parsed;
    try {
      parsed = parseReleaseDirectoryName(name, primaryVersion);
    } catch {
      continue;
    }

    if (revisions.has(parsed.revision)) {
      throw new Error(
        `primary version ${primaryVersion} 的 revision ${parsed.revision} 重复: ${revisions.get(parsed.revision)}, ${name}`
      );
    }
    revisions.set(parsed.revision, name);
  }

  if (revisions.size === 0) {
    throw new Error(`无法确定 ${primaryVersion} 的当前 revision`);
  }

  const highestRevision = Math.max(...revisions.keys());
  const gaps = [];
  for (let revision = 1; revision <= highestRevision; revision += 1) {
    if (!revisions.has(revision)) gaps.push(revision);
  }
  return { revisions, highestRevision, gaps };
}

function validateUpgrade(upgrade) {
  if (!upgrade || typeof upgrade !== 'object') {
    throw new Error('Renovate upgrade 必须是对象');
  }
  for (const field of ['packageFile', 'depName', 'depType', 'currentValue', 'newValue']) {
    if (typeof upgrade[field] !== 'string' || !upgrade[field]) {
      throw new Error(`Renovate upgrade 缺少字段 ${field}`);
    }
  }
}

function validateRenovatedManifest(manifest, sourceCompose, upgrades) {
  const upgradesByService = new Map(upgrades.map((upgrade) => [upgrade.depType, upgrade]));
  for (const image of extractComposeImages(sourceCompose)) {
    const declared = manifest.images.find((candidate) => candidate.service === image.service);
    const upgrade = upgradesByService.get(image.service);
    const allowedTags = new Set(upgrade ? [image.tag, upgrade.newValue] : [image.tag]);
    if (
      !declared ||
      declared.repository !== image.repository ||
      !allowedTags.has(declared.tag)
    ) {
      throw new Error(
        `current manifest 中 ${image.service} 的结果与 Renovate upgrades 不一致`
      );
    }
  }
}

async function validateExistingTarget({ sourceDirectory, targetDirectory, expectedCompose }) {
  const [sourceFiles, targetFiles] = await Promise.all([
    listFiles(sourceDirectory),
    listFiles(targetDirectory),
  ]);
  if (!isDeepStrictEqual(sourceFiles, targetFiles)) {
    throw new Error('目标版本目录已经存在，但文件集合与源版本不一致');
  }

  for (const relativeFile of sourceFiles) {
    const sourcePath = path.join(sourceDirectory, relativeFile);
    const targetPath = path.join(targetDirectory, relativeFile);
    if (relativeFile === 'docker-compose.yml') {
      const targetCompose = parseCompose(await fs.readFile(targetPath, 'utf8'), targetPath);
      if (!isDeepStrictEqual(targetCompose, expectedCompose)) {
        throw new Error('目标版本目录已经存在，但 Compose 内容不符合预期');
      }
      continue;
    }
    const [sourceContent, targetContent] = await Promise.all([
      fs.readFile(sourcePath),
      fs.readFile(targetPath),
    ]);
    if (!sourceContent.equals(targetContent)) {
      throw new Error(`目标版本目录已经存在，但 ${relativeFile} 与源版本不一致`);
    }
  }
}

async function snapshotDirectory(directory) {
  const snapshot = {};
  if (!(await statOrNull(directory))) return snapshot;
  for (const relativeFile of await listFiles(directory)) {
    const content = await fs.readFile(path.join(directory, relativeFile));
    snapshot[toPosix(relativeFile)] = createHash('sha256').update(content).digest('hex');
  }
  return snapshot;
}

function filterSnapshot(snapshot, ignoredPrefixes) {
  return Object.fromEntries(
    Object.entries(snapshot)
      .filter(([file]) => !ignoredPrefixes.some((prefix) => file.startsWith(prefix)))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

async function listFiles(directory, prefix = '') {
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relative)));
    } else if (entry.isFile()) {
      files.push(toPosix(relative));
    } else {
      throw new Error(`版本目录中不允许符号链接或特殊文件: ${relative}`);
    }
  }
  return files;
}

async function listDirectories(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function anyAsync(values, predicate) {
  for (const value of values) {
    if (await predicate(value)) return true;
  }
  return false;
}

function normalizeRepositoryPath(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('packageFile 不能为空');
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`packageFile 路径不安全: ${value}`);
  }
  return normalized;
}

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

function buildPlan({
  manifest,
  sourceRelease,
  targetRelease,
  currentPrimary,
  newPrimary,
  currentRevision,
  targetRevision,
  upgrades,
  plannedFiles,
  dryRun,
  idempotent,
  revisionGaps,
}) {
  return {
    event: 'compose-release-plan',
    dryRun,
    idempotent,
    application: manifest.application,
    sourceDirectory: `apps/${manifest.application}/${sourceRelease}`,
    primaryImage: `${currentPrimary.repository}:${currentPrimary.tag}`,
    currentPrimaryVersion: currentPrimary.tag,
    newPrimaryVersion: newPrimary.tag,
    currentRevision,
    targetRevision,
    targetDirectory: `apps/${manifest.application}/${targetRelease}`,
    plannedFiles,
    plannedImageUpdates: upgrades.map((upgrade) => ({
      service: upgrade.depType,
      repository: upgrade.depName,
      currentValue: upgrade.currentValue,
      newValue: upgrade.newValue,
    })),
    revisionGaps,
  };
}
