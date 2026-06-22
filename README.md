# Talos Loop

把 **GitHub Projects 看板当作 workflow 引擎**：看板上 `Ready` + 带 `ready-for-agent` 标签的 issue 被自动派发给一个**自包含的 Claude Code skill**，skill 在隔离的 git worktree 中编码、推送分支、提交 PR，看板随之推进到 `In review`。

> 架构设计、三层分层、状态机、插件契约等内部细节见维护者文档 [CLAUDE.md](./CLAUDE.md)。

---

## 快速上手

```bash
git clone <repo-url> && cd talos-loop
./init.sh
```

`./init.sh` 一键搞定环境：自动安装 `tmux` / `gh` / `claude` / `git`、校验 Node 版本（要求见 `package.json` 的 `engines`）、从模板生成配置、`npm install`、并检查 `github-code` / `github-review` 两个 skill 与 `gh` 认证是否就位。脚本**幂等可重跑**，个别步骤失败会汇总到末尾提示手动处理。

### 1. 配置 Project 与 Repo

`init.sh` 已从模板生成 `config.json` 与 `projects.json`（也可手动 `cp *.example.json`）。**`projects.json`** 是 GitHub 接入的核心：一个数组，每项是一个 Project（可跨多个仓库）：

```jsonc
[
  {
    "projectId": "owner/1",            // "owner/number"，与 GitHub Projects URL 一致
    "projectType": "github",           // 内置 "github"，或外部插件包名/本地路径
    "enabled": true,
    "repos": [                         // 该 project 涉及的代码仓库
      { "path": "/abs/path/to/local/clone" },
      { "path": "/path/to/other-repo", "remote": "owner/other-repo" }, // remote 可选
      { "path": "/path/to/repo-on-master", "branch": "master" }        // branch 可选，缺省 main
    ],
    "stages": {                        // stage → skill 映射
      "ready": "github-code",          //   ready issue → 编码 skill
      "in-review": "github-review"     //   in-review + 评审线程 → 评审 skill
    },
    "config": {}                       // 可选：插件特定配置
  }
]
```

- `repos[].name` 取 `path` 的 basename，既是 issue 与仓库的映射键，也用于 dashboard 分组；**同一 project 内须唯一**。
- `repos[].branch` 为基线分支（feat 分支从它切出，也是 PR 目标分支），缺省 `main`。
- 看板上 issue 的仓库若未在 `repos[]` 声明，会被告警并跳过。

**`config.json`**（运行参数，完整字段见模板）：常用 `port`、`pollInterval`、`maxParallel`、`claudeTimeout`，以及 `maxRetry`（崩溃会话自动重试上限，默认 1）、`keepSessionOnSuccess`（成功会话保留 tmux 窗口，默认 false）。

### 2. 给 issue 打上 `ready-for-agent`

`ready-for-agent` 是**永久资格标记**，由人工在需求就绪时设置（例如写完 PRD 后打上），**talos-loop 永不修改**。只有带此标签的看板 issue 才会被执行。

> **触发条件：看板状态 == `Ready` + 有 `ready-for-agent` 标签。**

### 3. 起服务

```bash
npm run dev          # 前后端热重载
# 或
npm run build && npm start   # 生产模式，监听 0.0.0.0:3100
```

浏览器访问 `http://localhost:3100`，可查看所有仓库的 issue（按仓库分组）、看板状态、每条 issue 的会话历史，以及手动「立即轮询」按钮。失败/被 kill 的会话可一键复制 `claude -r` 恢复命令继续。

## 用户故事（一个 issue 的旅程）

```
Ready + ready-for-agent
   │  派发：建 worktree → 看板 In progress → 调 github-code skill
   ▼
In progress ── skill 编码、推送分支、开 PR
   │  skill 正常退出（exit 0）
   ▼
In review ── 每周期探查未解决评审线程 → 调 github-review skill 自动修复
   │  PR 合并
   ▼
Done
```

- **崩溃会自动原地重试**：在 `maxRetry` 预算内用 `claude -r` 续跑（复用 worktree + 分支）；用尽则 issue 停在 `In progress` 等人工介入。
- **评审修复自动驱动**：触发源是对 PR 代码行的 **inline 评审评论**（review thread）。PR 底部普通评论不会触发。agent 修复后推回**原 PR 分支**，看板始终停在 `In review` 直到合并。
- **命名陷阱**：`In review`（PR 已创建）不是终态 `Done`；终态由 GitHub PR 合并自动化推进，talos-loop 不参与。

## Docker 一键起

镜像只烘焙稳定运行时；config、目标仓库、claude 凭证 / skills、gh 认证、SQLite db **全部从宿主机 bind-mount**——在宿主机上编辑它们即可。

1. 准备 `.env`（compose 自动读取）：

   ```bash
   cp .env.example .env
   ```

   `UID`/`GID` 需与「拥有目标仓库、`~/.claude`、`~/.config/gh` 的宿主机用户」一致（多数 `1000:1000`）；`REPOS_ROOT` 指向代码仓库共同父目录。

2. 准备 `./talos-data/`（挂载到容器 `/data`）：放 `config.json`（`dbPath` 指向 `/data/talos-loop.db`）与 `projects.json`（**`repos[].path` 必须用容器内路径 `/workspace/<repo>`**）。

3. 宿主机前置（容器通过挂载复用）：`gh` 已认证含 `project` scope、`claude` 已登录、`~/.claude/skills/` 下已有 `github-code` / `github-review`。

```bash
docker compose up --build -d          # 后台运行
docker compose logs -f                # 看日志
docker compose down                   # 停止
```

浏览器打开 `http://localhost:3100`。

> **attach 看会话**：dashboard 的 `tmux attach` 链接跨不过容器边界，改用 `docker exec -it talos-loop tmux attach -t <session>`。
> **uid 匹配**：宿主机 uid 非 1000 时改 `.env` 的 `UID`/`GID`。

## License

Private
