#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildReviewMessages,
  manualReview,
  requestLlmReview,
} from './lib/llm-review.mjs';

const reviewMarker = '<!-- renovate-compose-review -->';
const manualReviewLabel = 'needs-owner-review';
const mergeMethod = 'SQUASH';
const llmTimeoutMs = 60_000;
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const environment = process.env;

let client;
let pullRequest;

async function main() {
  for (const name of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_PATH']) {
    if (!environment[name]) throw new Error(`${name} 不能为空`);
  }

  const event = JSON.parse(await fs.readFile(environment.GITHUB_EVENT_PATH, 'utf8'));
  const workflowRun = event.workflow_run;
  const pullRequestNumber = workflowRun?.pull_requests?.[0]?.number;
  if (!pullRequestNumber) throw new Error('workflow_run 未关联 pull request');

  client = new GitHubClient({
    token: environment.GITHUB_TOKEN,
    repository: environment.GITHUB_REPOSITORY,
    apiUrl: environment.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl: environment.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
  });
  pullRequest = await client.request('GET', `/pulls/${pullRequestNumber}`);
  if (workflowRun.head_sha && pullRequest.head.sha !== workflowRun.head_sha) {
    throw new Error('pull request 在通过自动化测试后已更新，将等待新一轮测试');
  }

  await disableExistingAutoMerge(client, pullRequest);
  const changedFiles = await client.paginate(`/pulls/${pullRequest.number}/files`);
  const diff = buildDiff(changedFiles);
  const model = (await readModels(path.join(rootDirectory, '.github', 'models', 'models.txt')))[0];
  if (!model) throw new Error('没有配置 LLM model');

  const review = await requestLlmReview({
    endpoint: environment.LLM_BASE_URL,
    apiKey: environment.LLM_API_KEY,
    model,
    messages: buildReviewMessages({ pullRequest, diff }),
    timeoutMs: llmTimeoutMs,
  });

  if (review.verdict !== 'approve') {
    await handleManualReview(client, pullRequest, review);
    process.exitCode = 1;
    return;
  }

  await removeManualLabel(client, pullRequest.number);
  await upsertReviewComment(client, pullRequest.number, review);
  await mergePullRequest(client, pullRequest);
  const branchDeleted = await deletePullRequestBranch(client, pullRequest);
  console.log(JSON.stringify({
    event: 'renovate-pr-approved',
    pullRequest: pullRequest.number,
    headSha: pullRequest.head.sha,
    merged: true,
    branchDeleted,
    llmReview: review,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  const review = manualReview(`自动审查失败，已关闭自动合并并转入 owner review：${error.message}`, [error.message]);
  console.error(JSON.stringify({ event: 'renovate-pr-manual', message: error.message }));
  if (client && pullRequest) {
    try {
      await handleManualReview(client, pullRequest, review);
    } catch (publishError) {
      console.error(JSON.stringify({ event: 'manual-review-publish-failed', message: publishError.message }));
    }
  }
  process.exitCode = 1;
}

async function handleManualReview(github, pr, review) {
  await disableExistingAutoMerge(github, pr);
  await ensureLabel(github);
  await github.request('POST', `/issues/${pr.number}/labels`, { labels: [manualReviewLabel] });
  await upsertReviewComment(github, pr.number, review);
}

async function disableExistingAutoMerge(github, pr) {
  if (!pr.auto_merge) return;
  await github.graphql(
    `mutation DisableAutoMerge($pullRequestId: ID!) {
      disablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
        pullRequest { number }
      }
    }`,
    { pullRequestId: pr.node_id }
  );
}

async function mergePullRequest(github, pr) {
  const result = await github.graphql(
    `mutation MergePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod!) {
      mergePullRequest(input: {
        pullRequestId: $pullRequestId,
        expectedHeadOid: $expectedHeadOid,
        mergeMethod: $mergeMethod
      }) {
        pullRequest { number merged }
      }
    }`,
    {
      pullRequestId: pr.node_id,
      expectedHeadOid: pr.head.sha,
      mergeMethod,
    }
  );
  if (!result.mergePullRequest.pullRequest.merged) {
    throw new Error(`Pull request #${pr.number} 未完成合并`);
  }
}

async function deletePullRequestBranch(github, pr) {
  const ref = pr.head.ref.split('/').map(encodeURIComponent).join('/');
  try {
    await github.request('DELETE', `/git/refs/heads/${ref}`);
    return true;
  } catch (error) {
    if (error.status === 404) return true;
    throw error;
  }
}

async function ensureLabel(github) {
  try {
    await github.request('GET', `/labels/${encodeURIComponent(manualReviewLabel)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.request('POST', '/labels', {
      name: manualReviewLabel,
      color: 'B60205',
      description: 'Automated review failed; repository owner review is required.',
    });
  }
}

async function removeManualLabel(github, pullNumber) {
  try {
    await github.request('DELETE', `/issues/${pullNumber}/labels/${encodeURIComponent(manualReviewLabel)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function upsertReviewComment(github, pullNumber, review) {
  const comments = await github.paginate(`/issues/${pullNumber}/comments`);
  const existing = comments.find((comment) => comment.body?.includes(reviewMarker));
  const body = `${reviewMarker}\n## 容器编排自动审查\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\`\n`;
  if (existing) {
    await github.request('PATCH', `/issues/comments/${existing.id}`, { body });
  } else {
    await github.request('POST', `/issues/${pullNumber}/comments`, { body });
  }
}

function buildDiff(files) {
  return files.map((file) => [
    `diff --git a/${file.previous_filename || file.filename} b/${file.filename}`,
    `status: ${file.status}`,
    typeof file.patch === 'string' ? file.patch : '[No text patch provided by GitHub.]',
  ].join('\n')).join('\n\n');
}

async function readModels(file) {
  return [...new Set(
    (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  )];
}

class GitHubClient {
  constructor({ token, repository, apiUrl, graphqlUrl }) {
    this.apiUrl = apiUrl.replace(/\/+$/u, '');
    this.graphqlUrl = graphqlUrl;
    this.repository = repository;
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'appstore-renovate-review',
    };
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${this.apiUrl}/repos/${this.repository}${endpoint}`, {
      method,
      headers: { ...this.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${endpoint} 返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : {};
  }

  async paginate(endpoint) {
    const values = [];
    for (let page = 1; ; page += 1) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const batch = await this.request('GET', `${endpoint}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`GitHub 分页接口未返回数组: ${endpoint}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }

  async graphql(query, variables) {
    const response = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub GraphQL 返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
    const payload = JSON.parse(text);
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL 失败: ${payload.errors.map((item) => item.message).join('; ')}`);
    }
    return payload.data;
  }
}
