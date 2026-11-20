#!/usr/bin/env node
/**
 * 自动同意好友 / 群邀请（独立进程版 —— 已被插件版取代）
 * Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
 *
 * 【状态：历史方案，保留作参考】
 * 现在推荐用 plugins/astrbot_plugin_auto_accept（插件形式，不用额外进程）。
 * 这个独立进程版的价值在于：它演示了怎么绕过 AstrBot 直接对接 OneBot WS，
 * 在你需要监听 AstrBot 不转发的事件类型时可以参考。
 *
 * 原理：直连 OneBot 的 WebSocket，监听 post_type=request 事件，
 *       对 add（加好友）和 invite（邀请入群）自动调 approve 接口。
 *
 * 本文件为原创实现，无第三方代码。
 *
 * 环境变量：
 *   WS_URL     协议端 WS 地址，默认 ws://127.0.0.1:3001
 *   OB_HTTP    OneBot HTTP 地址，默认 http://127.0.0.1:3000
 *   OB_TOKEN   OneBot access token（必填）
 *   WS_MODULE  ws 模块路径，默认从本地 node_modules 找
 */
// ws 模块是动态加载的（路径可通过 WS_MODULE 覆盖），因为 import 语句不能带表达式
const _wsMod = process.env.WS_MODULE || 'ws';
const WebSocket = (await import(_wsMod)).default;

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:3001';
const TOKEN = process.env.OB_TOKEN || '';
const HTTP = process.env.OB_HTTP || 'http://127.0.0.1:3000';

if (!TOKEN) {
  console.error('[auto-accept] 缺少 OB_TOKEN 环境变量');
  process.exit(1);
}

const log = (m) => console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${m}`);

async function api(action, payload) {
  try {
    const r = await fetch(`${HTTP}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}

function connect() {
  const ws = new WebSocket(WS_URL, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  ws.on('open', () => log('已连接 OneBot WS'));

  ws.on('message', async (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }

    // 好友请求
    if (ev.post_type === 'request' && ev.request_type === 'friend') {
      log(`好友请求：${ev.user_id} 昵称=${ev.comment || ''}`);
      const r = await api('set_friend_add_request', { flag: ev.flag, approve: true });
      log(`  → 同意结果: ${JSON.stringify(r).slice(0, 120)}`);
      return;
    }

    // 群邀请
    if (ev.post_type === 'request' && ev.request_type === 'group') {
      log(`群邀请：群=${ev.group_id} 邀请人=${ev.user_id}`);
      const r = await api('set_group_add_request', {
        flag: ev.flag, sub_type: ev.sub_type || 'invite', approve: true,
      });
      log(`  → 同意结果: ${JSON.stringify(r).slice(0, 120)}`);
      return;
    }
  });

  ws.on('close', () => {
    log('连接断开，5 秒后重连');
    setTimeout(connect, 5000);
  });

  ws.on('error', (e) => log(`WS 错误: ${e.message}`));
}

log('=== 自动同意好友/群邀请 启动 ===');
connect();
