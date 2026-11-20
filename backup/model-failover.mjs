#!/usr/bin/env node
/**
 * 模型自动降级守护 v6（中转站的前身）
 * Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
 *
 * 【状态：历史方案，已被 relay/relay.mjs 完全取代】
 *
 * 为什么还留着：它是中转站的演化起点，能看清「为什么要做中转站」这个问题。
 * 这个脚本的局限正好解释了 relay 的设计取舍：
 *
 *   1. 降级链写死在代码里 —— 改一次顺序要改代码 + 重启
 *      → relay 把它变成配置 + 网页拖拽
 *
 *   2. 只能判断「通不通」，不能分类错误 —— 欠费、限流、key失效一视同仁
 *      → relay 分了 quota / rate / auth / network / upstream 五类
 *
 *   3. 只会「往下降」，恢复靠定时轮询 —— 每次都要重启 proxy 进程
 *      → relay 冷却到期自动重试，不重启任何进程
 *
 *   4. 每个供应商的 key 写死在脚本里 —— 换 key 要改代码
 *      → relay 走独立配置 + 密钥单独管理
 *
 * 原理：定期探测链头模型是否可用，失败就切到下一个，并把 workbuddy-proxy
 *       的 config.json 改成新模型，然后重启该服务。
 *
 * 本文件为原创实现，无第三方代码。
 *
 * 环境变量：
 *   FAILOVER_CONFIG  被改写的代理配置，默认 workbuddy-proxy 的 config.json
 *   FAILOVER_STATE   状态文件路径
 *   PROXY_KEY        代理访问密钥
 *   PROXY_BASE       代理地址，默认 http://127.0.0.1:8788/v1
 */
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const CONFIG = process.env.FAILOVER_CONFIG || '/root/bot/workbuddy-openai-proxy/config.json';
const STATE = process.env.FAILOVER_STATE || '/root/bot/model-failover-state.json';
const PROXY_KEY = process.env.PROXY_KEY || '';
const PROXY_BASE = process.env.PROXY_BASE || 'http://127.0.0.1:8788/v1';

// 降级链 —— 这就是后来 relay 里 chain 配置的雏形。
// key 一律从环境变量读，示例里用占位符。
const CHAIN = [
  { id: 'intl-free', site: 'intl-work', model: 'deepseek-v4.1-flash',
    label: '国际版免费' },
  { id: 'cn',        site: 'cn-cli',    model: 'deepseek-v4.1-flash',
    label: '国内版' },
  { id: 'intern',    direct: true,
    model: 'deepseek-v4.1-flash-1017',
    base: 'https://discovery-api.intern-ai.org.cn/v1',
    key: process.env.KEY_INTERN || 'REPLACE_ME',
    label: '备用供应商 A' },
  { id: 'intl-sg',   site: 'intl-work', model: 'deepseek-v4.1-flash-sg',
    label: '国际版 SG' },
  { id: 'nova',      direct: true,
    model: '[free]deepseek-v4.1-flash',
    base: 'https://once-cf.novai.su/v1',
    key: process.env.KEY_NOVA || 'REPLACE_ME',
    label: '备用供应商 B' },
];

const log = (msg) =>
  process.stdout.write(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${msg}\n`);

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { current: 1, failures: {} }; } };
const saveState = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {} };
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

async function restartProxy() {
  await execAsync('systemctl --user restart workbuddy-proxy', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 4500));
}

async function testCurrent() {
  const c = readConfig();
  const site = c.defaultSite;
  const model = (c.allowModels || [])[0];
  if (!site || !model) return { ok: false, reason: '配置缺失' };

  try {
    const r = await fetch(`${PROXY_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PROXY_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, max_tokens: 8,
        messages: [{ role: 'user', content: '回一个字' }] }),
      signal: AbortSignal.timeout(25000),
    });
    const actualSite = r.headers.get('x-upstream-site') || '?';
    const text = await r.text();
    if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}` };
    if (actualSite !== site) return { ok: false, reason: `站点漂移 ${site}->${actualSite}` };
    if (/额度耗尽|usage exceeds|rate limit/i.test(text)) return { ok: false, reason: '额度耗尽' };
    return { ok: true, site, model };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 80) };
  }
}

async function testCandidate(entry) {
  if (entry.direct) {
    try {
      const r = await fetch(`${entry.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${entry.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: entry.model, stream: false, max_tokens: 8,
          messages: [{ role: 'user', content: '回一个字' }] }),
        signal: AbortSignal.timeout(25000),
      });
      const text = await r.text();
      if (r.status === 200 && !/"error"/.test(text)) return { ok: true };
      return { ok: false, reason: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, reason: String(e).slice(0, 80) }; }
  }

  const orig = readConfig();
  try {
    fs.writeFileSync(CONFIG, JSON.stringify({ ...orig, defaultSite: entry.site, allowModels: [entry.model] }, null, 2));
    await restartProxy();
    const r = await fetch(`${PROXY_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PROXY_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: entry.model, stream: true, max_tokens: 8,
        messages: [{ role: 'user', content: '回一个字' }] }),
      signal: AbortSignal.timeout(25000),
    });
    const actualSite = r.headers.get('x-upstream-site') || '?';
    const text = await r.text();
    if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}` };
    if (actualSite !== entry.site) return { ok: false, reason: `站点漂移 ${actualSite}` };
    if (/额度耗尽|usage exceeds|rate limit/i.test(text)) return { ok: false, reason: '额度耗尽' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 80) };
  } finally {
    fs.writeFileSync(CONFIG, JSON.stringify(orig, null, 2));
    await restartProxy();
  }
}

