#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { updateRenovatePrTitle } from './lib/renovate-pr-title.mjs';

const environment = process.env;

async function main() {
  for (const name of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_PATH']) {
    if (!environment[name]) throw new Error(`${name} 不能为空`);
  }

  const event = JSON.parse(await fs.readFile(environment.GITHUB_EVENT_PATH, 'utf8'));
  const pullRequestNumber = event.pull_request?.number;
  if (!pullRequestNumber) throw new Error('pull_request 事件未关联 pull request');
  if (!event.pull_request.head?.ref?.startsWith('renovate/')) {
    throw new Error(`拒绝处理非 Renovate 分支: ${event.pull_request.head?.ref || ''}`);
  }

  const github = new GitHubClient({
    token: environment.GITHUB_TOKEN,
    repository: environment.GITHUB_REPOSITORY,
    apiUrl: environment.GITHUB_API_URL || 'https://api.github.com',
  });
  const pullRequest = await github.request('GET', `/pulls/${pullRequestNumber}`);
  const changedFiles = await github.paginate(`/pulls/${pullRequestNumber}/files`);
  const updated = await updateRenovatePrTitle({ github, pullRequest, changedFiles });
  const merged = await github.mergePullRequest(pullRequest);
  if (merged.merged !== true) {
    throw new Error(`GitHub 未合并 PR #${pullRequestNumber}: ${merged.message || '未知原因'}`);
  }
  console.log(JSON.stringify({
    event: 'renovate-pr-processed',
    pullRequest: pullRequestNumber,
    updated,
    merged: merged.merged,
    mergeSha: merged.sha,
  }));
}

class GitHubClient {
  constructor({ token, repository, apiUrl }) {
    this.apiUrl = apiUrl.replace(/\/+$/u, '');
    this.repository = repository;
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'appstore-renovate-title',
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
      throw new Error(`GitHub API ${method} ${endpoint} 返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
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

  async mergePullRequest(pullRequest) {
    return this.request('PUT', `/pulls/${pullRequest.number}/merge`, {
      sha: pullRequest.head.sha,
      merge_method: 'squash',
    });
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ event: 'renovate-pr-process-failed', message: error.message }));
  process.exitCode = 1;
}
