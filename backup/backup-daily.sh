#!/usr/bin/env bash
# 每日备份 + 推送 GitHub。给 systemd timer 调用。
# Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
#
# 串联两步：backup.sh 打包 → push_backup.py 上传。
# 任何一步失败都以非零退出，让 systemd 记失败（方便 journalctl 查）。
#
# 环境变量：
#   BACKUP_ROOT  备份目录，默认 /root/backups
#   BACKUP_HOME  工作目录，默认 /root
#
# 本文件为原创实现，无第三方代码。
set -uo pipefail

BACKUP_HOME="${BACKUP_HOME:-/root}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/backups}"

cd "$BACKUP_HOME" || exit 1
LOG="$BACKUP_ROOT/backup.log"
mkdir -p "$BACKUP_ROOT"

{
  echo "========================================"
  echo "开始: $(date '+%Y-%m-%d %H:%M:%S')"
} >> "$LOG"

# 1) 打包
if ! "$BACKUP_HOME/backup.sh" >> "$LOG" 2>&1; then
  echo "备份失败，终止" >> "$LOG"
  exit 1
fi

# 2) 推送（token 从文件读，不写进 unit）
if [[ -f "$BACKUP_HOME/.ghtoken" ]]; then
  GITHUB_TOKEN=$(cat "$BACKUP_HOME/.ghtoken") python3 "$BACKUP_HOME/push_backup.py" >> "$LOG" 2>&1
  RC=$?
  if [[ $RC -ne 0 ]]; then
    echo "推送失败 (exit $RC)" >> "$LOG"
    exit $RC
  fi
else
  echo "缺少 $BACKUP_HOME/.ghtoken，跳过推送（仅本地备份）" >> "$LOG"
fi

echo "完成: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"

# 日志超过 1MB 就截断
if [[ -f "$LOG" ]] && [[ $(stat -c%s "$LOG") -gt 1048576 ]]; then
  tail -c 500000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
