#!/usr/bin/env bash
# 大肥鱼还原脚本 —— 在全新机器上把服务恢复出来。
# Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
#
# 【第三方致谢】
#   本脚本会还原 workbuddy-openai-proxy 的配置与账号池。
#   workbuddy-openai-proxy — 作者 yuan240324，MIT License
#   https://github.com/yuan240324/workbuddy-openai-proxy
#   该项目需自行安装，本仓库不分发其代码。
#   完整说明见 CREDITS.md
#
# 前提：新机器已装 Docker、Node 22、Python 3，且能访问 GitHub。
#
# 用法：
#   curl -fsSL .../restore.sh | bash            # 取 latest
#   ./restore.sh /path/to/dafeiyu-xxx.tar.gz    # 用指定包
#
# 这个脚本做四件事：
#   1. 拉取并解压备份
#   2. 把文件放回原位
#   3. 提示需要手工补的项（Docker 镜像、证书、系统包）
#   4. 重启服务
set -uo pipefail

REPO="ZhengWill/dafeiyu-backup"
WORK="/root/restore-$(date +%Y%m%d-%H%M%S)"
PKG="${1:-}"

say() { printf '\n\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }

say "大肥鱼还原开始"

# ---------- 1. 取备份 ----------
mkdir -p "$WORK"
cd "$WORK"

if [[ -z "$PKG" ]]; then
  say "从 GitHub 下载 latest 备份"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
      -o backup.tar.gz \
      "https://api.github.com/repos/$REPO/contents/latest/backup.tar.gz?ref=main" \
      || { warn "下载失败"; exit 1; }
    # API 返回的是 base64 JSON，需要解码
    if head -c 1 backup.tar.gz | grep -q '{'; then
      python3 -c "
import json,base64
d=json.load(open('backup.tar.gz'))
open('real.tar.gz','wb').write(base64.b64decode(d['content']))
"
      mv real.tar.gz backup.tar.gz
    fi
  else
    warn "没有 GITHUB_TOKEN，私有仓库拿不到。"
    warn "请设置：export GITHUB_TOKEN=ghp_xxx"
    warn "或者手动下载后传上来，用 $0 /path/to/pkg.tar.gz"
    exit 1
  fi
  PKG="$WORK/backup.tar.gz"
fi

[[ -f "$PKG" ]] || { warn "找不到备份包: $PKG"; exit 1; }
ok "备份包 $(du -h "$PKG" | cut -f1)"

say "解压"
tar xzf "$PKG" -C "$WORK" || { warn "解压失败"; exit 1; }
ok "解压完成"

# ---------- 2. 检查环境 ----------
say "检查运行环境"
MISSING=0
for c in node docker python3; do
  if command -v "$c" >/dev/null 2>&1; then
    ok "$c $(  $c --version 2>&1 | head -1)"
  else
    warn "缺少 $c"
    MISSING=1
  fi
done
[[ $MISSING -eq 1 ]] && warn "先装好缺的组件再继续，否则服务起不来"

# ---------- 3. 放回原位 ----------
say "恢复代码"
mkdir -p /root/relay /root/dashboard /root/bot/workbuddy-openai-proxy /root/certs
cp -a "$WORK/code/relay/."            /root/relay/ 2>/dev/null
cp -a "$WORK/code/dashboard/."        /root/dashboard/ 2>/dev/null
cp -a "$WORK/code/workbuddy-proxy/."  /root/bot/workbuddy-openai-proxy/ 2>/dev/null
[[ -f "$WORK/code/astrbot-tls.mjs" ]] && cp -a "$WORK/code/astrbot-tls.mjs" /root/
ok "代码就位"

say "恢复插件"
PDIR=/root/bot/astrbot/data/plugins
mkdir -p "$PDIR"
for p in astrbot_plugin_yu_wake astrbot_plugin_auto_accept astrbot_plugin_poke_debug; do
  if [[ -d "$WORK/code/plugins/$p" ]]; then
    cp -a "$WORK/code/plugins/$p" "$PDIR/"
    ok "$p"
  fi
done

# 表情包插件：只覆盖自己改过的三个文件
MM="$PDIR/meme_manager"
if [[ -d "$MM" ]]; then
  for f in main.py:main.py models.py:backend/semantic/models.py ui.js:pages/shared/ui.js; do
    src="${f%%:*}"; dst="${f##*:}"
    if [[ -f "$WORK/code/plugins/meme_manager/$src" ]]; then
      cp -a "$WORK/code/plugins/meme_manager/$src" "$MM/$dst"
      ok "meme_manager/$dst"
    fi
  done
  warn "表情包插件本体要先从 AstrBot 插件市场装好，这里只覆盖改动过的文件"
else
  warn "meme_manager 目录不存在 —— 先在 AstrBot 里装这个插件"
fi

say "恢复敏感配置"
mkdir -p /root/bot/astrbot/data/config
mkdir -p /root/bot/astrbot/data/plugin_data/meme_manager
cp -a "$WORK/secrets/relay.json"                  /root/relay/relay.json
cp -a "$WORK/secrets/minimax-accounts.json"       /root/relay/minimax-accounts.json
cp -a "$WORK/secrets/workbuddy-config.json"       /root/bot/workbuddy-openai-proxy/config.json
[[ -f "$WORK/secrets/astrbot-cmd_config.json" ]] && \
  cp -a "$WORK/secrets/astrbot-cmd_config.json"   /root/bot/astrbot/data/cmd_config.json
[[ -f "$WORK/secrets/meme_manager_config.json" ]] && \
  cp -a "$WORK/secrets/meme_manager_config.json"  /root/bot/astrbot/data/config/
[[ -f "$WORK/secrets/meme_manager_selection_rules.json" ]] && \
  cp -a "$WORK/secrets/meme_manager_selection_rules.json" /root/bot/astrbot/data/plugin_data/meme_manager/selection_rules.json
[[ -f "$WORK/secrets/meme_manager_registry.json" ]] && \
  cp -a "$WORK/secrets/meme_manager_registry.json" /root/bot/astrbot/data/plugin_data/meme_manager/registry.json

for f in "$WORK"/secrets/workbuddy-pools/auth.*.pool.json; do
  [[ -f "$f" ]] && cp -a "$f" /root/bot/workbuddy-openai-proxy/ && ok "$(basename "$f")"
done

[[ -d "$WORK/secrets/certs" ]] && cp -a "$WORK/secrets/certs/." /root/certs/ && ok "TLS 证书"

# AstrBot 数据库（消息历史、会话）
if [[ -d "$WORK/secrets/astrbot" ]]; then
  A=/root/bot/astrbot/data
  mkdir -p "$A"
  [[ -f "$WORK/secrets/astrbot/data_v4.db" ]] && cp -a "$WORK/secrets/astrbot/data_v4.db" "$A/"
  [[ -d "$WORK/secrets/astrbot/webchat" ]] && cp -a "$WORK/secrets/astrbot/webchat" "$A/"
  [[ -f "$WORK/secrets/astrbot/plugins.json" ]] && cp -a "$WORK/secrets/astrbot/plugins.json" "$A/"
  ok "AstrBot 数据库"
fi

say "恢复 systemd 单元"
mkdir -p /root/.config/systemd/user
cp -a "$WORK"/code/systemd/*.service /root/.config/systemd/user/ 2>/dev/null
cp -a "$WORK"/code/systemd/*.timer   /root/.config/systemd/user/ 2>/dev/null
systemctl --user daemon-reload 2>/dev/null
ok "单元已注册"

# ---------- 4. 需要人工确认的 ----------
say "以下是备份里没有、需要你手工补的"
cat <<'EOF'
  1. Docker 容器（SnowLuma、AstrBot）—— 镜像要重新拉
       docker run ... snowluma
       docker run ... astrbot
     容器名、端口、挂载见 BACKUP-INFO.txt 的「容器」段

  2. AstrBot 的 pip 依赖
       进容器后 pip install -r 插件目录/requirements.txt

  3. 表情包图片（555MB，没备份）
       在 AstrBot 插件页从资源广场重新安装
       或从你本地另存的副本拷回

  4. QQ 登录态
       SnowLuma 要重新扫码登录（账号：<你的QQ号>）

  5. 阿里云安全组端口
       8443（AstrBot HTTPS）、8080（控制台）、6081（noVNC）等

  6. 复核密钥是否还有效
       WorkBuddy 国际版已封号，国内版还在
       MiniMax token 12 小时过期，restore 后跑一次 minimax-refresh
EOF

say "启动服务"
for s in relay workbuddy-proxy; do
  if systemctl --user list-unit-files "$s.service" >/dev/null 2>&1; then
    systemctl --user enable --now "$s.service" 2>/dev/null && ok "$s 已启动"
  fi
done
systemctl --user enable --now minimax-checkin.timer 2>/dev/null
systemctl --user enable --now minimax-refresh.timer 2>/dev/null

say "还原结束"
echo
echo "备份内容清单位于: $WORK/BACKUP-INFO.txt"
echo "验证：curl -s http://127.0.0.1:8790/v1/models -H 'Authorization: Bearer <你的relayKey>'"
