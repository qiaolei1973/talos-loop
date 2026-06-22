#!/usr/bin/env bash
#
# talos-loop 一键环境初始化。
#
# 做四件事：
#   1. 装系统依赖（git / tmux / gh / Claude Code CLI）
#   2. 校验 Node 版本（要求见 package.json 的 engines.node）
#   3. 从模板生成 config.json / projects.json，并 npm install
#   4. 检查 github-code / github-review 两个 skill 是否就位 + gh 认证状态
#
# 幂等：可反复执行，已就绪的项会跳过。
# 失败的步骤不中断脚本，最后汇总「还需手动处理」的项。
#
# 用法： ./init.sh
#
set -uo pipefail

# ── 颜色 / 日志 ───────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi
info() { printf "${C_BLUE}[info]${C_RESET}  %s\n" "$*"; }
ok()   { printf "${C_GREEN}[ok]${C_RESET}    %s\n" "$*"; }
warn() { printf "${C_YELLOW}[warn]${C_RESET}  %s\n" "$*"; }
fail() { printf "${C_RED}[fail]${C_RESET}  %s\n" "$*"; }

# 仓库根（脚本所在目录）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# 「还需手动处理」清单
TODO=()
todo() { TODO+=("$1"); }

have() { command -v "$1" >/dev/null 2>&1; }

# ── 平台 / 包管理器探测 ──────────────────────────────────────
OS="$(uname -s)"
PKG=""
case "$OS" in
  Darwin) PKG="brew" ;;
  Linux)
    if   have apt-get; then PKG="apt-get"
    elif have dnf;     then PKG="dnf"
    elif have yum;     then PKG="yum"
    elif have apk;     then PKG="apk"
    fi
    ;;
esac

# Linux 上非 root 时给包管理器加 sudo
SUDO=""
if [[ "$OS" == "Linux" && "$(id -u)" -ne 0 ]]; then SUDO="sudo"; fi

if [[ -z "$PKG" ]]; then
  warn "未识别的包管理器（$OS）—— 系统依赖需手动安装。"
fi

echo "${C_BLUE}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   talos-loop 环境初始化                  ║"
echo "  ╚══════════════════════════════════════════╝"
echo "${C_RESET}"

# ── Node 版本校验（要求见 package.json engines，与下方常量保持同步）────
REQUIRED_NODE="22.12"   # keep in sync with package.json engines.node

node_ge() { # $1=required "M.m"  $2=current "vM.m.p"  → 0 if current >= required
  local req="$1" cur="${2#v}"
  local ra=0 rb=0 ca=0 cb=0 _
  IFS=. read -r ra rb _ <<<"$req"
  IFS=. read -r ca cb _ <<<"$cur"
  ra=${ra:-0}; rb=${rb:-0}; ca=${ca:-0}; cb=${cb:-0}
  if (( ca > ra )) || (( ca == ra && cb >= rb )); then return 0; fi
  return 1
}

info "检查 Node.js（要求 ≥ ${REQUIRED_NODE}）"
if have node; then
  CUR="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  if node_ge "$REQUIRED_NODE" "$CUR"; then
    ok "Node ${CUR}"
  else
    fail "Node ${CUR} 低于 ${REQUIRED_NODE}"
    todo "升级 Node.js 到 ≥ ${REQUIRED_NODE}（https://nodejs.org）"
  fi
else
  fail "未找到 node"
  todo "安装 Node.js ≥ ${REQUIRED_NODE}（https://nodejs.org）"
fi

# ── git ────────────────────────────────────────────────────────
install_git() {
  if have git; then ok "git: $(git --version | awk '{print $3}')"; return; fi
  if [[ -z "$PKG" ]]; then todo "手动安装 git（https://git-scm.com）"; return; fi
  info "安装 git ..."
  case "$PKG" in
    brew)     brew install git ;;
    apt-get)  $SUDO apt-get update -y && $SUDO apt-get install -y git ;;
    dnf|yum)  $SUDO "$PKG" install -y git ;;
    apk)      $SUDO apk add --no-cache git ;;
  esac
  if have git; then ok "git 已安装"; else todo "git 安装失败，请手动安装"; fi
}

# ── tmux ───────────────────────────────────────────────────────
install_tmux() {
  if have tmux; then ok "tmux: $(tmux -V 2>/dev/null || echo present)"; return; fi
  if [[ -z "$PKG" ]]; then todo "手动安装 tmux（https://github.com/tmux/tmux）"; return; fi
  info "安装 tmux ..."
  case "$PKG" in
    brew)     brew install tmux ;;
    apt-get)  $SUDO apt-get update -y && $SUDO apt-get install -y tmux ;;
    dnf|yum)  $SUDO "$PKG" install -y tmux ;;
    apk)      $SUDO apk add --no-cache tmux ;;
  esac
  if have tmux; then ok "tmux 已安装"; else todo "tmux 安装失败，请手动安装"; fi
}

