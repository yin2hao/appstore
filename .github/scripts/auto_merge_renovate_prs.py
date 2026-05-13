import json
import os
import re
import time
import urllib.parse
import zipfile
import requests
from typing import Optional, Dict, Any

GITHUB_TOKEN = os.getenv('GITHUB_TOKEN')
REPOSITORY = os.getenv('GITHUB_REPOSITORY')
EVENT_NAME = os.getenv('GITHUB_EVENT_NAME', '')
EVENT_PATH = os.getenv('GITHUB_EVENT_PATH', '')
TRIGGER_PR_NUMBER = os.getenv('TRIGGER_PR_NUMBER', '').strip()
LLM_DECISION_MARKER = '<!-- llm-code-review-merge-decision -->'
LLM_PR_METADATA_ARTIFACT = 'llm-review-pr-metadata'
LLM_PR_METADATA_FILE = 'llm-review-pr-metadata.json'
APPROVED_DECISION = 'APPROVED'
HEADERS = {
    'Authorization': f'Bearer {GITHUB_TOKEN}',
    'Accept': 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28'
}

def github_request(method: str, path: str, **kwargs):
    url = f'https://api.github.com/repos/{REPOSITORY}{path}'
    response = requests.request(method, url, headers=HEADERS, **kwargs)
    response.raise_for_status()
    return response.json() if response.text else {}

def github_paginated(path: str) -> list:
    results = []
    page = 1

    while True:
        separator = '&' if '?' in path else '?'
        batch = github_request('GET', f'{path}{separator}per_page=100&page={page}')

        if not isinstance(batch, list):
            return batch

        results.extend(batch)

        if len(batch) < 100:
            return results

        page += 1

def github_request_raw(method: str, url: str, **kwargs):
    response = requests.request(method, url, headers=HEADERS, **kwargs)
    response.raise_for_status()
    return response

def get_workflow_run_pr_number() -> str:
    if TRIGGER_PR_NUMBER:
        return TRIGGER_PR_NUMBER

    if EVENT_NAME != 'workflow_run' or not EVENT_PATH:
        return ''

    try:
        with open(EVENT_PATH, encoding='utf-8') as event_file:
            event = json.load(event_file)
    except Exception as exc:
        print(f"读取 workflow_run 事件失败: {exc}")
        return ''

    workflow_run = event.get('workflow_run', {})
    pull_requests = workflow_run.get('pull_requests') or []

    metadata_pr_number = get_workflow_run_pr_number_by_artifact(workflow_run)

    if metadata_pr_number:
        print(f"通过 {LLM_PR_METADATA_ARTIFACT} artifact 定位到 PR #{metadata_pr_number}")
        return metadata_pr_number

    if pull_requests:
        pr_number = str(pull_requests[0].get('number') or '')

        if pr_number and is_renovate_pr(get_pr(int(pr_number))):
            return pr_number

        print(f"workflow_run 关联的 PR #{pr_number} 不是自动合并目标，跳过处理")
        return ''

    return get_workflow_run_pr_number_by_head(workflow_run)

