#!/usr/bin/env bash
# 大肥鱼部署备份
# Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
#
# 【第三方致谢】
#   本脚本会备份 workbuddy-openai-proxy 的配置与账号池（不备份其源码）。
#   workbuddy-openai-proxy — 作者 yuan240324，MIT License
#   https://github.com/yuan240324/workbuddy-openai-proxy
#   本脚本不包含、不改写该项目的任何代码。
#   完整说明见 CREDITS.md
#
# 设计原则：
#   1. 只备"重装时要手写"的东西 —— 配置、账号池、代码、systemd 单元。
#      表情包图片（555M）和 temp 垃圾（802M）不备，可重新获取。
#   2. 敏感与不敏感分开 —— secrets/ 与 code/ 两个目录，前者永不进公开仓库。
#   3. tar 前先验证可读，避免备份出空包还以为成功。
#
# 用法：
#   ./backup.sh              备份到 /root/backups/dafeiyu-<时间>.tar.gz
#   ./backup.sh --keep 7     保留最近 7 份（默认 14）
set -uo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
ROOT_DIR="${BACKUP_ROOT:-/root/backups}"
KEEP=14
if [[ "${1:-}" == "--keep" && -n "${2:-}" ]]; then KEEP="$2"; fi

WORK="$ROOT_DIR/work-$STAMP"
OUT="$ROOT_DIR/dafeiyu-$STAMP.tar.gz"

mkdir -p "$WORK"/{code,secrets}

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# ---------- 1. 代码与配置模板 ----------
say "收集代码…"
copy_into() {
  local src="$1" dst="$2"
  if [[ -e "$src" ]]; then
    mkdir -p "$(dirname "$WORK/$dst")"
    cp -a "$src" "$WORK/$dst" 2>/dev/null && say "  ✓ $dst"
  else
    say "  ✗ 缺失: $src"
  fi
}

# 中转站（代码部分，relay.json 归 secrets）
copy_into /root/relay/relay.mjs            code/relay/relay.mjs
copy_into /root/relay/ui                   code/relay/ui
copy_into /root/relay/sync_relay_usage.py  code/relay/sync_relay_usage.py
copy_into /root/relay/minimax-checkin.mjs  code/relay/minimax-checkin.mjs
copy_into /root/relay/minimax-refresh.mjs  code/relay/minimax-refresh.mjs
copy_into /root/relay/seed.mjs             code/relay/seed.mjs

# 控制台
copy_into /root/dashboard/server.mjs       code/dashboard/server.mjs
copy_into /root/dashboard/index.html       code/dashboard/index.html

# WorkBuddy 代理（代码；auth.*.pool.json 归 secrets）
copy_into /root/bot/workbuddy-openai-proxy/src      code/workbuddy-proxy/src
copy_into /root/bot/workbuddy-openai-proxy/server.mjs code/workbuddy-proxy/server.mjs
copy_into /root/bot/workbuddy-openai-proxy/package.json code/workbuddy-proxy/package.json
copy_into /root/bot/workbuddy-openai-proxy/checkin.mjs code/workbuddy-proxy/checkin.mjs

# AstrBot 插件（自己写的三个）
copy_into /root/bot/astrbot/data/plugins/astrbot_plugin_yu_wake    code/plugins/astrbot_plugin_yu_wake
copy_into /root/bot/astrbot/data/plugins/astrbot_plugin_auto_accept code/plugins/astrbot_plugin_auto_accept
copy_into /root/bot/astrbot/data/plugins/astrbot_plugin_poke_debug  code/plugins/astrbot_plugin_poke_debug

# 表情包插件：只备自己改过的文件，不备整个（含 555M 图）
copy_into /root/bot/astrbot/data/plugins/meme_manager/main.py                           code/plugins/meme_manager/main.py
copy_into /root/bot/astrbot/data/plugins/meme_manager/backend/semantic/models.py        code/plugins/meme_manager/models.py
copy_into /root/bot/astrbot/data/plugins/meme_manager/pages/shared/ui.js                code/plugins/meme_manager/ui.js

# systemd 单元
copy_into /root/.config/systemd/user        code/systemd

# TLS 中间件
copy_into /root/astrbot-tls.mjs             code/astrbot-tls.mjs

# 清理代码里的 __pycache__
find "$WORK/code" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

# ---------- 2. 敏感数据 ----------
say "收集敏感配置…"
copy_into /root/relay/relay.json                                secrets/relay.json
copy_into /root/relay/minimax-accounts.json                     secrets/minimax-accounts.json
copy_into /root/bot/astrbot/data/cmd_config.json                secrets/astrbot-cmd_config.json
copy_into /root/bot/astrbot/data/config/meme_manager_config.json secrets/meme_manager_config.json
copy_into /root/bot/astrbot/data/plugin_data/meme_manager/selection_rules.json secrets/meme_manager_selection_rules.json
copy_into /root/bot/astrbot/data/plugin_data/meme_manager/registry.json        secrets/meme_manager_registry.json
copy_into /root/bot/workbuddy-openai-proxy/config.json          secrets/workbuddy-config.json
copy_into /root/certs/astrbot.crt                               secrets/certs/astrbot.crt
copy_into /root/certs/astrbot.key                               secrets/certs/astrbot.key

