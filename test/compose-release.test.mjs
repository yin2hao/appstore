import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyImageUpgrades,
  calculateNextReleaseVersion,
  findPrimaryImage,
  parseCompose,
  parsePrimaryVersion,
  parseReleaseDirectoryName,
  runPostUpgrade,
  validateImmutableHistory,
  validateRepositoryCurrentManifests,
} from '../.github/scripts/renovate/lib/compose-release.mjs';

const fixtureRoot = path.resolve('test/fixtures/repository');
const upgradeRoot = path.resolve('test/fixtures/upgrades');

test('Compose 第一个 service 有 image 时识别为 primary image', () => {
  const compose = parseCompose('services:\n  app:\n    image: example/app:2.3.0\n  redis:\n    image: redis:7.4\n');
  assert.deepEqual(findPrimaryImage(compose), {
    service: 'app',
    reference: 'example/app:2.3.0',
    repository: 'example/app',
    tag: '2.3.0',
    digest: '',
  });
});

test('Compose 第一个 service 只有 build 时跳过并选择第二个 service', () => {
  const compose = parseCompose('services:\n  builder:\n    build: .\n  app:\n    image: example/app:v4.2.5\n');
  assert.equal(findPrimaryImage(compose).service, 'app');
  assert.equal(parsePrimaryVersion(findPrimaryImage(compose)), 'v4.2.5');
});

test('Compose 中完全没有 image 时失败', () => {
  const compose = parseCompose('services:\n  builder:\n    build: .\n');
  assert.throws(() => findPrimaryImage(compose), /不存在具有有效 tag/u);
});

test('非法 Compose YAML 失败', () => {
  assert.throws(() => parseCompose('services: [\n'), /无法解析 Compose YAML/u);
});

test('预发布版本和非标准合法 tag 保持原样', () => {
  for (const version of ['v4.2.5', '24.03', '2026.09', '3.1.0-beta.2', 'edge_2026']) {
    assert.equal(parsePrimaryVersion(`example/app:${version}`), version);
  }
});

test('路径不安全的 primary tag 被拒绝', () => {
  for (const version of ['..', 'a..b', 'NUL', 'bad/tag', 'bad\\tag']) {
    assert.throws(() => parsePrimaryVersion(`example/app:${version}`));
  }
});

test('旧格式目录逻辑等价 revision 1', () => {
  assert.deepEqual(parseReleaseDirectoryName('4.2.5', '4.2.5'), {
    primaryVersion: '4.2.5',
    revision: 1,
    legacy: true,
  });
});

test('辅助镜像更新增加 compose revision', () => {
  assert.deepEqual(
    calculateNextReleaseVersion({
      currentPrimaryVersion: '4.2.5',
      newPrimaryVersion: '4.2.5',
      currentRelease: '4.2.5-1',
      releaseDirectories: ['4.2.5-1'],
    }),
    { currentRevision: 1, targetRevision: 2, targetRelease: '4.2.5-2', revisionGaps: [] }
  );
});

test('多个辅助镜像更新仍只增加一次 revision', () => {
  const result = calculateNextReleaseVersion({
    currentPrimaryVersion: '4.2.5',
    newPrimaryVersion: '4.2.5',
    currentRelease: '4.2.5-2',
    releaseDirectories: ['4.2.5-1', '4.2.5-2'],
  });
  assert.equal(result.targetRelease, '4.2.5-3');
});

test('primary image 更新时 revision 重置为 1', () => {
  const result = calculateNextReleaseVersion({
    currentPrimaryVersion: '4.2.5',
    newPrimaryVersion: '4.2.6',
    currentRelease: '4.2.5-3',
    releaseDirectories: ['4.2.5-1', '4.2.5-2', '4.2.5-3'],
  });
  assert.equal(result.targetRelease, '4.2.6-1');
});

test('v 前缀、日期版本和预发布版本参与目录计算', () => {
  assert.equal(nextFor('v4.2.5', 'v4.2.6', 'v4.2.5-1'), 'v4.2.6-1');
  assert.equal(nextFor('24.03', '24.03', '24.03-1'), '24.03-2');
  assert.equal(nextFor('24.03', '24.09', '24.03-2'), '24.09-1');
  assert.equal(nextFor('3.1.0-beta.2', '3.1.0-beta.3', '3.1.0-beta.2-1'), '3.1.0-beta.3-1');
});

