#!/usr/bin/env python3
"""
把中转站状态整理成插件可读的精简 JSON，写入 AstrBot 的 data 目录。

Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)

为什么需要这一层：
  relay-state.json 是网关内部格式，字段多、体积大（含每个模型每天的明细）。
  插件的 #白饭 指令只需要「今天用了多少、主力是哪个」几个数，
  直接读原文件既慢又容易在版本变化时炸掉。

  所以这里做一次「降维」：把 state 压成固定 schema 的小 JSON，
  插件只依赖这个小文件，两边解耦。

由 cron 每分钟执行。失败时保留上一次的产物，不覆盖 —— 
这样即使中转站临时挂了，插件看到的仍是最后一次成功的数据，而不是空。

本文件为原创实现，无第三方代码。

用法：
  python3 sync_relay_usage.py

环境变量（都有默认值）：
  RELAY_CFG     默认 /root/relay/relay.json
  RELAY_STATE   默认 /root/relay/relay-state.json
  USAGE_OUT     默认 /root/bot/astrbot/data/relay-usage.json
"""
import json
import os
import sys
import tempfile
import time

RELAY_CFG = os.environ.get("RELAY_CFG", "/root/relay/relay.json")
RELAY_STATE = os.environ.get("RELAY_STATE", "/root/relay/relay-state.json")
OUT = os.environ.get("USAGE_OUT", "/root/bot/astrbot/data/relay-usage.json")


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def model_key(entry):
    if not entry:
        return ""
    pid = entry.get("providerId") or ""
    mid = entry.get("modelId") or ""
    if pid and mid:
        return pid + "/" + mid
    return mid or pid


def chain_head(cfg):
    """降级链里第一条启用的 = 聊天主力"""
    chain = cfg.get("chain") or []
    for c in chain:
        if c.get("enabled") is not False and c.get("modelId"):
            return c
    return chain[0] if chain else {}


def main():
    cfg = load(RELAY_CFG)
    state = load(RELAY_STATE)

    vis = cfg.get("visionModel") or {}
    head = chain_head(cfg)

    out = {
        "generatedAt": int(time.time() * 1000),
        "chatMain": {
            "key": model_key(head),
            "providerId": head.get("providerId", ""),
            "modelId": head.get("modelId", ""),
            "enabled": head.get("enabled", True) is not False,
        },
        "visionMain": {
            "key": model_key(vis),
            "providerId": vis.get("providerId", ""),
            "modelId": vis.get("modelId", ""),
            "enabled": vis.get("enabled", False) is True,
        },
        "days": (state.get("usage") or {}).get("days") or {},
    }

    d = os.path.dirname(OUT)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".relay-usage-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        os.chmod(tmp, 0o644)
        os.replace(tmp, OUT)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise
    print("wrote", OUT, "days=", len(out["days"]),
          "chat=", out["chatMain"]["key"], "vision=", out["visionMain"]["key"])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("sync_relay_usage failed:", e, file=sys.stderr)
        sys.exit(1)
