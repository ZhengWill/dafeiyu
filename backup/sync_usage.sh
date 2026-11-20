#!/bin/bash
# 每分钟把代理的 usage.json 同步进 AstrBot 挂载目录
# Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
#
# 为什么需要：代理和 AstrBot 在不同容器里，代理的用量统计文件
# AstrBot 读不到。这里用一个共享挂载目录做中转。
#
# 注：如果用的是 relay（中转站），更推荐 relay/sync_relay_usage.py ——
# 它会先把状态「降维」成精简 JSON，而不是原样搬运。
#
# 本文件为原创实现，无第三方代码。
SRC="${USAGE_SRC:-/root/bot/workbuddy-openai-proxy/usage.json}"
DST="${USAGE_DST:-/root/bot/astrbot/data/usage.json}"
INTERVAL="${USAGE_INTERVAL:-60}"

while true; do
  cp -f "$SRC" "$DST" 2>/dev/null
  sleep "$INTERVAL"
done
