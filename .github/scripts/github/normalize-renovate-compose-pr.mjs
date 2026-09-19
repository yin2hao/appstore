#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sourceComposePattern = /^apps\/([a-z0-9][a-z0-9-]*)\/([^/]+)\/docker-compose\.yml$/;
const rootDirectory = process.cwd();
const baseSha = process.env.BASE_SHA || '';
const headRef = process.env.HEAD_REF || '';

try {
  validateInput(baseSha, headRef);
  const result = await normalizeRenovateBranch({ rootDirectory, baseSha, headRef });
  console.log(JSON.stringify({ event: 'renovate-compose-normalized', ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'renovate-compose-normalize-failed', message: error.message }));
  process.exitCode = 1;
}

async function normalizeRenovateBranch({ rootDirectory: root, baseSha: base, headRef: head }) {
  const temporaryWorktree = await mkdtemp(path.join(os.tmpdir(), 'appstore-renovate-normalize-'));
  let worktreeCreated = false;
  try {
    await runGit(root, ['fetch', 'origin', '+refs/heads/' + head + ':refs/remotes/origin/renovate-normalize']);
    await runGit(root, ['worktree', 'add', '--detach', temporaryWorktree, 'refs/remotes/origin/renovate-normalize']);
    worktreeCreated = true;

    const { stdout } = await runGit(temporaryWorktree, ['diff', '--name-status', base + '...HEAD']);
    const changes = parseChanges(stdout);
    const sourceChanges = changes.filter(
      (change) => change.status === 'M' && sourceComposePattern.test(change.path)
    );
    if (sourceChanges.length === 0) {
      return { normalized: false, reason: '没有需要恢复的历史 Compose 文件' };
    }
    if (sourceChanges.length !== 1) {
      throw new Error('Renovate PR 必须且只能修改一个源 Compose 文件');
    }

    const sourcePath = sourceChanges[0].path;
    const [, application] = sourceComposePattern.exec(sourcePath);
    const targetComposeAdded = changes.some((change) => {
      if (change.status !== 'A') return false;
      const match = sourceComposePattern.exec(change.path);
      return match?.[1] === application && change.path !== sourcePath;
    });
    if (!targetComposeAdded) {
      throw new Error('Renovate PR 未包含同一应用的新版本 Compose 文件');
    }

    const { stdout: baseSource } = await runGit(root, ['show', base + ':' + sourcePath]);
    await writeFile(path.join(temporaryWorktree, ...sourcePath.split('/')), baseSource, 'utf8');
    const hasChanges = await hasWorktreeChanges(temporaryWorktree, sourcePath);
    if (!hasChanges) {
      return { normalized: false, reason: '源 Compose 已与基线一致' };
    }

    await runGit(temporaryWorktree, ['add', '--', sourcePath]);
    await runGit(temporaryWorktree, [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '-m',
      'chore: restore immutable Compose source',
    ]);
    await runGit(temporaryWorktree, ['push', 'origin', 'HEAD:refs/heads/' + head]);
    return { normalized: true, sourcePath };
  } finally {
    if (worktreeCreated) {
      await runGit(root, ['worktree', 'remove', '--force', temporaryWorktree]);
    }
  }
}

function validateInput(base, head) {
  if (!/^[0-9a-f]{40}$/u.test(base)) throw new Error('BASE_SHA 格式无效');
  if (!/^renovate\/[A-Za-z0-9._/-]+$/u.test(head) || head.includes('..')) {
    throw new Error('HEAD_REF 不是安全的 renovate 分支');
  }
}

function parseChanges(output) {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split('\t');
      if (!/^[AM]$/u.test(status) || !file) {
        throw new Error('PR 包含不受支持的文件状态: ' + line);
      }
      return { status, path: file };
    });
}

async function hasWorktreeChanges(directory, file) {
  try {
    await runGit(directory, ['diff', '--quiet', '--', file]);
    return false;
  } catch (error) {
    if (error.code === 1) return true;
    throw error;
  }
}

async function runGit(directory, argumentsList) {
  return execFileAsync('git', ['-C', directory, ...argumentsList], { windowsHide: true });
}