def get_workflow_run_pr_number_by_artifact(workflow_run: Dict[str, Any]) -> str:
    """从 LLM Code Review 上传的 artifact 读取它实际审查的 PR"""
    run_id = workflow_run.get('id')

    if not run_id:
        print("workflow_run 事件没有 run id，无法下载 PR metadata artifact")
        return ''

    artifacts = github_paginated(f'/actions/runs/{run_id}/artifacts')

    if isinstance(artifacts, dict):
        artifact_items = artifacts.get('artifacts') or []
    else:
        artifact_items = artifacts

    metadata_artifacts = [
        artifact for artifact in artifact_items
        if artifact.get('name') == LLM_PR_METADATA_ARTIFACT and not artifact.get('expired')
    ]

    if not metadata_artifacts:
        print(f"LLM workflow run {run_id} 未找到 {LLM_PR_METADATA_ARTIFACT} artifact")
        return ''

    artifact = sorted(
        metadata_artifacts,
        key=lambda item: item.get('created_at') or '',
        reverse=True
    )[0]
    download_url = artifact.get('archive_download_url')

    if not download_url:
        print(f"{LLM_PR_METADATA_ARTIFACT} artifact 没有下载地址")
        return ''

    response = github_request_raw('GET', download_url)

    try:
        archive_path = '/tmp/llm-review-pr-metadata.zip'
        with open(archive_path, 'wb') as archive_file:
            archive_file.write(response.content)

        with zipfile.ZipFile(archive_path) as archive:
            with archive.open(LLM_PR_METADATA_FILE) as metadata_file:
                metadata = json.load(metadata_file)
    except Exception as exc:
        print(f"读取 {LLM_PR_METADATA_ARTIFACT} artifact 失败: {exc}")
        return ''

    pr_number = str(metadata.get('number') or '')

    if not pr_number:
        print(f"{LLM_PR_METADATA_ARTIFACT} artifact 未包含 PR 编号")
        return ''

    return pr_number

def get_workflow_run_pr_number_by_head(workflow_run: Dict[str, Any]) -> str:
    """workflow_run 有时没有 pull_requests，按 head branch/head sha 反查 PR"""
    head_branch = workflow_run.get('head_branch') or ''
    head_sha = workflow_run.get('head_sha') or ''
    head_repository = (workflow_run.get('head_repository') or {}).get('full_name') or ''

    if not head_branch:
        print("workflow_run 事件没有 head_branch，无法反查 PR")
        return ''

    if head_repository and head_repository != REPOSITORY:
        print(f"workflow_run head repository {head_repository} 不是 {REPOSITORY}，跳过处理")
        return ''

    owner = REPOSITORY.split('/')[0]
    head_query = urllib.parse.quote(f'{owner}:{head_branch}', safe='')
    candidates = github_paginated(f'/pulls?state=open&head={head_query}')

    if not candidates:
        print(f"未找到 head branch 为 {head_branch} 的打开 PR")
        return ''

    if head_sha:
        matching_sha_prs = [
            pr for pr in candidates
            if pr.get('head', {}).get('sha') == head_sha
        ]

        if len(matching_sha_prs) == 1:
            pr = matching_sha_prs[0]

            if not is_renovate_pr(pr):
                pr_number = str(pr.get('number') or '')
                print(f"workflow_run head_sha 反查到非自动合并 PR #{pr_number}，跳过处理")
                return ''

            pr_number = str(pr.get('number') or '')
            print(f"通过 workflow_run head_sha 反查到 PR #{pr_number}")
            return pr_number

        if len(matching_sha_prs) > 1:
            numbers = ', '.join(str(pr.get('number')) for pr in matching_sha_prs)
            print(f"workflow_run head_sha 匹配多个 PR: {numbers}，跳过处理")
            return ''

    if len(candidates) == 1:
        if not is_renovate_pr(candidates[0]):
            pr_number = str(candidates[0].get('number') or '')
            print(f"workflow_run head_branch 反查到非自动合并 PR #{pr_number}，跳过处理")
            return ''

        pr_number = str(candidates[0].get('number') or '')
        print(f"通过 workflow_run head_branch 反查到 PR #{pr_number}")
        return pr_number

    numbers = ', '.join(str(pr.get('number')) for pr in candidates)
    print(f"workflow_run head branch {head_branch} 匹配多个 PR: {numbers}，跳过处理")
    return ''

def get_pr(pr_number: int) -> Dict[str, Any]:
    """获取单个 PR"""
    return github_request('GET', f'/pulls/{pr_number}')

def get_prs() -> list:
    """获取所有打开的PR列表"""
    trigger_pr_number = get_workflow_run_pr_number()

    if trigger_pr_number:
        print(f"由 LLM Code Review 触发，仅处理 PR #{trigger_pr_number}")
        return [get_pr(int(trigger_pr_number))]

    if EVENT_NAME == 'workflow_run':
        print("workflow_run 事件未包含 PR 编号，跳过处理")
        return []

    return github_paginated('/pulls?state=open')

