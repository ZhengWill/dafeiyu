#!/usr/bin/env node
/** *
 * Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
 * 本文件为原创实现（接口经抓包实测），无第三方代码。

 * MiniMax OAuth 凭证自动续期。
 *
 * 为什么需要：模型网关和账号接口都用 mmoat_ 前缀的 OAuth access token，
 * 有效期 43200 秒（12 小时）。过期后 MiniMax 会从降级链里静默失效。
 *
 * 关键约束（实测确认）：
 *   1. 续期接口会**轮换 refresh token** —— 返回新的 mmort_，旧的立刻作废。
 *      所以必须把新的一对原子写回，否则下次续期必然 401。
 *   2. 网关要 Authorization: Bearer，且只认 OAuth token（x-api-key 会 401）。
 *
 * 接口：
 *   POST https://account.minimax.cn/oauth2/token
 *   grant_type=refresh_token & refresh_token=... & client_id=mcode-public
 *   & scope=agent.default & audience=agent-backend
 *
 * 用法：
 *   node minimax-refresh.mjs            需要时续期
 *   node minimax-refresh.mjs --force    强制续期（测试用）
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/root';
const RELAY_DIR = path.join(HOME, 'relay');
const ACCOUNTS_PATH = path.join(RELAY_DIR, 'minimax-accounts.json');
const RELAY_CFG = path.join(RELAY_DIR, 'relay.json');
const LOG_PATH = path.join(RELAY_DIR, 'minimax-refresh.log');

const AUTH_HOST = process.env.MM_AUTH_HOST || 'https://account.minimax.cn';
const CLIENT_ID = 'mcode-public';
const SCOPE = 'agent.default';
const AUDIENCE = 'agent-backend';

// 提前多久续期：剩余不足 2 小时就刷
const REFRESH_BEFORE_MS = 2 * 3600 * 1000;

const TZ = 'Asia/Shanghai';

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false })}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

function mask(s) {
  const v = String(s || '');
  return v.length > 14 ? v.slice(0, 10) + '…' + v.slice(-4) : v;
}

async function refreshOne(acc) {
  if (!acc.refreshToken) {
    return { ok: false, error: '没有 refreshToken' };
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: acc.refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPE,
    audience: AUDIENCE,
  });

  const r = await fetch(AUTH_HOST + '/oauth2/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(30000),
  });

  const text = await r.text();
  if (!r.ok) {
    return { ok: false, error: `HTTP ${r.status} ${text.slice(0, 160)}` };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, error: '续期响应不是 JSON: ' + text.slice(0, 120) };
  }
  const newAccess = j.access_token;
  if (typeof newAccess !== 'string' || !newAccess) {
    return { ok: false, error: '续期响应里没有 access_token' };
  }
  const newRefresh = typeof j.refresh_token === 'string' && j.refresh_token
    ? j.refresh_token
    : acc.refreshToken;   // 上游没轮换时沿用旧值
  const expiresInSec = typeof j.expires_in === 'number' ? j.expires_in : 43200;

  return {
    ok: true,
    accessToken: newAccess,
    refreshToken: newRefresh,
    expiresAt: Date.now() + expiresInSec * 1000,
    rotated: newRefresh !== acc.refreshToken,
    expiresInSec,
  };
}

async function verify(accessToken) {
  try {
    const r = await fetch('https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const j = await r.json();
    const br = j.base_resp || {};
    if (br.status_code && br.status_code !== 0) {
      return { ok: false, error: `${br.status_code} ${br.status_msg || ''}`.slice(0, 120) };
    }
    const sum = j.op_credit_summary || {};
    const n = Number(sum.total_remaining_amount);
    return { ok: true, credit: Number.isFinite(n) ? n : null };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}

async function main() {
  const force = process.argv.includes('--force');

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (e) {
    log(`读取账号池失败: ${e.message}`);
    process.exit(1);
  }
  const list = Array.isArray(raw) ? raw : raw.accounts || [];
  const enabled = list.filter((a) => a.enabled !== false);

  if (!enabled.length) {
    log('没有启用的账号，跳过');
    return;
  }

  let changed = false;
  let refreshed = 0;

  for (const acc of enabled) {
    const name = mask(acc.label || acc.id);
    const remainMs = acc.expiresAt ? Number(acc.expiresAt) - Date.now() : 0;
    const needRefresh = force || !acc.accessToken || remainMs < REFRESH_BEFORE_MS;

    if (!needRefresh) {
      const h = Math.floor(remainMs / 3600000);
      log(`[${name}] 凭证还有 ${h} 小时，不需要续期`);
      continue;
    }

    const why = force ? '强制' : (acc.accessToken ? `剩余 ${Math.max(0, Math.floor(remainMs / 60000))} 分钟` : '缺少 access token');
    log(`[${name}] 需要续期（${why}）`);

    let res;
    try {
      res = await refreshOne(acc);
    } catch (e) {
      log(`[${name}] 续期异常: ${String(e).slice(0, 140)}`);
      acc.lastRefreshOk = false;
      acc.lastRefreshMsg = String(e).slice(0, 140);
      changed = true;
      continue;
    }

    if (!res.ok) {
      log(`[${name}] 续期失败: ${res.error}`);
      acc.lastRefreshOk = false;
      acc.lastRefreshMsg = res.error;
      acc.lastRefreshAt = Date.now();
      changed = true;
      continue;
    }

    const v = await verify(res.accessToken);
    if (!v.ok) {
      log(`[${name}] 续期成功但新 token 验证失败: ${v.error}（保留旧凭证）`);
      acc.lastRefreshOk = false;
      acc.lastRefreshMsg = '新 token 验证失败: ' + v.error;
      acc.lastRefreshAt = Date.now();
      changed = true;
      continue;
    }

    acc.accessToken = res.accessToken;
    acc.refreshToken = res.refreshToken;
    acc.expiresAt = res.expiresAt;
    acc.lastRefreshAt = Date.now();
    acc.lastRefreshOk = true;
    acc.lastRefreshMsg = `续期成功${res.rotated ? '（refresh token 已轮换）' : ''}，余额 ${v.credit ?? '?'}`;
    changed = true;
    refreshed++;

    const hrs = Math.round(res.expiresInSec / 3600);
    log(`[${name}] ✅ 续期成功，有效 ${hrs} 小时${res.rotated ? '，refresh token 已轮换' : ''}，余额 ${v.credit ?? '?'}`);
  }

  if (changed) {
    raw.updatedAt = Date.now();
    atomicWrite(ACCOUNTS_PATH, JSON.stringify(raw, null, 2) + '\n');

    // 同步到 relay.json 的 provider key，让它立刻用上新 token
    try {
      const cfg = JSON.parse(fs.readFileSync(RELAY_CFG, 'utf8'));
      const prov = (cfg.providers || []).find((p) => p.id === 'minimax');
      if (prov) {
        const main = enabled[0];
        if (main && main.accessToken) {
          prov.key = main.accessToken;
          prov.accounts = list.map((a) => ({
            id: a.id,
            label: a.label || a.id,
            enabled: a.enabled !== false,
            checkinEnabled: a.checkinEnabled !== false,
            expiresAt: a.expiresAt || null,
          }));
          atomicWrite(RELAY_CFG, JSON.stringify(cfg, null, 2) + '\n', 0o644);
          log('已同步新凭证到 relay.json');
        }
      }
    } catch (e) {
      log(`同步 relay.json 失败: ${e.message}`);
    }
  }

  log(`完成：本次续期 ${refreshed} 个账号`);
}

main().catch((e) => {
  log('未捕获异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
