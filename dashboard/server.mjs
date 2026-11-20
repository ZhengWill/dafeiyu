#!/usr/bin/env node
/**
 * 大肥鱼控制台 - 后端
 * 纯 Node 标准库，零依赖。监听 127.0.0.1:8080
 */
import http from 'node:http';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import zlib from 'node:zlib';

const execAsync = promisify(exec);
const PORT = 8080;
const HOST = '0.0.0.0';
const STATIC_DIR = '/root/dashboard';

// ============ SnowLuma（QQ 协议端）============
// QQ 端已从 NapCat 换成 SnowLuma。OneBot token 从持久卷里的 onebot.json 读，
// 不写死 —— 换号或重建容器后 token 会变，读文件才不用改代码。
const SL_CONFIG = '/var/lib/docker/volumes/qq-gateway-data/_data/config';
const SL_WEBUI  = 5099;   // SnowLuma WebUI
const SL_VNC    = 6081;   // noVNC 远程桌面（扫码登录用）
const AB_PORT   = 6185;   // AstrBot 面板
const PX_PORT   = 8788;   // WorkBuddy proxy
const RELAY_PORT = 8790;
// 中转站管理密钥，必须与 relay.json 的 apiKey 一致
const RELAY_KEY = process.env.RELAY_KEY || '';  // 大肥鱼中转站
// SnowLuma WebUI 密码，用于给「SnowLuma」按钮现签免密令牌
const SL_PASSWORD = process.env.SL_PASSWORD || '';
const SL_PUBLIC_HOST = process.env.SL_PUBLIC_HOST || 'localhost';

let _tok = { v: '', at: 0 };
function oneBotToken() {
  const now = Date.now();
  if (_tok.v && now - _tok.at < 60000) return _tok.v;
  try {
    const j = JSON.parse(fs.readFileSync(`${SL_CONFIG}/onebot.json`, 'utf8'));
    const sv = j && j.networks && j.networks.httpServers && j.networks.httpServers[0];
    if (sv && sv.accessToken) { _tok = { v: sv.accessToken, at: now }; return _tok.v; }
  } catch {}
  return '';
}

