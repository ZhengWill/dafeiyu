#!/bin/bash
# AstrBot ↔ QQ 协议端 连接守卫
# Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
#
# 解决什么问题：AstrBot 和协议端（NapCat/SnowLuma）之间的 WebSocket 偶尔会断，
# 断了之后 AstrBot 不报错，只是「不说话」——非常难发现。
#
# 核心原则：只重启 AstrBot，不碰协议端。
#   因为协议端重启会掉登录，要重新扫码——代价远大于收益。
#
# 检查四层：
#   1. AstrBot 容器是否在跑
#   2. 容器内 OneBot WS 端口是否监听
#   3. 最近的 WS 错误数 + 是否有消息进来（两者同时异常才判定断连）
#   4. OneBot HTTP 接口是否还活着（判断 QQ 是否掉线）
#
# 本文件为原创实现，无第三方代码。
#
# 环境变量：
#   OB_PORT      OneBot HTTP 端口，默认 3000
#   OB_TOKEN     OneBot access token
#   CHECK_SEC    检查间隔，默认 120

LOG=${LOG_FILE:-/root/bot/conn-guard.log}
STATE=${STATE_FILE:-/root/bot/conn-guard-state.json}

log() { echo "[$(date '+%F %T')] $1" >> "$LOG"; }

check() {
  # 1) AstrBot 容器是否在跑
  if ! docker ps --filter name=astrbot --format '{{.Names}}' | grep -q astrbot; then
    log "AstrBot 容器未运行，尝试启动"
    docker start astrbot >> "$LOG" 2>&1
    sleep 30
    return
  fi

  # 2) AstrBot 容器内 6199 是否监听
  local listening
  listening=$(docker exec astrbot python3 -c "
import socket
s=socket.socket(); s.settimeout(2)
try:
    s.connect(('127.0.0.1',6199)); print('yes')
except: print('no')
" 2>/dev/null)

  if [ "$listening" != "yes" ]; then
    log "6199 未监听，重启 AstrBot"
    docker restart astrbot >> "$LOG" 2>&1
    sleep 40
    return
  fi

  # 3) NapCat 是否连上（看最近 3 分钟有没有 WS 错误，且有没有消息进来）
  local recent_err recent_msg
  recent_err=$(docker logs --since 3m napcat 2>&1 | grep -c 'WebSocket.*连接错误' || echo 0)
  recent_msg=$(docker logs --since 3m astrbot 2>&1 | grep -c 'event_bus' || echo 0)

  # 有持续 WS 错误 且 完全没有消息进来 → 判定断连
  if [ "$recent_err" -gt 3 ] && [ "$recent_msg" -eq 0 ]; then
    log "检测到 NapCat WS 反复失败（错误 $recent_err 次）且无消息，重启 AstrBot"
    docker restart astrbot >> "$LOG" 2>&1
    sleep 45
    # 重启后确认
    local after
    after=$(docker logs --since 1m astrbot 2>&1 | grep -c '适配器已连接' || echo 0)
    if [ "$after" -gt 0 ]; then
      log "✅ 重连成功"
    else
      log "⚠️ 重启后仍未连接，等下一轮"
    fi
    return
  fi

  # 4) 检查 OneBot 是否还活着
  local ob
  ob=$(curl -sS -m 5 -H "Authorization: Bearer $OB_TOKEN" \
        "http://127.0.0.1:$OB_PORT/get_login_info" 2>/dev/null | grep -c '"status":"ok"' || echo 0)
  if [ "$ob" -eq 0 ]; then
    log "⚠️ OneBot 无响应（QQ 可能掉线，需人工扫码）"
  fi
}

OB_PORT="${OB_PORT:-3000}"
OB_TOKEN="${OB_TOKEN:-}"
CHECK_SEC="${CHECK_SEC:-120}"

log "=== 连接守护启动 ==="
while true; do
  check
  sleep "$CHECK_SEC"
done