def is_renovate_pr(pr: Dict[str, Any]) -> bool:
    """检查PR是否来自Renovate"""
    head_ref = pr.get('head', {}).get('ref', '')
    head_repo = pr.get('head', {}).get('repo', {}).get('full_name', '')
    return head_repo == REPOSITORY and head_ref.startswith('renovate/')

def parse_version_update(pr_body: str) -> Optional[str]:
    """解析PR正文，确定更新类型"""
    lines = pr_body.split('\n')
    in_table = False

    for line in lines:
        if re.search(r'^\s*\|.*Package.*Update.*Change.*\|\s*$', line, re.IGNORECASE):
            in_table = True
            continue

        if in_table and re.search(r'^\s*\|[-:|]+\|\s*$', line):
            continue

        if in_table and line.strip().startswith('|'):
            cells = [cell.strip() for cell in line.split('|') if cell.strip()]

            if len(cells) >= 3:
                update_type = cells[1].lower()

                if update_type == 'major':
                    return 'major'
                elif update_type in ['minor', 'patch']:
                    return update_type

                change_cell = cells[2]
                version_pattern = r'(\d+\.\d+\.\d+|\d+\.\d+|\d+)'
                versions = re.findall(version_pattern, change_cell)

                if len(versions) >= 2:
                    old_parts = versions[0].split('.')
                    new_parts = versions[1].split('.')

                    if old_parts[0] != new_parts[0]:
                        return 'major'
                    elif len(old_parts) > 1 and len(new_parts) > 1 and old_parts[1] != new_parts[1]:
                        return 'minor'
                    else:
                        return 'patch'
        elif in_table and not line.strip().startswith('|'):
            break

    return None

def is_rebase_checkbox_unchecked(pr_body: str) -> bool:
    """
    检查 PR body 中的 rebase checkbox 是否存在且未勾选。
    Renovate 在 PR body 中插入如下格式的行：
      - [ ] <!-- rebase-check --> If you want to rebase/retry this PR, check this box.
    勾选后变为：
      - [x] <!-- rebase-check --> If you want to rebase/retry this PR, check this box.
    """
    # 匹配未勾选状态
    unchecked_pattern = r'-\s*\[\s*\]\s*<!--\s*rebase-check\s*-->'
    return bool(re.search(unchecked_pattern, pr_body, re.IGNORECASE))

def trigger_renovate_rebase(pr_number: int, pr_body: str) -> bool:
    """
    通过将 PR body 中的 rebase checkbox 从未勾选改为勾选，
    触发 Renovate 自动 rebase/retry。
    返回是否成功更新。
    """
    unchecked_pattern = r'(-\s*\[)\s*(\]\s*<!--\s*rebase-check\s*-->)'
    new_body = re.sub(
        unchecked_pattern,
        r'\1x\2',
        pr_body,
        flags=re.IGNORECASE
    )

    if new_body == pr_body:
        print(f"PR #{pr_number} 未找到可勾选的 rebase checkbox，无法触发 rebase")
        return False

    data = {'body': new_body}
    url = f'https://api.github.com/repos/{REPOSITORY}/pulls/{pr_number}'
    response = requests.patch(url, headers=HEADERS, json=data)

    if response.status_code == 200:
        print(f"PR #{pr_number} 已勾选 rebase checkbox，Renovate 将自动触发 rebase/retry")
        return True
    else:
        print(f"PR #{pr_number} 更新 body 失败: {response.status_code} {response.text}")
        return False