# 账号池逐个
for f in /root/bot/workbuddy-openai-proxy/auth.*.pool.json; do
  [[ -f "$f" ]] || continue
  mkdir -p "$WORK/secrets/workbuddy-pools"
  cp -a "$f" "$WORK/secrets/workbuddy-pools/$(basename "$f")"
done
say "  ✓ 账号池 $(ls /root/bot/workbuddy-openai-proxy/auth.*.pool.json 2>/dev/null | wc -l) 个"

# AstrBot 数据卷：只备数据库和消息配置，不备 temp/dist
copy_into /root/bot/astrbot/data/data_v4.db    secrets/astrbot/data_v4.db
copy_into /root/bot/astrbot/data/webchat       secrets/astrbot/webchat
copy_into /root/bot/astrbot/data/plugins.json  secrets/astrbot/plugins.json

# ---------- 3. 元信息 ----------
say "写入元信息…"
{
  echo "备份时间: $STAMP"
  echo "主机名: $(hostname)"
  echo "内网IP: $(hostname -I | awk '{print $1}')"
  echo "系统: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
  echo "内核: $(uname -r)"
  echo "Node: $(node -v 2>/dev/null || echo 无)"
  echo "运行时长: $(uptime -p 2>/dev/null || uptime)"
  echo
  echo "--- 已启用的 systemd (user) ---"
  systemctl --user list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}'
  echo
  echo "--- 定时器 ---"
  systemctl --user list-timers --no-pager --no-legend 2>/dev/null | awk '{print $NF}'
  echo
  echo "--- 容器 ---"
  docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null
  echo
  echo "--- 端口 ---"
  ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | sort -u | head -30
} > "$WORK/BACKUP-INFO.txt" 2>/dev/null

# ---------- 4. 校验敏感文件可读（避免备出空包） ----------
say "校验完整性…"
FAIL=0
for f in "$WORK/secrets/relay.json" "$WORK/secrets/astrbot-cmd_config.json"; do
  if [[ ! -s "$f" ]]; then
    say "  ✗ 关键文件为空: $f"
    FAIL=1
  fi
done
if [[ $FAIL -ne 0 ]]; then
  say "关键文件缺失，放弃打包"
  exit 1
fi

# 脱敏副本（供公开仓库用）：把 key/token/password 换成占位符
say "生成脱敏配置…"
python3 - "$WORK" <<'PYEOF'
import json, os, re, sys

work = sys.argv[1]
out_dir = os.path.join(work, 'secrets', 'redacted')
os.makedirs(out_dir, exist_ok=True)

SECRET_KEYS = re.compile(r'(key|token|secret|password|passwd|pwd|cookie|authorization)', re.I)
PLACEHOLDER = "REPLACE_ME"

def scrub(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if SECRET_KEYS.search(k) and isinstance(v, (str, int, float)) and str(v).strip():
                s = str(v)
                # 保留结构但不泄露值
                out[k] = PLACEHOLDER if len(s) < 200 else PLACEHOLDER
            elif isinstance(v, (dict, list)):
                out[k] = scrub(v)
            else:
                out[k] = v
        return out
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    return obj

targets = {
    'relay.json': 'relay.example.json',
    'astrbot-cmd_config.json': 'astrbot-cmd_config.example.json',
    'meme_manager_config.json': 'meme_manager_config.example.json',
    'workbuddy-config.json': 'workbuddy-config.example.json',
    'minimax-accounts.json': 'minimax-accounts.example.json',
}
for src, dst in targets.items():
    p = os.path.join(work, 'secrets', src)
    if not os.path.exists(p):
        continue
    try:
        data = json.load(open(p, encoding='utf-8'))
    except Exception as e:
        print(f'  ! 跳过 {src}: {e}')
        continue
    cleaned = scrub(data)
    json.dump(cleaned, open(os.path.join(out_dir, dst), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    print(f'  ✓ {dst}')
PYEOF

# ---------- 5. 打包 ----------
say "打包…"
tar czf "$OUT" -C "$WORK" . 2>/dev/null
if [[ ! -s "$OUT" ]]; then
  say "打包失败"
  exit 1
fi
SIZE=$(du -h "$OUT" | cut -f1)
say "完成: $OUT ($SIZE)"

# 内容清单
tar tzf "$OUT" | sed 's|^\./||' | grep -v '/$' | sort > "$ROOT_DIR/last-manifest.txt"
CNT=$(wc -l < "$ROOT_DIR/last-manifest.txt")
say "包含 $CNT 个文件"

# 生成 SHA256 便于校验
sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"

rm -rf "$WORK"

# ---------- 6. 轮转 ----------
say "轮转旧备份（保留 $KEEP 份）…"
ls -1t "$ROOT_DIR"/dafeiyu-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
  say "  删除 $(basename "$old")"
done

say "全部完成。"
