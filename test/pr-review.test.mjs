import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, cp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  PullRequestNotEligibleError,
  validatePullRequestIdentity,
  validateRenovatePullRequest,
} from '../.github/scripts/github/lib/pr-validation.mjs';
import {
  buildRenovatePullRequestTitle,
  decideAutoMergePolicy,
  getRenovateBranchDeletionPath,
} from '../.github/scripts/github/lib/merge-policy.mjs';
import { getPullRequestTrigger } from '../.github/scripts/github/lib/workflow-event.mjs';
import {
  manualReview,
  parseLlmReview,
  requestLlmReview,
} from '../.github/scripts/github/lib/llm-review.mjs';
import { runPostUpgrade } from '../.github/scripts/renovate/lib/compose-release.mjs';

const fixtureRoot = path.resolve('test/fixtures/repository');
const auxiliaryUpgrades = JSON.parse(
  await readFile(path.resolve('test/fixtures/upgrades/auxiliary.json'), 'utf8')
);
const execFileAsync = promisify(execFile);

test('LLM review CLI initializes its GitHub client before execution', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, ['.github/scripts/github/review-renovate-pr.mjs'], {
      env: { ...process.env, GITHUB_TOKEN: '' },
    }),
    (error) => {
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      assert.match(output, /GITHUB_TOKEN 不能为空/u);
      assert.doesNotMatch(output, /Cannot access 'GitHubClient' before initialization/u);
      return true;
    }
  );
});

test('PR 触发器同时支持 pull_request 与成功 CI 的 workflow_run 事件', () => {
  assert.deepEqual(getPullRequestTrigger({
    pull_request: { number: 12, head: { sha: 'direct-head' } },
  }), { number: 12, headSha: 'direct-head' });
  assert.deepEqual(getPullRequestTrigger({
    workflow_run: {
      head_sha: 'tested-head',
      pull_requests: [{ number: 34 }],
    },
  }), { number: 34, headSha: 'tested-head' });
});

test('PR 触发器拒绝未关联或关联多个 PR 的 workflow_run 事件', () => {
  for (const pullRequests of [[], [{ number: 1 }, { number: 2 }]]) {
    assert.throws(
      () => getPullRequestTrigger({ workflow_run: { head_sha: 'tested-head', pull_requests: pullRequests } }),
      PullRequestNotEligibleError
    );
  }
});

test('Renovate 审查只在 PR 自动化测试成功后执行', async () => {
  const workflow = await readFile(path.resolve('.github/workflows/renovate-pr-review.yml'), 'utf8');
  assert.match(workflow, /workflow_run:\s*\r?\n\s+workflows: \[Automation Tests\]/u);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'pull_request'/u);
  assert.match(workflow, /Validate, review, and merge approved update/u);
});

test('只接受本仓库 renovate 分支和预期作者', () => {
  assert.equal(validatePullRequestIdentity({
    pullRequest: pullRequest(),
    repository: 'owner/repo',
    expectedAuthors: ['renovate[bot]'],
  }), true);
});

test('fork、错误分支或非预期作者不进入审查', () => {
  for (const patch of [
    { head: { repo: { full_name: 'fork/repo' }, ref: 'renovate/app' } },
    { head: { repo: { full_name: 'owner/repo' }, ref: 'feature/app' } },
    { user: { login: 'someone' } },
  ]) {
    const candidate = { ...pullRequest(), ...patch };
    assert.throws(
      () => validatePullRequestIdentity({
        pullRequest: candidate,
        repository: 'owner/repo',
        expectedAuthors: ['renovate[bot]'],
      }),
      PullRequestNotEligibleError
    );
  }
});

test('确定性校验接受正确的辅助镜像 release PR', async () => {
  const scenario = await generatedScenario();
  const report = await validateScenario(scenario);
  assert.equal(report.application, 'example');
  assert.equal(report.currentRelease, '4.2.5-1');
  assert.equal(report.targetRelease, '4.2.5-2');
  assert.equal(report.sourceDirectory, 'apps/example/4.2.5-1');
  assert.equal(report.targetDirectory, 'apps/example/4.2.5-2');
  assert.equal(report.currentRevision, 1);
  assert.equal(report.targetRevision, 2);
  assert.deepEqual(report.upgrades, [
    { service: 'redis', repository: 'redis', currentValue: '7.4.0', newValue: '7.4.1' },
  ]);
});

