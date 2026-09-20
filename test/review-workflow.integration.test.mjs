import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('审查工作流 approve 分支完成评论、合并和删除分支', async () => {
  const result = await runReviewWorkflow('approve');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /renovate-pr-approved/u);
  assert.ok(result.calls.some((call) => call.method === 'POST' && call.url.endsWith('/issues/7/comments')));
  assert.ok(result.calls.some((call) => call.graphql?.includes('mergePullRequest')));
  assert.ok(result.calls.some((call) => call.method === 'DELETE' && call.url.includes('/git/refs/heads/')));
});

test('审查工作流 manual 分支只加标签和评论，不合并', async () => {
  const result = await runReviewWorkflow('manual');
  assert.notEqual(result.code, 0, result.output);
  assert.ok(result.calls.some((call) => call.method === 'POST' && call.url.endsWith('/labels')));
  assert.ok(result.calls.some((call) => call.method === 'POST' && call.url.endsWith('/issues/7/comments')));
  assert.equal(result.calls.filter((call) => call.graphql?.includes('mergePullRequest')).length, 0);
  assert.equal(result.calls.filter((call) => call.method === 'DELETE' && call.url.includes('/git/refs/heads/')).length, 0);
});

async function runReviewWorkflow(verdict) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await readRequestBody(request);
    const call = { method: request.method, url: url.pathname, body };
    if (body?.query) call.graphql = body.query;
    calls.push(call);

    if (url.pathname === '/llm/chat/completions') {
      return sendJson(response, 200, {
        choices: [{ message: { content: JSON.stringify({ verdict, summary: verdict, risks: [], findings: [] }) } }],
      });
    }
    if (url.pathname === '/graphql') {
      if (body.query.includes('mergePullRequest')) {
        return sendJson(response, 200, {
          data: { mergePullRequest: { pullRequest: { number: 7, merged: true } } },
        });
      }
      return sendJson(response, 200, { data: { disablePullRequestAutoMerge: { pullRequest: { number: 7 } } } });
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/pulls/7') {
      return sendJson(response, 200, {
        number: 7,
        title: 'Renovate update',
        body: '',
        node_id: 'pull-request-node-id',
        auto_merge: null,
        head: { sha: 'tested-head', ref: 'renovate/example' },
      });
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/pulls/7/files') {
      return sendJson(response, 200, [{
        filename: 'apps/example/1.0.0/docker-compose.yml',
        status: 'added',
        patch: '+ image: example/app:1.0.0',
      }]);
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/issues/7/comments') {
      return sendJson(response, 200, []);
    }
    if (request.method === 'GET' && url.pathname === '/repos/owner/repo/labels/needs-owner-review') {
      return sendJson(response, verdict === 'manual' ? 404 : 200, {});
    }
    if (request.method === 'DELETE' && url.pathname.includes('/labels/needs-owner-review')) {
      return sendJson(response, 204, null);
    }
    if (request.method === 'DELETE' && url.pathname.includes('/git/refs/heads/')) {
      return sendJson(response, 204, null);
    }
    if (request.method === 'POST' && url.pathname === '/repos/owner/repo/labels') {
      return sendJson(response, 201, {});
    }
    if (request.method === 'POST' && url.pathname === '/repos/owner/repo/issues/7/labels') {
      return sendJson(response, 200, []);
    }
    if (request.method === 'POST' && url.pathname === '/repos/owner/repo/issues/7/comments') {
      return sendJson(response, 201, { id: 1 });
    }
    return sendJson(response, 404, { message: `Unhandled mock route: ${request.method} ${url.pathname}` });
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'appstore-review-workflow-'));
  const eventPath = path.join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({
    workflow_run: {
      head_sha: 'tested-head',
      pull_requests: [{ number: 7 }],
    },
  }), 'utf8');

  try {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const result = await execFileAsync(process.execPath, ['.github/scripts/github/review-renovate-pr.mjs'], {
        env: {
          ...process.env,
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_API_URL: baseUrl,
          GITHUB_GRAPHQL_URL: `${baseUrl}/graphql`,
          LLM_BASE_URL: `${baseUrl}/llm`,
          LLM_API_KEY: 'test-key',
        },
      });
      return { code: 0, output: `${result.stdout}${result.stderr}`, calls };
    } catch (error) {
      return {
        code: error.code,
        output: `${error.stdout || ''}${error.stderr || ''}`,
        calls,
      };
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : null);
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, body === null ? undefined : { 'Content-Type': 'application/json' });
  response.end(body === null ? undefined : JSON.stringify(body));
}
