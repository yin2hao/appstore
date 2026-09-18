#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PullRequestNotEligibleError,
  validatePullRequestIdentity,
  validateRenovatePullRequest,
} from './lib/pr-validation.mjs';
import {
  buildReviewMessages,
  manualReview,
  requestLlmReview,
} from './lib/llm-review.mjs';

const reviewMarker = '<!-- renovate-compose-review -->';
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const environment = process.env;

let client;
let pullRequest;
let configuration;
let baseTree;

try {
  for (const name of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_PATH']) {
    if (!environment[name]) throw new Error(`${name} 不能为空`);
  }

  const event = JSON.parse(await fs.readFile(environment.GITHUB_EVENT_PATH, 'utf8'));
  if (!event.pull_request?.number) {
    throw new PullRequestNotEligibleError('事件中没有 pull_request');
  }

  configuration = JSON.parse(
    await fs.readFile(path.join(rootDirectory, '.github', 'renovate-automation.json'), 'utf8')
  );
  client = new GitHubClient({
    token: environment.GITHUB_TOKEN,
    repository: environment.GITHUB_REPOSITORY,
    apiUrl: environment.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl: environment.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
  });
  pullRequest = await client.request('GET', `/pulls/${event.pull_request.number}`);
  validatePullRequestIdentity({
    pullRequest,
    repository: environment.GITHUB_REPOSITORY,
    expectedAuthors: configuration.expectedAuthors,
  });

  await disableExistingAutoMerge(client, pullRequest);

  const [changedFiles, loadedBaseTree, headTree] = await Promise.all([
    client.paginate(`/pulls/${pullRequest.number}/files`),
    client.getTree(pullRequest.base.sha),
    client.getTree(pullRequest.head.sha),
  ]);
  baseTree = loadedBaseTree;
  const baseReader = createTreeReader(client, baseTree);
  const headReader = createTreeReader(client, headTree);
  const deterministicReport = await validateRenovatePullRequest({
    changedFiles,
    baseTree,
    headTree,
    readBaseText: baseReader,
    readHeadText: headReader,
  });
  const diff = buildCompleteDiff(changedFiles, configuration.maxDiffLength);
  const models = await readModels(path.join(rootDirectory, '.github', 'models', 'models.txt'));
  if (models.length === 0) throw new Error('没有配置 LLM model');

  const review = await requestLlmReview({
    endpoint: environment.LLM_BASE_URL,
    apiKey: environment.LLM_API_KEY,
    model: models[0],
    messages: buildReviewMessages({ pullRequest, deterministicReport, diff }),
    timeoutMs: configuration.llmTimeoutMs,
  });

  if (review.verdict !== 'approve') {
    await handleManualReview({ client, pullRequest, configuration, review, deterministicReport, baseTree });
    process.exitCode = 1;
  } else {
    await removeManualLabel(client, pullRequest.number, configuration.manualReviewLabel);
    await upsertReviewComment(client, pullRequest.number, review, deterministicReport);
    await client.graphql(
      `mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod}) {
          pullRequest { number }
        }
      }`,
      { pullRequestId: pullRequest.node_id, mergeMethod: configuration.mergeMethod }
    );
    console.log(JSON.stringify({
      event: 'renovate-pr-approved',
      pullRequest: pullRequest.number,
      headSha: pullRequest.head.sha,
      autoMerge: 'enabled',
      deterministicReport,
      llmReview: review,
    }, null, 2));
  }
} catch (error) {
  if (error instanceof PullRequestNotEligibleError) {
    console.log(JSON.stringify({ event: 'renovate-pr-skipped', message: error.message }));
  } else {
    const review = manualReview(
      `自动审查失败，已关闭自动合并并转入 owner review：${error.message}`,
      [error.message]
    );
    console.error(JSON.stringify({ event: 'renovate-pr-manual', message: error.message }));
    if (client && pullRequest) {
      try {
        await handleManualReview({ client, pullRequest, configuration, review, baseTree });
      } catch (publishError) {
        console.error(JSON.stringify({ event: 'manual-review-publish-failed', message: publishError.message }));
      }
    }
    process.exitCode = 1;
  }
}