test('确定性校验拒绝历史版本修改', async () => {
  const scenario = await generatedScenario();
  const historicalPath = 'apps/example/4.2.5-1/data.yml';
  scenario.head.contents.set(historicalPath, 'changed: true\n');
  scenario.head.tree.set(historicalPath, entry('changed: true\n'));
  scenario.changedFiles.push({ filename: historicalPath, status: 'modified', patch: '+changed' });
  await assert.rejects(() => validateScenario(scenario), /超出.*范围|历史版本/u);
});

test('确定性校验拒绝历史目录删除和 rename', async () => {
  const scenario = await generatedScenario();
  scenario.changedFiles.push({
    filename: 'apps/example/old/data.yml',
    previous_filename: 'apps/example/4.2.5-1/data.yml',
    status: 'renamed',
    patch: '',
  });
  await assert.rejects(() => validateScenario(scenario), /禁止删除或重命名/u);
});

test('确定性校验拒绝脚本、workflow 和安全配置修改', async () => {
  for (const filename of [
    '.github/scripts/renovate/post-upgrade.mjs',
    '.github/workflows/renovate.yml',
    'renovate.json',
  ]) {
    const scenario = await generatedScenario();
    scenario.changedFiles.push({ filename, status: 'modified', patch: '+unsafe' });
    await assert.rejects(() => validateScenario(scenario), /超出.*范围/u);
  }
});

test('确定性校验拒绝不完整的新版本目录', async () => {
  const scenario = await generatedScenario();
  const missing = 'apps/example/4.2.5-2/data.yml';
  scenario.head.tree.delete(missing);
  scenario.head.contents.delete(missing);
  scenario.changedFiles = scenario.changedFiles.filter((file) => file.filename !== missing);
  await assert.rejects(() => validateScenario(scenario), /完整副本/u);
});

test('非大版本镜像更新自动合并，大版本和无法分类的 tag 转入人工审查', () => {
  const minorPolicy = decideAutoMergePolicy([
    { repository: 'example/app', currentValue: '1.2.3', newValue: '1.3.0' },
    { repository: 'example/sidecar', currentValue: '1.2.3', newValue: '1.2.4' },
  ]);
  assert.deepEqual(minorPolicy, {
    autoMerge: true,
    category: 'non-major',
    summary: '所有镜像均为非大版本更新',
  });

  const majorPolicy = decideAutoMergePolicy([
    { repository: 'example/app', currentValue: '1.2.3', newValue: '2.0.0' },
  ]);
  assert.equal(majorPolicy.autoMerge, false);
  assert.equal(majorPolicy.category, 'major');

  const unclassifiedPolicy = decideAutoMergePolicy([
    { repository: 'example/app', currentValue: 'latest', newValue: '1.2.3' },
  ]);
  assert.equal(unclassifiedPolicy.autoMerge, false);
  assert.equal(unclassifiedPolicy.category, 'unclassified');
});

test('PR 标题使用首个镜像版本和更新次数组成的 release 名称', () => {
  assert.equal(
    buildRenovatePullRequestTitle({ application: 'videobackup-next', targetRelease: '1.0.0-1' }),
    'chore(deps): update videobackup-next tag to 1.0.0-1'
  );
});

test('自动合并后仅删除受信任的 Renovate 分支', () => {
  assert.equal(
    getRenovateBranchDeletionPath('renovate/videobackup-next-tag-1.x'),
    '/git/refs/heads/renovate/videobackup-next-tag-1.x'
  );
  assert.throws(() => getRenovateBranchDeletionPath('feature/keep-me'), /只允许删除/u);
});

test('LLM approve 和 manual JSON 均可严格解析', () => {
  assert.equal(parseLlmReview(JSON.stringify({
    verdict: 'approve', summary: 'ok', risks: [], findings: [],
  })).verdict, 'approve');
  assert.equal(parseLlmReview(JSON.stringify({
    verdict: 'manual', summary: 'check', risks: ['risk'], findings: [{ file: 'a', reason: 'b' }],
  })).verdict, 'manual');
});

test('LLM 非 JSON、未知 verdict 和缺失字段全部失败关闭', () => {
  for (const response of [
    '```json\n{"verdict":"approve"}\n```',
    JSON.stringify({ verdict: 'yes', summary: 'ok', risks: [], findings: [] }),
    JSON.stringify({ verdict: 'approve', summary: 'ok' }),
  ]) {
    assert.throws(() => parseLlmReview(response));
  }
  assert.equal(manualReview('failed').verdict, 'manual');
});