// ============ 工具 ============
async function sh(cmd, timeout = 8000) {
  try {
    const { stdout } = await execAsync(cmd, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    return '';
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ============ 服务状态 ============
async function getServices() {
  const token = oneBotToken();
  const [ps, proxyActive, relayActive, qqInfo, slCode] = await Promise.all([
    sh('docker ps --format "{{.Names}}|{{.Status}}|{{.Image}}"'),
    sh('systemctl --user is-active workbuddy-proxy'),
    sh('systemctl --user is-active relay'),
    token
      ? sh(`curl -sS -m 3 -H "Authorization: Bearer ${token}" http://127.0.0.1:3000/get_login_info`)
      : Promise.resolve(''),
    sh(`curl -sS -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:${SL_WEBUI}/`),
  ]);

  const containers = {};
  for (const line of ps.split('\n')) {
    if (!line.trim()) continue;
    const [name, status] = line.split('|');
    containers[name] = status || '';
  }

  let qq = null;
  try {
    const j = JSON.parse(qqInfo);
    if (j.status === 'ok' && j.data && j.data.user_id) {
      qq = { uid: j.data.user_id, nick: j.data.nickname || '' };
    }
  } catch {}

  const isUp = (s) => /Up /i.test(s || '');

  return {
    snowluma: {
      name: 'SnowLuma',
      up: isUp(containers.snowluma),
      status: containers.snowluma || '未运行',
      port: `${SL_WEBUI} / ${SL_VNC} / 3000 / 3001`,
      desc: 'QQ 协议端',
      webui: slCode === '200',
      loggedIn: !!qq,
    },
    astrbot: {
      name: 'AstrBot',
      up: isUp(containers.astrbot),
      status: containers.astrbot || '未运行',
      port: `${AB_PORT}`,
      desc: 'Bot 框架',
    },
    relay: {
      name: '中转站',
      up: relayActive === 'active',
      status: relayActive === 'active' ? '运行中' : '已停止',
      port: `${RELAY_PORT}`,
      desc: '统一模型网关 · 自动降级',
    },
    qq,
  };
}

// ============ 系统指标 ============
async function getSystem() {
  const [memRaw, cpuRaw, diskRaw, upRaw, swapRaw] = await Promise.all([
    sh('free -b'),
    sh(`top -bn1 | grep -E '^%Cpu' | head -1`),
    sh('df -B1 / | tail -1'),
    sh('cat /proc/uptime'),
    sh('free -b | grep -i swap'),
  ]);

  // 内存
  let mem = { total: 0, used: 0, free: 0, avail: 0 };
  for (const line of memRaw.split('\n')) {
    if (line.startsWith('Mem:')) {
      const p = line.split(/\s+/).filter(Boolean);
      mem = { total: +p[1], used: +p[2], free: +p[3], avail: +p[6] };
    }
  }

  // CPU
  let cpu = 0;
  const m = cpuRaw.match(/([\d.]+)\s*id/);
  if (m) cpu = Math.round(100 - parseFloat(m[1]));

  // 磁盘
  let disk = { total: 0, used: 0, avail: 0, pct: 0 };
  const dp = diskRaw.split(/\s+/);
  if (dp.length >= 4) {
    disk = { total: +dp[1], used: +dp[2], avail: +dp[3], pct: parseInt(dp[4]) || 0 };
  }

  // 运行时长
  let uptime = 0;
  const um = upRaw.split(' ')[0];
  if (um) uptime = parseFloat(um);

  // swap
  let swap = { total: 0, used: 0 };
  for (const line of swapRaw.split('\n')) {
    if (line.startsWith('Swap:')) {
      const p = line.split(/\s+/).filter(Boolean);
      swap = { total: +p[1], used: +p[2] };
    }
  }

  return { mem, cpu, disk, uptime, swap };
}

// ============ Bot 信息 ============
async function getBotInfo() {
  const raw = await sh(`docker exec astrbot python3 -c "
import json
d=json.load(open('/AstrBot/data/cmd_config.json', encoding='utf-8-sig'))
ar=d.get('agent_runner',{}).get('config',{})
print(json.dumps({
  'persona': ar.get('persona',{}).get('persona_id'),
  'provider': ar.get('model',{}).get('provider_id'),
  'fallback': ar.get('model',{}).get('fallback_provider_ids'),
  'wake': d.get('wake_prefix'),
  'admins': d.get('admins_id'),
}, ensure_ascii=False))
"`, 15000);

  let info = {};
  try { info = JSON.parse(raw); } catch {}
  return info;
}

// ============ 日志 ============
async function getLogs(container = 'astrbot', lines = 120) {
  const raw = await sh(`docker logs --tail ${lines} ${container} 2>&1`, 12000);
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      // 去掉 ANSI 颜色
      const clean = l.replace(/\x1b\[[0-9;]*m/g, '');
      // 提取时间
      const tm = clean.match(/(\d{2}:\d{2}:\d{2})/);
      let level = 'info';
      if (/error|exception|traceback|failed/i.test(clean)) level = 'err';
      else if (/warn/i.test(clean)) level = 'warn';
      else if (/success|✅|已连接|启动/i.test(clean)) level = 'ok';
      return { time: tm ? tm[1] : '', text: clean.slice(0, 300), level };
    })
    .slice(-80);
}

// ============ 账号池 ============
async function getPool() {
  const raw = await sh('cd /root/bot/workbuddy-openai-proxy && node login.mjs --list 2>&1', 20000);
  const sites = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const sm = line.match(/^\[([\w-]+)\]\s+(.+?)\s+——\s+(\d+)\s+个账号/);
    if (sm) {
      cur = { site: sm[1], label: sm[2], count: +sm[3], accounts: [] };
      sites.push(cur);
      continue;
    }
    const am = line.match(/^\s+·\s+(\S+)\s+uid=(\S+)\s+(.+)$/);
    if (am && cur) {
      cur.accounts.push({ name: am[1], uid: am[2], status: am[3].trim() });
    }
  }
  return sites;
}

// ============ 鉴权 ============
const AUTH_USER = process.env.DASH_USER || 'admin';
// 密码必须由环境变量提供；留空则拒绝所有登录
const AUTH_PASS = process.env.DASH_PASS || '';
const SESSIONS = new Map();

function makeToken() {
  const t = Math.random().toString(36).slice(2) + Date.now().toString(36);
  SESSIONS.set(t, Date.now() + 7 * 24 * 3600 * 1000);
  return t;
}

function checkSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/dfy_session=([a-zA-Z0-9]+)/);
  if (!m) return false;
  const exp = SESSIONS.get(m[1]);
  if (!exp) return false;
  if (Date.now() > exp) { SESSIONS.delete(m[1]); return false; }
  return true;
}