def get_llm_merge_decision(pr_number: int) -> Optional[Dict[str, str]]:
    """读取 LLM 审查在 PR 评论中写入的合并判定"""
    comments = github_paginated(f'/issues/{pr_number}/comments')

    for comment in reversed(comments):
        body = comment.get('body') or ''

        if LLM_DECISION_MARKER not in body:
            continue

        sha_match = re.search(r'LLM_REVIEW_HEAD_SHA:\s*([0-9a-f]{40})', body, re.IGNORECASE)
        decision_match = re.search(
            r'LLM_MERGE_DECISION:\s*(APPROVED|CHANGES_REQUESTED)\b',
            body,
            re.IGNORECASE
        )

        return {
            'head_sha': sha_match.group(1) if sha_match else '',
            'decision': decision_match.group(1).upper() if decision_match else '',
            'comment_id': str(comment.get('id') or '')
        }

    return None

def is_llm_approved_for_merge(pr_number: int, head_sha: str) -> bool:
    """只有 LLM 对当前 head 明确 APPROVED 才允许自动合并"""
    decision = get_llm_merge_decision(pr_number)

    if not decision:
        print(f"PR #{pr_number} 未找到 LLM 合并判定标志，跳过自动合并")
        return False

    if decision['head_sha'] != head_sha:
        print(
            f"PR #{pr_number} 的 LLM 判定对应 {decision['head_sha']}，"
            f"当前 head 为 {head_sha}，跳过自动合并"
        )
        return False

    if decision['decision'] != APPROVED_DECISION:
        print(f"PR #{pr_number} 的 LLM 判定为 {decision['decision']}，跳过自动合并")
        return False

    return True

def is_pr_mergeable(pr_data: Dict[str, Any]) -> bool:
    """检查PR是否可以合并"""
    return pr_data.get('mergeable', False) and pr_data.get('mergeable_state', '') == 'clean'

def wait_for_checks(pr_number: int, max_wait: int = 600) -> Optional[Dict[str, Any]]:
    """等待检查通过，最多等待max_wait秒"""
    start_time = time.time()

    while time.time() - start_time < max_wait:
        pr_data = get_pr(pr_number)

        if is_pr_mergeable(pr_data):
            return pr_data

        time.sleep(30)

    return None

def merge_pr(pr_number: int, head_sha: str) -> bool:
    """压缩合并 PR"""
    url = f'https://api.github.com/repos/{REPOSITORY}/pulls/{pr_number}/merge'
    data = {'merge_method': 'squash', 'sha': head_sha}

    response = requests.put(url, headers=HEADERS, json=data)

    if response.status_code == 200:
        print(f"成功压缩合并PR #{pr_number}")
        return True
    else:
        print(f"合并PR #{pr_number} 失败: {response.json().get('message', '未知错误')}")
        return False

def delete_head_branch(pr_number: int, head_ref: str, head_sha: str) -> bool:
    """删除已合并 PR 的同仓库 head 分支"""
    if not head_ref:
        print(f"PR #{pr_number} 未找到 head 分支名，跳过删除分支")
        return False

    encoded_ref = urllib.parse.quote(f'heads/{head_ref}', safe='/')
    get_ref_path = f'/git/ref/{encoded_ref}'
    delete_ref_path = f'/git/refs/{encoded_ref}'

    try:
        current_ref = github_request('GET', get_ref_path)
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            print(f"PR #{pr_number} 的 head 分支 {head_ref} 已不存在")
            return True

        print(f"读取 PR #{pr_number} head 分支 {head_ref} 失败: {exc}")
        return False

    current_sha = current_ref.get('object', {}).get('sha', '')

    if current_sha != head_sha:
        print(
            f"PR #{pr_number} head 分支 {head_ref} 已变化，"
            f"当前为 {current_sha}，合并时为 {head_sha}，跳过删除"
        )
        return False

    try:
        github_request('DELETE', delete_ref_path)
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            print(f"PR #{pr_number} 的 head 分支 {head_ref} 已不存在")
            return True

        print(f"删除 PR #{pr_number} head 分支 {head_ref} 失败: {exc}")
        return False

    print(f"已删除 PR #{pr_number} head 分支 {head_ref}")
    return True