test('LLM timeout 和 API failure 均抛错以进入 manual', async () => {
  const argumentsBase = {
    endpoint: 'https://example.invalid/v1',
    apiKey: 'test',
    model: 'test-model',
    messages: [],
  };
  await assert.rejects(
    () => requestLlmReview({
      ...argumentsBase,
      fetchImplementation: async () => { throw new Error('timeout'); },
    }),
    /失败或超时/u
  );
  await assert.rejects(
    () => requestLlmReview({
      ...argumentsBase,
      fetchImplementation: async () => new Response('failure', { status: 500 }),
    }),
    /HTTP 500/u
  );
});

test('Renovate 配置按 control file 分组并禁用历史 Compose 扫描', async () => {
  const config = JSON.parse(await readFile(path.resolve('renovate.json'), 'utf8'));
  assert.ok(config.extends.includes(':disableRateLimiting'));
  assert.equal(config.automerge, false);
  assert.equal(config.platformAutomerge, false);
  assert.equal(config.recreateWhen, 'always');
  assert.equal(config.branchConcurrentLimit, 0);
  assert.equal(config.prConcurrentLimit, 0);
  assert.deepEqual(config.enabledManagers, ['custom.regex']);
  assert.deepEqual(config.ignorePaths, ['apps/**']);
  const rule = config.packageRules.find((item) => item.matchManagers?.includes('custom.regex'));
  assert.equal(
    rule.groupName,
    "{{{replace '^\\.renovate/current/|\\.json$' '' packageFile}}} tag"
  );
  const titleTopic = '.renovate/current/videobackup-next.json'
    .replace(/^\.renovate\/current\/|\.json$/gu, '') + ' tag';
  assert.equal(titleTopic, 'videobackup-next tag');
  assert.equal(rule.groupSingleUpdates, true);
  assert.equal(rule.separateMajorMinor, false);
  assert.equal(rule.separateMinorPatch, false);
  assert.equal(rule.postUpgradeTasks.executionMode, 'branch');
});

test('self-hosted Renovate 只 allowlist 精确 Node 命令且关闭 shell executor', async () => {
  const config = JSON.parse(await readFile(path.resolve('.github/renovate-global.json'), 'utf8'));
  assert.equal(config.allowShellExecutorForPostUpgradeCommands, false);
  assert.deepEqual(config.allowedCommands, ['^node \\.github/scripts/renovate/post-upgrade\\.mjs$']);
});

async function generatedScenario() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'appstore-pr-fixture-'));
  await cp(fixtureRoot, root, { recursive: true });
  const base = await snapshot(root);
  await runPostUpgrade({ rootDirectory: root, upgrades: auxiliaryUpgrades });
  const head = await snapshot(root);
  const changedFiles = [];
  for (const [filename] of head.tree) {
    if (!base.tree.has(filename)) {
      changedFiles.push({ filename, status: 'added', patch: '+added' });
    } else if (base.tree.get(filename).sha !== head.tree.get(filename).sha) {
      changedFiles.push({ filename, status: 'modified', patch: '+modified' });
    }
  }
  return { base, head, changedFiles };
}

async function validateScenario(scenario) {
  return validateRenovatePullRequest({
    changedFiles: scenario.changedFiles,
    baseTree: scenario.base.tree,
    headTree: scenario.head.tree,
    readBaseText: async (file) => scenario.base.contents.get(file),
    readHeadText: async (file) => scenario.head.contents.get(file),
  });
}

async function snapshot(root) {
  const tree = new Map();
  const contents = new Map();
  await walk(root, '');
  return { tree, contents };

  async function walk(directory, prefix) {
    for (const item of await readdir(path.join(directory, prefix))) {
      const relative = path.join(prefix, item);
      const absolute = path.join(directory, relative);
      if ((await stat(absolute)).isDirectory()) {
        await walk(directory, relative);
      } else {
        const normalized = relative.replaceAll('\\', '/');
        const content = await readFile(absolute, 'utf8');
        tree.set(normalized, entry(content));
        contents.set(normalized, content);
      }
    }
  }
}

function entry(content) {
  return {
    sha: createHash('sha1').update(content).digest('hex'),
    type: 'blob',
    mode: '100644',
  };
}

function pullRequest() {
  return {
    number: 1,
    draft: false,
    user: { login: 'renovate[bot]' },
    head: { repo: { full_name: 'owner/repo' }, ref: 'renovate/example' },
  };
}