# ── gh（GitHub CLI）─────────────────────────────────────────────
install_gh() {
  if have gh; then ok "gh: $(gh --version | head -1 | awk '{print $3}')"; return; fi
  if [[ -z "$PKG" ]]; then todo "手动安装 gh（https://cli.github.com）"; return; fi
  info "安装 gh ..."
  if [[ "$PKG" == "brew" ]]; then
    brew install gh
  elif [[ "$PKG" == "apt-get" ]]; then
    # 添加 GitHub 官方源（与 Dockerfile 一致）
    $SUDO apt-get update -y
    $SUDO apt-get install -y curl gpg
    $SUDO install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    $SUDO chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    $SUDO apt-get update -y
    $SUDO apt-get install -y gh
  elif [[ "$PKG" == "dnf" || "$PKG" == "yum" ]]; then
    $SUDO "$PKG" install -y gh
  elif [[ "$PKG" == "apk" ]]; then
    $SUDO apk add --no-cache gh
  fi
  if have gh; then ok "gh 已安装"; else todo "gh 安装失败，请手动安装（https://cli.github.com）"; fi
}

# ── Claude Code CLI（经 npm 全局安装）──────────────────────────
install_claude() {
  if have claude; then ok "claude: $(claude --version 2>/dev/null || echo present)"; return; fi
  if ! have npm; then todo "安装 claude 需要 npm（先装 Node.js）"; return; fi
  info "安装 Claude Code CLI ..."
  if npm install -g @anthropic-ai/claude-code; then
    ok "claude 已安装"
  elif [[ -n "$SUDO" ]] && $SUDO npm install -g @anthropic-ai/claude-code; then
    ok "claude 已安装（sudo）"
  else
    todo "claude 安装失败：手动执行 npm install -g @anthropic-ai/claude-code（必要时加 sudo）"
  fi
}

install_git
install_tmux
install_gh
install_claude

# ── 脚手架配置 + npm install ──────────────────────────────────
scaffold() { # $1=src  $2=dst
  if [[ -f "$2" ]]; then
    ok "$2 已存在（跳过）"
  elif [[ -f "$1" ]]; then
    cp "$1" "$2"
    ok "已生成 $2（请按需修改）"
  else
    todo "缺少模板 $1"
  fi
}
echo
info "脚手架配置"
scaffold config.example.json config.json
scaffold projects.example.json projects.json

echo
info "npm install"
if have npm; then
  if npm install; then ok "npm 依赖已安装"; else todo "npm install 失败，请手动重试"; fi
else
  todo "缺少 npm（随 Node.js 一起安装）"
fi

# ── skills（github-code / github-review，需在用户级 ~/.claude/skills）──
SKILLS_DIR="${HOME}/.claude/skills"
echo
info "检查 skills"
for s in github-code github-review; do
  if [[ -d "$SKILLS_DIR/$s" ]]; then
    ok "skill $s 已就绪"
  else
    todo "安装 skill $s → ~/.claude/skills/$s（如：npx skills add <skills-source> --skill $s）"
  fi
done

# ── gh 认证状态 ────────────────────────────────────────────────
echo
info "检查 gh 认证"
if have gh; then
  if gh auth status >/dev/null 2>&1; then
    # 确认是否含 project scope
    if gh auth status 2>&1 | grep -q "project"; then
      ok "gh 已认证（含 project scope）"
    else
      warn "gh 已认证，但可能缺 project scope"
      todo "gh auth refresh -s project"
    fi
  else
    todo "gh 未认证：运行 gh auth login"
  fi
fi

# ── 汇总 ──────────────────────────────────────────────────────
echo
echo "${C_BLUE}────────────────────────────────────────────────${C_RESET}"
if (( ${#TODO[@]} == 0 )); then
  echo "${C_GREEN}✓ 全部就绪！${C_RESET}"
else
  echo "${C_YELLOW}还需手动处理 ${#TODO[@]} 项：${C_RESET}"
  for i in "${!TODO[@]}"; do printf "  %d. %s\n" "$((i+1))" "${TODO[$i]}"; done
fi
echo
echo "${C_BLUE}下一步：${C_RESET}"
echo "  1. 编辑 projects.json，填入你的 Project + 仓库"
echo "  2. 在看板 issue 上打上 ready-for-agent 标签"
echo "  3. npm run dev   # 或 npm run build && npm start（生产模式）"
echo "  4. 浏览器打开 http://localhost:3100"
