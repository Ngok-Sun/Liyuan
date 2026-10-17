#!/usr/bin/env bash
# ============================================================
# liyuan-deploy.sh — 梨园 fork 一键部署/替换 OMV 容器
#
# 用法:
#   scripts/deploy-omv.sh                # 部署/更新 fork 构建版（默认）
#   scripts/deploy-omv.sh --build        # 强制重打前端（默认仅当 web/src 比 dist 新才打）
#   scripts/deploy-omv.sh --official     # 一键切回官方 ghcr 镜像版（回滚）
#   scripts/deploy-omv.sh --yes          # 跳过确认（无人值守）
#
# 行为:
#   fork 模式:  本地按需 vite build → rsync 源码(不含 .git/node_modules) 到
#              OMV:<Video>/liyuan/fork/ → 生成 build 版 compose(项目名钉死 liyuan,
#              命名卷与数据全部沿用) → docker compose build + up -d → 健康检查
#   official:  生成 ghcr 镜像版 compose → pull + up -d → 健康检查
#
# 依赖: 本机 ssh/scp/rsync 免密到 OMV；远端 sudo -n docker 可用。
# 环境变量: OMV_HOST(默认 ngok@10.64.1.11), LIYUAN_PORT(默认 7620)
# ============================================================
set -euo pipefail

OMV_HOST="${OMV_HOST:-ngok@10.64.1.11}"
PORT="${LIYUAN_PORT:-7620}"
LOCAL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE=fork; ASSUME_YES=0; FORCE_BUILD=0
for a in "$@"; do
  case "$a" in
    --official) MODE=official ;;
    --yes|-y)   ASSUME_YES=1 ;;
    --build)    FORCE_BUILD=1 ;;
    -h|--help)  grep '^#' "$0" | head -20; exit 0 ;;
    *) echo "未知参数: $a（--help 看用法）"; exit 2 ;;
  esac
done

log()  { echo -e "\033[1;36m[liyuan-deploy]\033[0m $*"; }
die()  { echo -e "\033[1;31m[失败]\033[0m $*" >&2; exit 1; }
SSH()  { ssh -o ConnectTimeout=10 "$OMV_HOST" "$@"; }

# ---------- 0. 本地预检 ----------
command -v rsync  >/dev/null || die "本机没有 rsync"
command -v npm    >/dev/null || die "本机没有 npm"
[ -f "$LOCAL_REPO/web/package.json" ] || die "找不到 fork 仓库: $LOCAL_REPO"

log "模式: $MODE | 仓库: $LOCAL_REPO | 目标: $OMV_HOST"

if [ "$MODE" = fork ]; then
  if [ -n "$(git -C "$LOCAL_REPO" status --porcelain)" ] && [ "$ASSUME_YES" -eq 0 ]; then
    echo "⚠ 工作区有未提交改动:"; git -C "$LOCAL_REPO" status --short
    read -rp "仍以当前工作区状态部署? [y/N] " a; [[ "${a:-}" =~ ^[Yy]$ ]] || die "已取消"
  fi
  # 前端按需打包：dist 缺失 / src 比 dist 新 / --build
  DIST="$LOCAL_REPO/web/dist/index.html"
  STALE=""
  if [ ! -f "$DIST" ]; then STALE="dist 不存在"
  elif [ -n "$(find "$LOCAL_REPO/web/src" -newer "$DIST" -print -quit 2>/dev/null)" ]; then STALE="web/src 比 dist 新"
  elif [ "$FORCE_BUILD" -eq 1 ]; then STALE="--build 强制"
  fi
  if [ -n "$STALE" ]; then
    log "前端打包（$STALE）…"
    ( cd "$LOCAL_REPO/web" && npm install --no-audit --no-fund --loglevel=error && npm run build ) \
      || die "前端打包失败"
  else
    log "前端 dist 已是最新，跳过打包"
  fi
fi

# ---------- 1. 远端预检 ----------
SSH true >/dev/null 2>&1 || die "SSH 连不上 $OMV_HOST"
REMOTE_DIR=$(SSH 'ls -d /srv/dev-disk-by-uuid-*/Video/liyuan 2>/dev/null | head -1')
[ -n "$REMOTE_DIR" ] || die "远端找不到 */Video/liyuan 目录"
SSH 'sudo -n docker info >/dev/null 2>&1' || die "远端 sudo -n docker 不可用"
log "远端目录: $REMOTE_DIR"

AVAIL=$(SSH "df -BG --output=avail '$REMOTE_DIR' | tail -1 | tr -dc 0-9")
[ "${AVAIL:-0}" -ge 2 ] || die "远端磁盘可用仅 ${AVAIL}G，不足 2G"

# ---------- 2. 生成 compose（项目名钉死 liyuan → 命名卷/数据全沿用） ----------
TMP=$(mktemp /tmp/liyuan-compose.XXXXXX.yml)
trap 'rm -f "$TMP"' EXIT
if [ "$MODE" = fork ]; then
  SERVICE_SPEC=$'    build: ./fork\n    image: liyuan-fork:local'
else
  SERVICE_SPEC=$'    image: ghcr.io/weidu12123/liyuan:latest'
