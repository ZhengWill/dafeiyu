#!/usr/bin/env node
/**
 * astrbot-tls.mjs —— AstrBot 面板的 HTTPS 前置代理
 * ------------------------------------------------------------------
 * 为什么不用 AstrBot 自带的 ssl.enable：
 *   那要求重建容器（改端口映射 / 挂证书），astrbot 同时挂着
 *   bridge + newnet 两个网络、一条 data 挂载，重建容易丢配置。
 *   独立前置代理零风险，随时可以停掉回滚。
 *
 * 为什么需要：
 *   AstrBot 的登录 cookie 带 Secure，纯 http 下浏览器直接丢弃，
 *   导致「登录成功但仍停在登录页」。
 *
 * 监听 0.0.0.0:8443（HTTPS）→ 127.0.0.1:6185（HTTP）
 * 证书：/root/certs/astrbot.crt（自签，含 IP SAN）
 */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

const LISTEN_PORT = 8443;
const UPSTREAM = 'http://127.0.0.1:6185';
const CERT = process.env.TLS_CERT || '/root/certs/astrbot.crt';
const KEY = process.env.TLS_KEY || '/root/certs/astrbot.key';

const opTS = { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) };

const server = https.createServer(opTS, async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const headers = { ...req.headers };
    delete headers['accept-encoding'];   // 让上游回未压缩的，省得处理

    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    });

    const out = {};
    // Set-Cookie 必须用 getSetCookie()
    const sc = typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : [];
    if (sc.length) out['set-cookie'] = sc;
    for (const [k, v] of up.headers) {
      if (k === 'set-cookie' || k === 'content-encoding' || k === 'transfer-encoding'
          || k === 'content-length' || k === 'connection') continue;
      out[k] = v;
    }
    if (up.headers.get('content-type')) out['content-type'] = up.headers.get('content-type');

    const buf = Buffer.from(await up.arrayBuffer());
    out['content-length'] = String(buf.length);
    res.writeHead(up.status, out);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('TLS 代理失败: ' + String(e).slice(0, 200));
  }
});

// 顺便起个 http → https 的跳转（8080 端口不用，选 8081）
const redir = http.createServer((req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  res.writeHead(302, { Location: `https://${host}:${LISTEN_PORT}${req.url}` });
  res.end();
});
redir.listen(8081, '0.0.0.0', () => console.log('[tls] http redirect on :8081'));

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[tls] https://0.0.0.0:${LISTEN_PORT} -> ${UPSTREAM}`);
});
