import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  buildReviewMessages,
  manualReview,
  parseLlmReview,
  requestLlmReview,
} from '../.github/scripts/github/lib/llm-review.mjs';

const execFileAsync = promisify(execFile);

test('LLM review CLI requires a GitHub token', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, ['.github/scripts/github/review-renovate-pr.mjs'], {
      env: { ...process.env, GITHUB_TOKEN: '' },
    }),
    (error) => {
      assert.match(`${error.stdout || ''}${error.stderr || ''}`, /GITHUB_TOKEN 不能为空/u);
      return true;
    }
  );
});

test('review workflow only runs after successful PR automation tests', async () => {
  const workflow = await readFile(path.resolve('.github/workflows/renovate-pr-review.yml'), 'utf8');
  assert.match(workflow, /workflows: \[Automation Tests\]/u);
  assert.match(workflow, /conclusion == 'success'/u);
  assert.match(workflow, /event == 'pull_request'/u);
});

test('LLM verdict is the only review decision', () => {
  assert.equal(parseLlmReview('{"verdict":"approve"}').verdict, 'approve');
  assert.equal(parseLlmReview('{"verdict":"manual"}').verdict, 'manual');
  assert.equal(manualReview('failed').verdict, 'manual');
  assert.throws(() => parseLlmReview('{"verdict":"other"}'));
});

test('LLM request converts network and HTTP failures to errors', async () => {
  const options = {
    endpoint: 'https://example.invalid/v1',
    apiKey: 'test',
    model: 'test-model',
    messages: buildReviewMessages({ pullRequest: { number: 1 }, diff: '' }),
  };
  await assert.rejects(
    () => requestLlmReview({ ...options, fetchImplementation: async () => { throw new Error('timeout'); } }),
    /失败或超时/u
  );
  await assert.rejects(
    () => requestLlmReview({
      ...options,
      fetchImplementation: async () => new Response('failure', { status: 500 }),
    }),
    /HTTP 500/u
  );
});