def add_comment(pr_number: int, comment: str):
    """在PR上添加评论"""
    url = f'https://api.github.com/repos/{REPOSITORY}/issues/{pr_number}/comments'
    data = {'body': comment}
    response = requests.post(url, headers=HEADERS, json=data)
    response.raise_for_status()

def process_pr(pr: Dict[str, Any]):
    """处理单个PR"""
    pr_number = pr['number']
    pr_author = pr['user']['login']
    pr_title = pr['title']
    pr_body = pr.get('body', '') or ''
    head_sha = pr.get('head', {}).get('sha', '')
    head_ref = pr.get('head', {}).get('ref', '')

    print(f"处理PR #{pr_number} 来自 {pr_author}: {pr_title}")

    update_type = parse_version_update(pr_body)

    if not update_type:
        print(f"无法确定PR #{pr_number} 的更新类型，跳过")
        add_comment(pr_number, "⚠️ 自动处理失败: 无法确定更新类型")
        return

    print(f"PR #{pr_number} 更新类型: {update_type}")

    if update_type == 'major':
        print(f"PR #{pr_number} 是大版本更新，跳过")
        add_comment(pr_number, "⏭️ 自动跳过: 大版本更新需要手动审核")
        return

    if not is_llm_approved_for_merge(pr_number, head_sha):
        add_comment(pr_number, "⏭️ 自动跳过: LLM 尚未确认当前代码可以自动合并")
        return

    mergeable_pr = wait_for_checks(pr_number)

    if not mergeable_pr:
        print(f"PR #{pr_number} 在等待时间内未通过检查")

        # 判断 rebase checkbox 是否存在且未勾选
        if is_rebase_checkbox_unchecked(pr_body):
            print(f"PR #{pr_number} 检测到未勾选的 rebase checkbox，尝试触发 rebase...")
            triggered = trigger_renovate_rebase(pr_number, pr_body)
            if triggered:
                add_comment(
                    pr_number,
                    "🔄 自动触发 Rebase: 检查超时，已自动勾选 rebase checkbox，"
                    "Renovate 将重新触发 rebase/retry，下次调度时将再次尝试合并。"
                )
            else:
                add_comment(
                    pr_number,
                    "⏰ 自动跳过: 在等待时间内未通过所有检查，且无法触发 rebase，请手动处理。"
                )
        else:
            # checkbox 不存在或已经勾选过（Renovate 还在处理中）
            add_comment(
                pr_number,
                "⏰ 自动跳过: 在等待时间内未通过所有检查，"
                "rebase checkbox 不存在或已触发，请稍后等待 Renovate 处理或手动介入。"
            )
        return

    latest_head_sha = mergeable_pr.get('head', {}).get('sha', '')

    if not is_llm_approved_for_merge(pr_number, latest_head_sha):
        add_comment(pr_number, "⏭️ 自动跳过: PR head 已变化或 LLM 放行状态失效")
        return

    if merge_pr(pr_number, latest_head_sha):
        if delete_head_branch(pr_number, head_ref, latest_head_sha):
            add_comment(pr_number, "✅ 自动合并: 小版本更新已自动合并，head 分支已删除")
        else:
            add_comment(pr_number, "✅ 自动合并: 小版本更新已自动合并，但 head 分支删除失败，请手动处理")
    else:
        add_comment(pr_number, "❌ 自动合并失败: 请手动处理")

def main():
    """主函数"""
    try:
        prs = get_prs()
        print(f"找到 {len(prs)} 个打开的PR")

        renovate_prs = [pr for pr in prs if is_renovate_pr(pr)]
        print(f"找到 {len(renovate_prs)} 个Renovate/Mend的PR")

        for pr in renovate_prs:
            try:
                process_pr(pr)
            except Exception as e:
                print(f"处理PR #{pr['number']} 时出错: {str(e)}")

    except Exception as e:
        print(f"处理PR时发生错误: {str(e)}")
        raise

if __name__ == '__main__':
    main()