function loginPage(err) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼控制台 · 登录</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
background:#0a0e17;color:#e8edf5;min-height:100vh;display:flex;
align-items:center;justify-content:center}
.box{width:340px;padding:36px 32px;background:#151c2c;border:1px solid #1f2937;
border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.logo{width:52px;height:52px;border-radius:15px;margin:0 auto 18px;
background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;
align-items:center;justify-content:center;font-size:26px}
h1{font-size:17px;font-weight:650;text-align:center;margin-bottom:6px}
p{font-size:12.5px;color:#5a6b82;text-align:center;margin-bottom:26px}
label{display:block;font-size:12px;color:#8b98ac;margin-bottom:7px}
input{width:100%;padding:11px 14px;background:#0b1018;border:1px solid #2d3748;
border-radius:10px;color:#e8edf5;font-size:14px;outline:none;margin-bottom:16px}
input:focus{border-color:#3b82f6}
button{width:100%;padding:12px;background:linear-gradient(135deg,#3b82f6,#6366f1);
border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:12.5px;text-align:center;margin-top:14px;min-height:18px}
</style></head><body><div class="box"><div class="logo">🐋</div>
<h1>大肥鱼控制台</h1><p>DeepSeek Whale Console</p>
<form method="POST" action="/login">
<label>用户名</label><input name="u" autocomplete="username" autofocus>
<label>密码</label><input name="p" type="password" autocomplete="current-password">
<button type="submit">登 录</button></form>
<div class="err">${err}</div></div></body></html>`;
}

// ============ 路由 ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // 登录
  if (p === '/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const okPass = !!AUTH_PASS && (params.get('p') || '') === AUTH_PASS;
    if ((params.get('u') || '') === AUTH_USER && okPass) {
      const t = makeToken();
      res.writeHead(302, {
        'Set-Cookie': `dfy_session=${t}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax`,
        'Location': '/',
      });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(loginPage('用户名或密码错误'));
  }

  // ===== 免登录跳转（这两条不带任何敏感信息，纯粹是便捷入口）=====
  // noVNC 的 webutil.getConfigVar 会读 URL 参数，password= 能免手输。
  if (p === '/go/vnc') {
    const q = `host=${encodeURIComponent(SL_PUBLIC_HOST)}&port=${SL_VNC}`
            + `&password=${encodeURIComponent(process.env.SL_VNC_PASS || '')}&autoconnect=1&resize=scale&reconnect=1`;
    res.writeHead(302, {
      'Location': `http://${SL_PUBLIC_HOST}:${SL_VNC}/vnc.html?${q}`,
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  if (p === '/proxy' || p.startsWith('/proxy/')) {
    res.writeHead(302, { 'Location': '/relay/' });
    return res.end();
  }

  // ===== AstrBot 面板反代（统一 /ab 前缀，避免与面板 API 冲突）=====
  if (p === '/ab' || p.startsWith('/ab/')) {
    let rest = p === '/ab' ? '/' : p.slice(3);

    try {
      const up = await fetch('http://127.0.0.1:6185' + rest, {
        method: req.method,
        headers: {
          'Host': '127.0.0.1:6185',
          'Accept': req.headers.accept || '*/*',
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Cookie': req.headers.cookie || '',
          'Authorization': req.headers.authorization || '',
        },
        body: ['POST','PUT','PATCH','DELETE'].includes(req.method) ? await (async () => {
          let b = ''; for await (const c of req) b += c; return b;
        })() : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });

      const loc = up.headers.get('location');
      if (loc) {
        res.writeHead(up.status, { 'Location': loc.startsWith('/') ? '/ab' + loc : loc });
        return res.end();
      }

      const headers = { 'Content-Type': up.headers.get('content-type') || 'text/html; charset=utf-8' };
      // Set-Cookie 是 forbidden header，fetch 的 .get() 拿不到，必须用 getSetCookie()
      const setCookies = typeof up.headers.getSetCookie === 'function'
        ? up.headers.getSetCookie()
        : [];
      if (setCookies.length) headers['Set-Cookie'] = setCookies;
      res.writeHead(up.status, headers);
      let body = Buffer.from(await up.arrayBuffer());

      const ct = headers['Content-Type'] || '';
      if (ct.includes('text/html')) {
        let html = body.toString('utf8');
        // 所有绝对路径加上 /ab 前缀
        html = html.replace(/(src|href)="\/(assets|favicon)/g, '$1="/ab/$2');
        body = Buffer.from(html, 'utf8');
      }
      return res.end(body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('AstrBot 反代失败: ' + String(e).slice(0, 100));
    }
  }

  // 鉴权
  if (!checkSession(req)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(loginPage(''));
  }

  // ---- API ----
  // ===== proxy 控制台反代（绕过本机限制）=====
  // 已废弃：仅保留 /console/api 透传，供中转站查额度
  if (p.startsWith('/console/api/')) {
    let target;
    if (p.startsWith('/console/api/')) {
      target = 'http://127.0.0.1:8788' + p;          // API 直通
    } else if (p === '/proxy') {
      target = 'http://127.0.0.1:8788/console';
    } else {
      target = 'http://127.0.0.1:8788' + p.slice(6);
    }

    try {
      const up = await fetch(target, {
        method: req.method,
        headers: {
          'Host': '127.0.0.1:8788',
          'Origin': 'http://127.0.0.1:8788',
          'Referer': 'http://127.0.0.1:8788/console',
          'Authorization': req.headers.authorization || ('Bearer ' + (process.env.WB_PROXY_KEY || '')),
          'X-Console-Token': req.headers['x-console-token'] || '',
          'Content-Type': req.headers['content-type'] || 'application/json',
        },
        body: ['POST','PUT','PATCH'].includes(req.method) ? await (async () => {
          let b = ''; for await (const c of req) b += c; return b;
        })() : undefined,
        signal: AbortSignal.timeout(25000),
      });
      const headers = { 'Content-Type': up.headers.get('content-type') || 'text/html; charset=utf-8' };
      const sc = up.headers.get('set-cookie');
      if (sc) headers['Set-Cookie'] = sc;
      res.writeHead(up.status, headers);
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('proxy 反代失败: ' + String(e).slice(0, 100));
    }
  }

  // ===== 中转站反代（/relay* -> :{RELAY_PORT}）=====

  if (p === '/relay') {

    res.writeHead(302, { 'Location': '/relay/' });

    return res.end();

  }

  if (p.startsWith('/relay/')) {

    // 必须带上 query，否则 /relay/api/accounts?credit=1 的 credit 会被吃掉
    let rest = p.slice('/relay'.length) + (url.search || '');

    try {

      const up = await fetch(`http://127.0.0.1:${RELAY_PORT}${rest}`, {

        method: req.method,

        headers: {

          'Host': `127.0.0.1:${RELAY_PORT}`,

          'Accept': req.headers.accept || '*/*',

          'Content-Type': req.headers['content-type'] || 'application/json',
          'X-Relay-Admin': RELAY_KEY,

        },

        body: ['POST','PUT','PATCH','DELETE'].includes(req.method) ? await (async () => {

          let b = ''; for await (const c of req) b += c; return b;

        })() : undefined,

        signal: AbortSignal.timeout(180000),

      });

      const headers = { 'Content-Type': up.headers.get('content-type') || 'text/html; charset=utf-8' };

      res.writeHead(up.status, headers);

      return res.end(Buffer.from(await up.arrayBuffer()));

    } catch (e) {

      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });

      return res.end('中转站反代失败: ' + String(e).slice(0, 200));

    }

  }



  // ===== SnowLuma WebUI 反代（/snowluma/* -> :5099）=====
  if (p === '/snowluma' || p.startsWith('/snowluma/')) {
    let rest = p === '/snowluma' ? '/' : p.slice('/snowluma'.length);
    try {
      const up = await fetch(`http://127.0.0.1:${SL_WEBUI}` + rest, {
        method: req.method,
        headers: {
          'Host': `127.0.0.1:${SL_WEBUI}`,
          'Accept': req.headers.accept || '*/*',
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Cookie': req.headers.cookie || '',
          'Authorization': req.headers.authorization || '',
        },
        body: ['POST','PUT','PATCH','DELETE'].includes(req.method) ? await (async () => {
          let b = ''; for await (const c of req) b += c; return b;
        })() : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });

      const loc = up.headers.get('location');
      if (loc) {
        res.writeHead(up.status, { 'Location': loc.startsWith('/') ? '/snowluma' + loc : loc });
        return res.end();
      }

      const headers = { 'Content-Type': up.headers.get('content-type') || 'text/html; charset=utf-8' };
      const sc = up.headers.get('set-cookie');
      if (sc) headers['Set-Cookie'] = sc;
      res.writeHead(up.status, headers);
      let body = Buffer.from(await up.arrayBuffer());

      const ct = headers['Content-Type'] || '';
      if (ct.includes('text/html')) {
        let html = body.toString('utf8');
        html = html.replace(/(src|href)="\/(assets|favicon|logo\.png)/g, '$1="/snowluma/$2');
        html = html.replace(/"\/api\//g, '"/snowluma/api/');
        body = Buffer.from(html, 'utf8');
      }
      return res.end(body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('SnowLuma 反代失败: ' + String(e).slice(0, 160));
    }
  }

  // ===== noVNC 反代（/vnc/* -> :6081，扫码登录用）=====
  if (p === '/vnc' || p.startsWith('/vnc/')) {
    let rest = (p === '/vnc' ? '/' : p.slice('/vnc'.length)) + (url.search || '');
    try {
      const up = await fetch(`http://127.0.0.1:${SL_VNC}` + rest, {
        method: req.method,
        headers: {
          'Host': `127.0.0.1:${SL_VNC}`,
          'Accept': req.headers.accept || '*/*',
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Cookie': req.headers.cookie || '',
        },
        body: ['POST','PUT','PATCH','DELETE'].includes(req.method) ? await (async () => {
          let b = ''; for await (const c of req) b += c; return b;
        })() : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });

      const loc = up.headers.get('location');
      if (loc) {
        res.writeHead(up.status, { 'Location': loc.startsWith('/') ? '/vnc' + loc : loc });
        return res.end();
      }

      const headers = { 'Content-Type': up.headers.get('content-type') || 'text/html; charset=utf-8' };
      res.writeHead(up.status, headers);
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('noVNC 反代失败: ' + String(e).slice(0, 160));
    }
  }

  // ===== 旧 /napcat 路径兼容：跳到 /snowluma =====
  if (p === '/napcat' || p.startsWith('/napcat/')) {
    res.writeHead(302, { 'Location': '/snowluma' });
    return res.end();
  }

  // ===== 点「SnowLuma」按钮：现签令牌并跳转（免手输密码）=====
  if (p === '/go/snowluma') {
    try {
      const r = await fetch(`http://127.0.0.1:${SL_WEBUI}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: SL_PASSWORD }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json();
      if (!d.success || !d.token) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<meta charset="utf-8"><body style="font-family:system-ui;padding:40px">' +
          '<h3>SnowLuma 登录失败</h3><p>' +
          String(d.message || '未知错误').replace(/[<>&]/g, '') +
          '</p><p><a href="http://' + SL_PUBLIC_HOST + ':' + SL_WEBUI + '/">手动登录</a></p>'
        );
      }
      // 注意：SnowLuma 前端读 ?token= 后是当作 password 调 /api/login 的，
      // 所以这里必须放密码，不能放会话令牌。
      res.writeHead(302, {
        'Location': `http://${SL_PUBLIC_HOST}:${SL_WEBUI}/?token=${encodeURIComponent(SL_PASSWORD)}`,
        'Cache-Control': 'no-store',
      });
      return res.end();
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<meta charset="utf-8"><body style="font-family:system-ui;padding:40px">'
        + '<h3>SnowLuma 不可达</h3><p>' + String(e).slice(0, 200).replace(/[<>&]/g, '') + '</p>');
    }
  }

  if (p === '/api/all') {
    try {
      const [svc, sys, bot, pool] = await Promise.all([
        getServices(), getSystem(), getBotInfo(), getPool(),
      ]);
      return json(res, 200, { ok: true, services: svc, system: sys, bot, pool, ts: Date.now() });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e) });
    }
  }

  if (p === '/api/services') return json(res, 200, await getServices());
  if (p === '/api/system') return json(res, 200, await getSystem());
  if (p === '/api/bot') return json(res, 200, await getBotInfo());
  if (p === '/api/pool') return json(res, 200, await getPool());

  if (p === '/api/logs') {
    const c = url.searchParams.get('container') || 'astrbot';
    const n = parseInt(url.searchParams.get('lines') || '120');
    return json(res, 200, { container: c, lines: await getLogs(c, Math.min(n, 500)) });
  }

  // ---- 首页：注入部署配置（主机/端口不写死在 HTML 里）----
  if (p === '/' || p === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
      const cfg = {
        host: SL_PUBLIC_HOST,
        abPort: AB_PORT,
        vncPort: SL_VNC,
        vncPass: process.env.SL_VNC_PASS || '',
      };
      const inject = '<script>window.__DASH_CFG__=' + JSON.stringify(cfg) + ';</script>';
      const out = html.replace('</head>', inject + '</head>');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, must-revalidate',
      });
      return res.end(out);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('读取 index.html 失败: ' + String(e).slice(0, 160));
    }
  }

  // ---- 静态 ----
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(STATIC_DIR, path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full);
    const ct = MIME[ext] || 'application/octet-stream';

    // HTML 不缓存（每次拿最新），静态资源长缓存
    const isHtml = ct.includes('text/html');
    const cacheControl = isHtml
      ? 'no-cache, must-revalidate'
      : 'public, max-age=86400';

    // gzip 压缩文本类资源
    const textTypes = ['.html', '.css', '.js', '.json', '.svg'];
    const shouldGzip = textTypes.includes(ext) &&
      (req.headers['accept-encoding'] || '').includes('gzip');

    if (shouldGzip) {
      const raw = fs.readFileSync(full);
      const gz = zlib.gzipSync(raw, { level: 6 });
      res.writeHead(200, {
        'Content-Type': ct,
        'Content-Encoding': 'gzip',
        'Content-Length': gz.length,
        'Cache-Control': cacheControl,
        'Vary': 'Accept-Encoding',
      });
      return res.end(gz);
    }

    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': cacheControl,
    });
    return fs.createReadStream(full).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
});
