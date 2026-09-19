import { PullRequestNotEligibleError } from './pr-validation.mjs';

export function getPullRequestTrigger(event) {
  if (event.pull_request?.number) {
    return {
      number: event.pull_request.number,
      headSha: event.pull_request.head?.sha || '',
    };
  }

  const workflowRun = event.workflow_run;
  const pullRequests = workflowRun?.pull_requests;
  if (!Array.isArray(pullRequests) || pullRequests.length !== 1 || !pullRequests[0]?.number) {
    throw new PullRequestNotEligibleError('workflow_run 事件未关联唯一的 pull request');
  }
  if (!workflowRun.head_sha) {
    throw new PullRequestNotEligibleError('workflow_run 事件缺少 head_sha');
  }

  return {
    number: pullRequests[0].number,
    headSha: workflowRun.head_sha,
  };
}
