# talos-loop 容器镜像。
#
# 镜像只烘焙「稳定运行时」：Node 22、tmux/git/gh、Claude Code CLI、以及构建好的 app。
# 一切宿主机相关的东西（config、目标仓库、claude 凭证、skills、gh 认证、SQLite db）
# 都在 `docker run` 时 bind-mount 进来——见 docker-compose.yml。
#
# 以宿主机 uid 运行（构建参数 UID/GID），这样容器创建的文件仍是宿主机用户所有；
# `git config --system safe.directory '*'` 让 git 能读写被挂载进来的、属于宿主机用户的仓库。

############################
# 1. build：编译 web + server（需要构建工具链以编译 better-sqlite3 原生模块）
############################
FROM node:22-bookworm-slim AS build

# better-sqlite3 走 node-gyp，需要 python3/make/g++
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 先拷清单 + lock → 依赖层缓存，源码改动不重装依赖
COPY package.json package-lock.json ./
COPY server/package.json server/tsconfig.json ./server/
COPY web/package.json ./web/
RUN npm ci

# 再拷源码
COPY server/ ./server/
COPY web/ ./web/

# 根 build = 先 vite 构建 web（输出到 server/dist/web）再 tsc 构建 server（输出 server/dist），
# 一次产出完整的 server/dist（含 web 产物与 stream-formatter.cjs）。
RUN npm run build

############################
# 2. prod-deps：裁剪到生产依赖（better-sqlite3 已在同基础镜像编译好）
############################
FROM build AS prod-deps
RUN npm prune --omit=dev

############################
# 3. runtime：运行时镜像
############################
FROM node:22-bookworm-slim AS runtime

ARG UID=1000
ARG GID=1000

# orchestrator 会 shell out 到这些系统工具：tmux（会话隔离）、git（worktree）、gh、tini（PID1 回收僵尸进程）
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends \
      tmux git tini ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI（钉版本，与参考宿主机安装一致）
RUN npm install -g @anthropic-ai/claude-code@2.1.168

# 让 git 能操作被挂载进来、属宿主机用户的仓库（否则报 "dubious ownership"）
RUN git config --system --add safe.directory '*'

# 与宿主机 uid 一致的非 root 用户 → 容器创建的文件仍是宿主机用户所有（清理不需 sudo）
RUN (getent group "${GID}" >/dev/null || groupadd -g "${GID}" agent) \
 && (getent passwd "${UID}" >/dev/null || useradd -m -u "${UID}" -g "${GID}" -d /home/agent -s /bin/bash agent)

WORKDIR /app

# 生产依赖（better-sqlite3 在同一基础镜像上编译，可直接运行）
COPY --from=prod-deps /build/node_modules ./node_modules
# server 产物（含 web dashboard 在 server/dist/web，以及 stream-formatter.cjs）
COPY --from=build /build/server/dist ./server/dist

ENV NODE_ENV=production
ENV HOME=/home/agent
# config/projects 从挂载的 /data 读取（见 docker-compose.yml）；
# dbPath 在 config.json 里设为 /data/talos-loop.db。
ENV CONFIG_PATH=/data/config.json
ENV PROJECTS_PATH=/data/projects.json

USER ${UID}:${GID}

EXPOSE 3100

# tini 作为 PID1：回收 tmux/claude 等子进程僵尸（spawn 出来的 detached tmux server 会被
# reparent 到 PID1，node 不会自动回收）。作为 ENTRYPOINT，无论用 compose 还是裸 docker run 都生效。
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