fi
cat > "$TMP" <<YAML
# 由 liyuan-deploy.sh 生成（模式: $MODE）——手改会被覆盖
name: liyuan
services:
  liyuan:
$SERVICE_SPEC
    container_name: liyuan
    restart: unless-stopped
    ports:
      - "${PORT}:7620"
    environment:
      HOST: "0.0.0.0"
      PORT: "7620"
    volumes:
      - liyuan-agent:/root/.liyuan
      - liyuan-state:/app/.liyuan-state
      - liyuan-uploads:/app/.liyuan-uploads
      - liyuan-media:/app/.liyuan-media
      - liyuan-audio:/app/.liyuan-audio
      - liyuan-artifacts:/app/.liyuan-artifacts
      - liyuan-codex:/app/.liyuan-codex
      - liyuan-lore:/app/.liyuan-lore
      - liyuan-memory:/app/.liyuan-memory
      - liyuan-skills:/app/.liyuan-skills
      - liyuan-worldline:/app/.liyuan-worldline
      - liyuan-cache:/app/.liyuan-cache
      - liyuan-presets:/app/assets/presets
      - liyuan-personas-assets:/app/assets/personas
      - liyuan-profiles:/app/liyuan-profiles
      - liyuan-skills-project:/app/skills
      - ./data/config:/app/config
      - ./data/cards:/app/assets/cards
      - ./data/card-spaces:/app/cards
      - ./data/lorebooks:/app/assets/lorebooks
      - liyuan-vault:/app/assets/.vault
      - liyuan-trash:/app/assets/.回收站
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7620/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
volumes:
  liyuan-agent:
  liyuan-state:
  liyuan-uploads:
  liyuan-media:
  liyuan-audio:
  liyuan-artifacts:
  liyuan-codex:
  liyuan-lore:
  liyuan-memory:
  liyuan-skills:
  liyuan-worldline:
  liyuan-cache:
  liyuan-presets:
  liyuan-personas-assets:
  liyuan-profiles:
  liyuan-skills-project:
  liyuan-vault:
  liyuan-trash:
YAML

# ---------- 3. 同步源码（仅 fork 模式） ----------
if [ "$MODE" = fork ]; then
  log "rsync 同步源码 → fork/ ..."
  rsync -az --delete \
    --exclude '.git' --exclude 'node_modules' \
    --exclude '/data/' --exclude '/desktop/' \
    "$LOCAL_REPO/" "$OMV_HOST:$REMOTE_DIR/fork/"
fi

# ---------- 4. 落 compose（旧文件自动备份） ----------
STAMP=$(date +%Y%m%d%H%M%S)
scp -q "$TMP" "$OMV_HOST:$REMOTE_DIR/docker-compose.yml.new"
SSH "cp '$REMOTE_DIR/docker-compose.yml' '$REMOTE_DIR/docker-compose.yml.bak.$STAMP' && mv '$REMOTE_DIR/docker-compose.yml.new' '$REMOTE_DIR/docker-compose.yml'"
log "compose 已更新（旧文件: docker-compose.yml.bak.$STAMP）"

# ---------- 5. 构建 + 替换容器 ----------
cd_step() { SSH "cd '$REMOTE_DIR' && $*"; }
if [ "$MODE" = fork ]; then
  log "docker compose build（弱 CPU 首次约 2-5 分钟，之后走层缓存）…"
  cd_step "sudo -n docker compose build" || { cd_step "sudo -n docker compose logs --tail 30"; die "build 失败"; }
  cd_step "sudo -n docker compose up -d --force-recreate" || die "up -d 失败"
else
  log "拉取官方镜像…"
  cd_step "sudo -n docker compose pull" || die "pull 失败"
  cd_step "sudo -n docker compose up -d --force-recreate" || die "up -d 失败"
fi

# ---------- 6. 健康检查（最多 100s） ----------
log "健康检查 http://127.0.0.1:$PORT/ ..."
CODE=000
for i in $(seq 1 25); do
  # 远端可能没有 curl，wget 兜底
  CODE=$(SSH "command -v curl >/dev/null 2>&1 && curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:$PORT/ || wget -q -O /dev/null -T 3 http://127.0.0.1:$PORT/ && echo 200 || echo 000" | tail -1)
  [ "$CODE" = "200" ] && break
  sleep 4
done
if [ "$CODE" != "200" ]; then
  echo "❌ 健康检查未通过（最后状态 $CODE），最近日志:"
  cd_step "sudo -n docker compose logs --tail 40"
  die "回滚: $0 --official"
fi

# ---------- 7. 结果汇报 ----------
log "✅ 部署完成"
SSH "sudo -n docker ps --filter name=liyuan --format '  容器: {{.Image}} | {{.Status}}'"
SSH "ls '$REMOTE_DIR/data/config/liyuan.agent.json' >/dev/null 2>&1 && echo '  API key: 在位未动' || echo '  ⚠ API key 文件缺失！'"
echo "  回滚官方版: scripts/deploy-omv.sh --official"
echo "  回滚上一版 compose: 远端 $REMOTE_DIR/docker-compose.yml.bak.$STAMP"