async function applyProxy(entry) {
  const c = readConfig();
  c.defaultSite = entry.site;
  c.allowModels = [entry.model];
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  await restartProxy();
  log(`  proxy -> ${entry.site} / ${entry.model}`);
}

async function applyAstrBot(entry) {
  const pid = entry.provider || 'wb-flash';
  const fallback = pid === 'nova-flash' ? [] : ['nova-flash'];

  let current = '';
  try {
    const { stdout } = await execAsync(
      `docker exec astrbot python3 -c "import json;d=json.load(open('/AstrBot/data/cmd_config.json',encoding='utf-8-sig'));print(d['agent_runner']['config']['model']['provider_id'])"`,
      { timeout: 15000 });
    current = stdout.trim();
  } catch {}

  if (current === pid) {
    log(`  AstrBot 已是 ${pid}`);
    return true;
  }

  const py = [
    'import json',
    "p='/AstrBot/data/cmd_config.json'",
    "d=json.load(open(p, encoding='utf-8-sig'))",
    "m=d['agent_runner']['config']['model']",
    `m['provider_id']='${pid}'`,
    `m['fallback_provider_ids']=${JSON.stringify(fallback)}`,
    "json.dump(d, open(p,'w',encoding='utf-8'), ensure_ascii=False, indent=2)",
    "print('OK')",
  ].join('\n');

  fs.writeFileSync('/tmp/sw.py', py);
  try {
    await execAsync('docker cp /tmp/sw.py astrbot:/tmp/sw.py', { timeout: 15000 });
    await execAsync('docker exec astrbot python3 /tmp/sw.py', { timeout: 20000 });
    log(`  AstrBot -> ${pid}，重启…`);
    await execAsync('docker restart astrbot', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 12000));
    for (let i = 0; i < 10; i++) {
      const { stdout } = await execAsync(
        `docker logs --tail 40 astrbot 2>&1 | grep -c '适配器已连接'`, { timeout: 10000 }
      ).catch(() => ({ stdout: '0' }));
      if (parseInt(stdout.trim()) > 0) { log(`  ✅ AstrBot 已重连`); return true; }
      await new Promise((r) => setTimeout(r, 5000));
    }
    return false;
  } catch (e) {
    log(`  AstrBot 切换失败: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/** 主检查：降级 + 自动回升 */
async function tick() {
  const state = loadState();
  log(`--- 检查（当前 ${state.current}: ${CHAIN[state.current]?.label}）---`);

  // 1) 当前可用？
  const cur = await testCurrent();
  if (cur.ok) {
    log(`  ✅ 当前可用`);

    // ===== 关键：检查有没有更高级别恢复了 =====
    if (state.current > 0) {
      log(`  🔍 检查更高级别是否恢复…`);
      for (let i = 0; i < state.current; i++) {
        const up = CHAIN[i];
        log(`    测试 [${i}] ${up.label}`);
        const r = await testCandidate(up);
        if (r.ok) {
          log(`  ⬆️ ${up.label} 已恢复，自动切回！`);
          if (!up.direct) await applyProxy(up);
          await applyAstrBot(up);
          state.current = i;
          saveState(state);
          log(`  ✅ 已切回 ${up.label}`);
          return;
        }
        log(`    仍不可用：${r.reason}`);
      }
      log(`  （无更高级别恢复，保持当前）`);
    }
    return;
  }

  log(`  ❌ 当前不可用：${cur.reason}`);

  // 2) 降级
  for (let i = state.current + 1; i < CHAIN.length; i++) {
    const entry = CHAIN[i];
    log(`  测试 [${i}] ${entry.label}`);
    const r = await testCandidate(entry);
    if (r.ok) {
      log(`  ✅ ${entry.label} 可用，降级切换`);
      if (!entry.direct) await applyProxy(entry);
      await applyAstrBot(entry);
      state.current = i;
      saveState(state);
      return;
    }
    log(`  ❌ ${entry.label}: ${r.reason}`);
    state.failures[i] = { at: Date.now(), reason: r.reason };
    saveState(state);
  }
  log(`  🚨 全部不可用`);
}

log('=== 模型自动降级 v6（支持自动回升）===');
log(`链: ${CHAIN.map((c) => c.label).join(' → ')}`);
(async () => {
  await tick();
  // 每 15 分钟检查一次（比之前 10 分钟稍长，减少干扰）
  setInterval(() => tick().catch((e) => log(`异常: ${e}`)), 15 * 60 * 1000);
})();