async function handleManualReview({ client: github, pullRequest: pr, configuration: config, review, deterministicReport, baseTree }) {
  await disableExistingAutoMerge(github, pr);
  await ensureLabel(github, config.manualReviewLabel);
  await github.request('POST', `/issues/${pr.number}/labels`, { labels: [config.manualReviewLabel] });
  const codeOwnersPath = findCodeOwners(baseTree);
  const report = {
    ...review,
    summary: codeOwnersPath
      ? `${review.summary}。仓库存在 ${codeOwnersPath}，GitHub 将按 base branch 的 CODEOWNERS 规则请求审查。`
      : review.summary,
  };
  await upsertReviewComment(github, pr.number, report, deterministicReport);
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

async function ensureLabel(github, label) {
  try {
    await github.request('GET', `/labels/${encodeURIComponent(label)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.request('POST', '/labels', {
      name: label,
      color: 'B60205',
      description: 'Automated review failed closed; repository owner review is required.',
    });
  }
}

async function removeManualLabel(github, pullNumber, label) {
  try {
    await github.request('DELETE', `/issues/${pullNumber}/labels/${encodeURIComponent(label)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function upsertReviewComment(github, pullNumber, review, deterministicReport) {
  const comments = await github.paginate(`/issues/${pullNumber}/comments`);
  const existing = comments.find((comment) => comment.body?.includes(reviewMarker));
  const body = `${reviewMarker}
## 容器编排自动审查

\`\`\`json
${JSON.stringify({ ...review, deterministic: deterministicReport || null }, null, 2)}
\`\`\`
`;
  if (existing) {
    await github.request('PATCH', `/issues/comments/${existing.id}`, { body });
  } else {
    await github.request('POST', `/issues/${pullNumber}/comments`, { body });
  }
}

function createTreeReader(github, tree) {
  const cache = new Map();
  return async (file) => {
    if (cache.has(file)) return cache.get(file);
    const entry = tree.get(file);
    if (!entry || entry.type !== 'blob') throw new Error(`Git tree 中找不到文件: ${file}`);
    const text = await github.getBlobText(entry.sha);
    cache.set(file, text);
    return text;
  };
}

function buildCompleteDiff(files, maximumLength) {
  const chunks = [];
  let length = 0;
  for (const file of files) {
    if (typeof file.patch !== 'string') {
      throw new Error(`GitHub 没有返回 ${file.filename} 的完整文本 patch`);
    }
    const chunk = [
      `diff --git a/${file.previous_filename || file.filename} b/${file.filename}`,
      `status: ${file.status}`,
      file.patch,
    ].join('\n');
    length += chunk.length;
    if (length > maximumLength) {
      throw new Error(`PR diff 超过 LLM 审查上限 ${maximumLength} 字符`);
    }
    chunks.push(chunk);
  }
  return chunks.join('\n\n');
}

async function readModels(file) {
  return [...new Set(
    (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  )];
}

function findCodeOwners(tree) {
  for (const file of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    if (tree?.has(file)) return file;
  }
  return '';
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

  async getTree(sha) {
    const response = await this.request('GET', `/git/trees/${sha}?recursive=1`);
    if (response.truncated) throw new Error(`Git tree ${sha} 被 GitHub 截断，无法安全审查`);
    return new Map(
      response.tree
        .filter((entry) => entry.type === 'blob')
        .map((entry) => [entry.path, { sha: entry.sha, type: entry.type, mode: entry.mode }])
    );
  }

  async getBlobText(sha) {
    const blob = await this.request('GET', `/git/blobs/${sha}`);
    if (blob.encoding !== 'base64') throw new Error(`Git blob ${sha} 使用未知编码 ${blob.encoding}`);
    return Buffer.from(blob.content.replace(/\n/gu, ''), 'base64').toString('utf8');
  }
}