test('历史旧格式目录更新辅助镜像时生成 revision 2', () => {
  assert.equal(nextFor('4.2.5', '4.2.5', '4.2.5', ['4.2.5']), '4.2.5-2');
});

test('revision 缺口不会导致覆盖', () => {
  const result = calculateNextReleaseVersion({
    currentPrimaryVersion: '4.2.5',
    newPrimaryVersion: '4.2.5',
    currentRelease: '4.2.5-3',
    releaseDirectories: ['4.2.5', '4.2.5-3'],
  });
  assert.equal(result.targetRelease, '4.2.5-4');
  assert.deepEqual(result.revisionGaps, [2]);
});

test('逻辑 revision 重复时失败', () => {
  assert.throws(
    () => calculateNextReleaseVersion({
      currentPrimaryVersion: '4.2.5',
      newPrimaryVersion: '4.2.5',
      currentRelease: '4.2.5-1',
      releaseDirectories: ['4.2.5', '4.2.5-1'],
    }),
    /revision 1 重复/u
  );
});

test('current pointer 不是最高 revision 时失败', () => {
  assert.throws(
    () => calculateNextReleaseVersion({
      currentPrimaryVersion: '4.2.5',
      newPrimaryVersion: '4.2.5',
      currentRelease: '4.2.5-1',
      releaseDirectories: ['4.2.5-1', '4.2.5-2'],
    }),
    /不是.*最高 revision/u
  );
});

test('一个 Compose 的多个 image upgrades 一次性应用', () => {
  const compose = parseCompose('services:\n  app:\n    image: example/app:1.0.0\n  redis:\n    image: redis:7.4\n');
  const result = applyImageUpgrades(compose, [
    upgrade('app', 'example/app', '1.0.0', '1.0.1'),
    upgrade('redis', 'redis', '7.4', '7.5'),
  ]);
  assert.equal(result.compose.services.app.image, 'example/app:1.0.1');
  assert.equal(result.compose.services.redis.image, 'redis:7.5');
  assert.equal(result.applied.length, 2);
});

test('多个应用的 upgrades 混入同一 branch 时失败', async () => {
  const root = await copyFixture();
  const upgrades = [
    { ...upgrade('redis', 'redis', '7.4.0', '7.4.1'), packageFile: '.renovate/current/example.json' },
    { ...upgrade('other', 'example/other', '1', '2'), packageFile: '.renovate/current/other.json' },
  ];
  await assert.rejects(() => runPostUpgrade({ rootDirectory: root, upgrades }), /只能更新一个/u);
});

test('fixture dry-run 输出完整计划且不修改磁盘', async () => {
  const root = await copyFixture();
  const before = await readFile(path.join(root, '.renovate/current/example.json'), 'utf8');
  const plan = await runPostUpgrade({
    rootDirectory: root,
    upgrades: await readUpgrades('auxiliary.json'),
    dryRun: true,
  });
  assert.equal(plan.application, 'example');
  assert.equal(plan.sourceDirectory, 'apps/example/4.2.5-1');
  assert.equal(plan.targetDirectory, 'apps/example/4.2.5-2');
  assert.equal(plan.currentPrimaryVersion, '4.2.5');
  assert.equal(plan.newPrimaryVersion, '4.2.5');
  assert.equal(plan.plannedImageUpdates.length, 1);
  assert.equal(await readFile(path.join(root, '.renovate/current/example.json'), 'utf8'), before);
  await assert.rejects(() => readFile(path.join(root, 'apps/example/4.2.5-2/docker-compose.yml')));
});

