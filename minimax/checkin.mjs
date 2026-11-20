#!/usr/bin/env node
/**
 * MiniMax 自动签到。
 *
 * 接口（实测 2026-11-20）：
 *   GET  /minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai
 *   POST /minimax-cloud/api/v1/signin/claim
 * 两个都要 mmoat_ OAuth 凭证，且必须带 IANA 时区名，否则回 invalid timezone_id。
 *
 * 7 天一个周期共 4000 分（400x5 + 1000x2），签到本身幂等：
 * 重复签到会回 already claimed，不会重复发放。
 *
 * 用法：
 *   node minimax-checkin.mjs          正常跑（带随机延迟）
 *   node minimax-checkin.mjs --now    立即跑，跳过延迟
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/root';
const CFG_DIR = path.join(HOME, 'relay');
const ACCOUNTS_PATH = path.join(CFG_DIR, 'minimax-accounts.json');
const LOG_PATH = path.join(CFG_DIR, 'minimax-checkin.log');

const BASE = 'https://agent.minimax.cn';
const TZ = process.env.MM_TZ || 'Asia/Shanghai';
const API = {
  status: '/minimax-cloud/api/v1/signin/status',
  claim: '/minimax-cloud/api/v1/signin/claim',
  member: '/matrix/api/v1/commerce/get_membership_info',
};

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false })}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

function loadAccounts() {
  const raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.accounts || [];
  return arr;
}

function saveAccounts(raw) {
  const tmp = ACCOUNTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_PATH);
}

function mask(label) {
  const s = String(label || '');
  if (s.length <= 8) return s;
  return s.slice(0, 4) + '***' + s.slice(-4);
}

async function call(acc, apiPath, method = 'GET', body) {
  const url = BASE + apiPath + (method === 'GET' ? `?timezone_id=${encodeURIComponent(TZ)}` : '');
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + acc.accessToken,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

async function statusOf(acc) {
  const r = await call(acc, API.status);
  if (!r.ok || !r.json) return { ok: false, error: `HTTP ${r.status} ${r.text.slice(0, 100)}` };
  const days = (r.json.data || {}).days || [];
  const today = days.find((d) => d.is_today) || null;
  const total = days.reduce((n, d) => n + (Number(d.points) || 0) + (Number(d.bonus_points) || 0), 0);
  const claimed = days.filter((d) => d.status === 3).length;
  return { ok: true, today, days, total, claimed };
}

async function claimOf(acc) {
  const r = await call(acc, API.claim, 'POST', { timezone_id: TZ });
  if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.text.slice(0, 120)}` };
  const j = r.json || {};
  if (j.base_resp && j.base_resp.status_code && j.base_resp.status_code !== 0) {
    return { ok: false, error: `code ${j.base_resp.status_code} ${j.base_resp.status_msg || ''}`.slice(0, 140) };
  }
  const data = j.data || {};
  // claim_result: 1=已发放 2=今天已领过
  return {
    ok: true,
    result: data.claim_result,
    points: data.points ?? data.claim_points ?? null,
    raw: data,
  };
}

async function balanceOf(acc) {
  const r = await call(acc, API.member, 'POST', {});
  if (!r.ok || !r.json) return null;
  const sum = (r.json.op_credit_summary || {});
  const n = Number(sum.total_remaining_amount);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const now = process.argv.includes('--now');

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (e) {
    log(`读取账号池失败: ${e.message}`);
    process.exit(1);
  }
  const list = Array.isArray(raw) ? raw : raw.accounts || [];
  const enabled = list.filter((a) => a.enabled !== false && a.checkinEnabled !== false);

  log(`MiniMax 签到开始，待处理 ${enabled.length} 个账号（共 ${list.length} 个）`);

  if (!now && enabled.length) {
    // 0~30 分钟随机延迟，避免每天固定时刻打上游
    const delayMin = Math.floor(Math.random() * 30);
    if (delayMin > 0) {
      log(`随机延迟 ${delayMin} 分钟后开始签到…`);
      await new Promise((r) => setTimeout(r, delayMin * 60 * 1000));
    }
  }

  let claimedCount = 0;
  let failCount = 0;

  for (const acc of enabled) {
    const name = mask(acc.label || acc.id);
    try {
      const st = await statusOf(acc);
      if (!st.ok) {
        log(`[${name}] 查询签到状态失败: ${st.error}`);
        acc.lastCheckinOk = false;
        acc.lastCheckinMsg = st.error;
        failCount++;
        continue;
      }

      const today = st.today;
      const already = today && today.status === 3;
      if (already) {
        log(`[${name}] 今天已签到（第 ${today.day_no} 天，本周期已签 ${st.claimed}/7）`);
        acc.lastCheckinOk = true;
        acc.lastCheckinSkipped = true;
        acc.lastCheckinAt = Date.now();
        acc.lastCheckinMsg = `今天已签到（第 ${today.day_no} 天）`;
        continue;
      }
      if (today && today.status === 4) {
        log(`[${name}] 今天是无奖励日，跳过`);
        acc.lastCheckinSkipped = true;
        acc.lastCheckinMsg = '今天是无奖励日';
        continue;
      }

      const c = await claimOf(acc);
      if (!c.ok) {
        log(`[${name}] 签到失败: ${c.error}`);
        acc.lastCheckinOk = false;
        acc.lastCheckinMsg = c.error;
        failCount++;
        continue;
      }

      if (c.result === 2) {
        log(`[${name}] 上游说今天已领过（幂等）`);
        acc.lastCheckinOk = true;
        acc.lastCheckinSkipped = true;
        acc.lastCheckinMsg = '今天已领过';
      } else {
        const bal = await balanceOf(acc);
        const pts = c.points != null ? `+${c.points} 积分` : '签到成功';
        const balTxt = bal != null ? `，当前余额 ${bal}` : '';
        log(`[${name}] ✅ ${pts}${balTxt}`);
        acc.lastCheckinOk = true;
        acc.lastCheckinSkipped = false;
        acc.lastCheckinMsg = `✅ ${pts}${balTxt}`;
        claimedCount++;
      }
      acc.lastCheckinAt = Date.now();
    } catch (e) {
      log(`[${name}] 异常: ${String(e).slice(0, 140)}`);
      acc.lastCheckinOk = false;
      acc.lastCheckinMsg = String(e).slice(0, 140);
      failCount++;
    }
    // 多号之间稍作间隔
    await new Promise((r) => setTimeout(r, 800));
  }

  // 写回状态
  try {
    if (Array.isArray(raw)) raw.splice(0, raw.length, ...list);
    else {
      raw.accounts = list;
      raw.updatedAt = Date.now();
    }
    saveAccounts(raw);
  } catch (e) {
    log(`写回账号池失败: ${e.message}`);
  }

  log(`完成：本次实际签到 ${claimedCount} 个账号，失败 ${failCount} 个`);
}

main().catch((e) => {
  log('未捕获异常: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
