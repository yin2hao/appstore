# 容器编排自动更新

## 当前版本控制层

Renovate 不扫描 `apps/**`。每个应用在 `.renovate/current/<application>.json` 中维护唯一的当前版本指针，以及按 Compose service 声明顺序排列的镜像仓库和 tag。

新增应用或手动发布版本时，必须同步新增或更新对应 current manifest。`npm run validate:current` 会确认每个包含 Compose 的应用都有唯一指针，并检查 manifest 与当前 Compose 一致。

## 版本规则

Compose `services` 声明顺序中第一个具有有效、显式 tag 的 `image` 是 primary image。版本目录统一为：

```text
<primary-image-tag>-<compose-revision>
```

- primary tag 变化：revision 重置为 `1`；
- 只有辅助镜像变化：当前 primary tag 下的最高 revision 加 `1`；
- 多个镜像在同一 PR 更新：只增加一次 revision；
- 旧格式目录 `<primary-image-tag>` 逻辑上按 revision `1` 处理，不重命名历史目录；
- revision 有缺口时记录告警，但始终使用最高 revision 加 `1`，绝不覆盖；
- `<tag>` 与 `<tag>-1` 同时存在会构成逻辑 revision 冲突并使更新失败。

primary tag 必须是合法 Docker tag，并通过路径安全检查。没有有效 image、没有显式 tag、目录指针不唯一、目标目录冲突或 upgrades 不一致时，脚本立即非零退出。

## 完整运行链

1. self-hosted Renovate 只从 `.renovate/current/*.json` 提取 Docker 依赖。
2. 同一个 current manifest 中的所有镜像通过固定 `groupName` 合并成一个 branch/PR；不同 manifest 保持独立。
3. Renovate 在 branch 级运行一次 `node scripts/renovate/post-upgrade.mjs`，并通过 `dataFileTemplate` 提供完整 upgrades JSON。
4. 脚本复制 current release，计算新目录名，只修改副本的 image tag，更新 current manifest，并验证历史快照和生成结果。脚本不运行任何 Git 命令。
5. Renovate 提交新目录和 current manifest，并创建 PR；Renovate 自身不自动合并。
6. `Review Renovate Compose PR` 从 base branch 运行受信任脚本，通过 GitHub API 读取 PR 树和 diff，不检出或执行 PR 代码。
7. 确定性校验确认身份、范围、历史不可变、完整复制、primary/revision 规则和 image upgrades。
8. 确定性校验通过后调用大模型。大模型只允许返回 `approve` 或 `manual` 的严格 JSON。
9. `approve` 时启用 GitHub 原生 squash auto-merge；GitHub 等待 required reviews 和 required checks 全部满足后合并。
10. 任一校验、API、超时或 JSON 解析失败都转为 `manual`，关闭已有 auto-merge，添加 `needs-owner-review` 并发布结构化摘要。若 base branch 存在 CODEOWNERS，GitHub 会按其原生规则请求 owner review。

## self-hosted 管理员配置

`.github/renovate-global.json` 是 Renovate GitHub Action 使用的管理员配置。它关闭 shell executor，并且只允许：

```text
node scripts/renovate/post-upgrade.mjs
```

仓库配置不能扩大此白名单。

## 本地验证

```bash
npm ci --ignore-scripts
npm test
npm run validate:current
npm run validate:renovate
npm run validate:workflows
node scripts/renovate/post-upgrade.mjs --dry-run --root test/fixtures/repository --data-file test/fixtures/upgrades/auxiliary.json
```

真实仓库 dry-run 示例：

```bash
node scripts/renovate/post-upgrade.mjs --dry-run --root . --data-file test/fixtures/upgrades/real-sillytavern-dry-run.json
```

## 运行前提

- 仓库设置需要启用 GitHub auto-merge，并为默认分支配置 required checks；
- Actions secret `GITHUBTOKEN` 用于 self-hosted Renovate；
- Actions secrets `LLM_API_KEY`、`LLM_BASE_URL` 用于 OpenAI-compatible Chat Completions API；
- `.github/renovate-automation.json` 的 `expectedAuthors` 必须与 self-hosted Renovate 实际创建 PR 的 GitHub 账号一致。

实现依据：Renovate 官方的 [regex custom manager](https://docs.renovatebot.com/modules/manager/regex/)、[postUpgradeTasks](https://docs.renovatebot.com/configuration-options/#postupgradetasks)、[self-hosted allowedCommands](https://docs.renovatebot.com/self-hosted-configuration/#allowedcommands)，以及 GitHub 官方的 [auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request) 与 [Actions 安全指南](https://docs.github.com/en/actions/reference/security/secure-use)。