test('辅助镜像更新创建新目录并保持历史目录 immutable', async () => {
  const root = await copyFixture();
  const sourcePath = path.join(root, 'apps/example/4.2.5-1/docker-compose.yml');
  const before = await readFile(sourcePath, 'utf8');
  await runPostUpgrade({ rootDirectory: root, upgrades: await readUpgrades('auxiliary.json') });
  const generated = parseCompose(
    await readFile(path.join(root, 'apps/example/4.2.5-2/docker-compose.yml'), 'utf8')
  );
  assert.equal(generated.services.redis.image, 'redis:7.4.1');
  assert.equal(generated.services.application.image, 'example/app:4.2.5');
  assert.equal(await readFile(sourcePath, 'utf8'), before);
});

test('多个辅助镜像更新只创建一个新目录', async () => {
  const root = await copyFixture();
  const plan = await runPostUpgrade({
    rootDirectory: root,
    upgrades: await readUpgrades('multiple-auxiliary.json'),
  });
  assert.equal(plan.targetDirectory, 'apps/example/4.2.5-2');
  const generated = parseCompose(
    await readFile(path.join(root, 'apps/example/4.2.5-2/docker-compose.yml'), 'utf8')
  );
  assert.equal(generated.services.redis.image, 'redis:7.4.1');
  assert.equal(generated.services.postgres.image, 'postgres:17.5');
});

test('primary 与 auxiliary 同时更新时创建新主版本 revision 1', async () => {
  const root = await copyFixture();
  const plan = await runPostUpgrade({
    rootDirectory: root,
    upgrades: await readUpgrades('primary-and-auxiliary.json'),
  });
  assert.equal(plan.targetDirectory, 'apps/example/4.2.6-1');
});

test('重复执行 postUpgradeTasks 是幂等的', async () => {
  const root = await copyFixture();
  const upgrades = await readUpgrades('auxiliary.json');
  await runPostUpgrade({ rootDirectory: root, upgrades });
  const second = await runPostUpgrade({ rootDirectory: root, upgrades });
  assert.equal(second.idempotent, true);
  assert.equal(second.targetDirectory, 'apps/example/4.2.5-2');
});

test('目标目录已存在且内容不符合预期时失败', async () => {
  const root = await copyFixture();
  const target = path.join(root, 'apps/example/4.2.5-2');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'docker-compose.yml'), 'services: {}\n');
  const upgrades = await readUpgrades('auxiliary.json');
  await assert.rejects(
    () => runPostUpgrade({ rootDirectory: root, upgrades }),
    /文件集合.*不一致|Compose 内容不符合预期/u
  );
});

test('缺少 metadata 时仓库校验失败', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'appstore-missing-metadata-'));
  await mkdir(path.join(root, 'apps/example/1.0.0'), { recursive: true });
  await mkdir(path.join(root, '.renovate/current'), { recursive: true });
  await writeFile(path.join(root, 'apps/example/1.0.0/docker-compose.yml'), 'services:\n  app:\n    image: app:1.0.0\n');
  await assert.rejects(() => validateRepositoryCurrentManifests(root), /缺少/u);
});

test('版本目录为空时失败', async () => {
  const root = await copyFixture();
  const manifestPath = path.join(root, '.renovate/current/example.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.release = 'empty';
  manifest.compose = 'apps/example/empty/docker-compose.yml';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(path.join(root, 'apps/example/empty'));
  const upgrades = await readUpgrades('auxiliary.json');
  await assert.rejects(
    () => runPostUpgrade({ rootDirectory: root, upgrades }),
    /Compose 不存在/u
  );
});

test('immutable history 快照检测修改和删除', () => {
  assert.throws(
    () => validateImmutableHistory({ '1/a': 'x' }, { '1/a': 'y' }),
    /历史版本目录/u
  );
});

function nextFor(currentPrimaryVersion, newPrimaryVersion, currentRelease, releaseDirectories = [currentRelease]) {
  return calculateNextReleaseVersion({
    currentPrimaryVersion,
    newPrimaryVersion,
    currentRelease,
    releaseDirectories,
  }).targetRelease;
}

function upgrade(depType, depName, currentValue, newValue) {
  return {
    packageFile: '.renovate/current/example.json',
    depName,
    depType,
    currentValue,
    newValue,
  };
}

async function copyFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'appstore-fixture-'));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function readUpgrades(file) {
  return JSON.parse(await readFile(path.join(upgradeRoot, file), 'utf8'));
}
