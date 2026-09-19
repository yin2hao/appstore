import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  getRenovateBranchDeletionPath,
} from '../.github/scripts/github/lib/merge-policy.mjs';
import { getPullRequestTrigger } from '../.github/scripts/github/lib/workflow-event.mjs';
import {
  manualReview,
  parseLlmReview,
  requestLlmReview,
} from '../.github/scripts/github/lib/llm-review.mjs';

const fixtureRoot = path.resolve('test/fixtures/repository');
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

test('新增版本目录不依赖主分支上的 current manifest', () => {
  const report = validateRenovatePullRequest({
    changedFiles: [
      { filename: 'apps/example/4.2.6-1/data.yml', status: 'added' },
      { filename: 'apps/example/4.2.6-1/docker-compose.yml', status: 'added' },
      { filename: 'apps/example/4.2.6-1/data/.gitkeep', status: 'added' },
    ],
  });
  assert.deepEqual(report, {
    application: 'example',
    targetRelease: '4.2.6-1',
    composePath: 'apps/example/4.2.6-1/docker-compose.yml',
    changedFiles: [
      'apps/example/4.2.6-1/data.yml',
      'apps/example/4.2.6-1/docker-compose.yml',
      'apps/example/4.2.6-1/data/.gitkeep',
    ],
  });
});

test('版本目录缺少 Compose 或包含多个 Compose 时失败', () => {
  assert.throws(
    () => validateRenovatePullRequest({
      changedFiles: [{ filename: 'apps/example/4.2.6-1/data.yml', status: 'added' }],
    }),
    /只能新增一个版本 Compose/u
  );
  assert.throws(
    () => validateRenovatePullRequest({
      changedFiles: [
        { filename: 'apps/example/4.2.6-1/docker-compose.yml', status: 'added' },
        { filename: 'apps/example/4.2.7-1/docker-compose.yml', status: 'added' },
      ],
    }),
    /只能新增一个版本 Compose/u
  );
});

test('PR 标题使用应用和目标 release 名称', () => {
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

test('Renovate 配置只扫描前处理选出的当前 Compose', async () => {
  const config = JSON.parse(await readFile(path.resolve('renovate.json'), 'utf8'));
  assert.ok(config.extends.includes(':disableRateLimiting'));
  assert.equal(config.automerge, false);
  assert.equal(config.platformAutomerge, false);
  assert.equal(config.recreateWhen, 'always');
  assert.equal(config.branchConcurrentLimit, 0);
  assert.equal(config.prConcurrentLimit, 0);
  assert.deepEqual(config.enabledManagers, ['custom.regex']);
  assert.equal(config.ignorePaths, undefined);
  const rule = config.packageRules.find((item) => item.matchManagers?.includes('custom.regex'));
  assert.equal(
    rule.groupName,
    "{{{replace '^apps/([^/]+)/.*$' '$1' packageFile}}} tag"
  );
  const titleTopic = 'apps/videobackup-next/1.0.0-1/docker-compose.yml'
    .replace(/^apps\/([^/]+)\/.*$/u, '$1') + ' tag';
  assert.equal(titleTopic, 'videobackup-next tag');
  assert.deepEqual(rule.matchFileNames, ['apps/*/*/docker-compose.yml']);
  const compose = await readFile(path.join(fixtureRoot, 'apps/example/4.2.5-1/docker-compose.yml'), 'utf8');
  const matches = [...compose.matchAll(new RegExp(config.customManagers[0].matchStrings[0], 'g'))];
  assert.deepEqual(
    matches.map((match) => match.groups.depType),
    ['application', 'redis', 'postgres']
  );
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

function pullRequest() {
  return {
    number: 1,
    draft: false,
    user: { login: 'renovate[bot]' },
    head: { repo: { full_name: 'owner/repo' }, ref: 'renovate/example' },
  };
}
