import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRenovatePrTitle,
  findRenovateComposePath,
} from '../.github/scripts/github/lib/renovate-pr-title.mjs';

test('只接受完整新增的单一目标版本目录', () => {
  const files = [
    { filename: 'apps/example/1.0.0-2/docker-compose.yml', status: 'added' },
    { filename: 'apps/example/1.0.0-2/data.yml', status: 'added' },
    { filename: 'apps/example/1.0.0-2/data/.gitkeep', status: 'added' },
  ];

  assert.equal(
    findRenovateComposePath(files),
    'apps/example/1.0.0-2/docker-compose.yml'
  );
  assert.equal(
    buildRenovatePrTitle({ application: 'example', release: '1.0.0-2' }),
    'chore(deps): update example tag to v1.0.0-2'
  );
});

test('历史 Compose 被修改时拒绝进入标题更新和合并流程', () => {
  assert.throws(
    () => findRenovateComposePath([
      { filename: 'apps/example/1.0.0-1/docker-compose.yml', status: 'modified' },
      { filename: 'apps/example/1.0.0-2/docker-compose.yml', status: 'added' },
    ]),
    /目标版本目录之外/u
  );
});

test('目标版本目录之外的其他文件发生变化时拒绝合并', () => {
  assert.throws(
    () => findRenovateComposePath([
      { filename: 'apps/example/1.0.0-2/docker-compose.yml', status: 'added' },
      { filename: 'apps/example/data.yml', status: 'modified' },
    ]),
    /目标版本目录之外/u
  );
});

test('没有唯一新增 Compose 时拒绝合并', () => {
  assert.throws(() => findRenovateComposePath([]), /必须且只能新增一个/u);
  assert.throws(
    () => findRenovateComposePath([
      { filename: 'apps/a/1.0.0-1/docker-compose.yml', status: 'added' },
      { filename: 'apps/b/2.0.0-1/docker-compose.yml', status: 'added' },
    ]),
    /实际为 2 个/u
  );
});
