# Talos Loop

把 **GitHub Projects 看板当作 workflow 引擎**：看板上 `Ready` + 带 `ready-for-agent` 标签的 issue 被自动派发给一个**自包含的 Claude Code skill**，skill 在隔离的 git worktree 中编码、推送分支、提交 PR，看板随之推进到 `In review`。

> 架构设计、三层分层、状态机、插件契约等内部细节见维护者文档 [CLAUDE.md](./CLAUDE.md)。

---

## 快速上手

```bash
git clone <repo-url> && cd talos-loop
./init.sh
```

### 1. 配置 Project 与 Repo

`init.sh` 已从模板生成 `config.json` 与 `projects.json`，照着 [`projects.example.json`](./projects.example.json) 与 [`config.example.json`](./config.example.json) 改即可。

### 2. 给 issue 打上 `ready-for-agent`

`ready-for-agent` 是**永久资格标记**，由人工在需求就绪时设置（例如写完 PRD 后打上），**talos-loop 永不修改**。只有带此标签的看板 issue 才会被执行。

> **触发条件：看板状态 == `Ready` + 有 `ready-for-agent` 标签。**

### 3. 起服务

```bash
npm run dev          # 前后端热重载
# 或
npm run build && npm start   # 生产模式，监听 0.0.0.0:3100
```

浏览器访问 `http://localhost:3100`，可查看所有仓库的 issue（按仓库分组）、看板状态、每条 issue 的会话历史，以及手动「立即轮询」按钮。

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

- **评审修复自动驱动**：触发源是对 PR 代码行的 **inline 评审评论**（review thread）。PR 底部普通评论不会触发。agent 修复后推回**原 PR 分支**，看板始终停在 `In review` 直到合并。
- **命名陷阱**：`In review`（PR 已创建）不是终态 `Done`；终态由 GitHub PR 合并自动化推进，talos-loop 不参与。

## License

Private
