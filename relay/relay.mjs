#!/usr/bin/env node
/**
 * 大肥鱼中转站 relay.mjs
 * ---------------------------------------------------------------
 * 统一模型网关。零依赖，纯 Node 标准库。
 *
 * 特性：
 *   1. 多供应商（OpenAI / Anthropic 两种协议，自动互转）
 *   2. 手动拖拽排序的降级链；失败自动下沉，恢复自动回升
 *   3. 每个供应商自动拉取模型清单；逐个启用/禁用；手动增删
 *   4. 每个模型可单独设置 contextWindow / maxTokens
 *   5. 额度可见（new-api 已用金额 / WorkBuddy 积分）
 *   6. WorkBuddy 账号池 + 自动签到开关
 *   7. 对外只暴露一个模型名，AstrBot 填一次即可
 *
 * 监听 0.0.0.0:8790
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execAsync = promisify(exec);

// 全部可通过环境变量覆盖，默认值贴近开箱即用
const ROOT = process.env.RELAY_ROOT || path.join(process.cwd());
const CFG_PATH = process.env.RELAY_CONFIG || path.join(ROOT, 'relay.json');
const STATE_PATH = process.env.RELAY_STATE || path.join(ROOT, 'relay-state.json');
const UI_DIR = process.env.RELAY_UI_DIR || path.join(ROOT, 'ui');
// WorkBuddy 账号池代理（可选功能，不配置则该面板为空）
const WB_PROXY_DIR = process.env.WB_PROXY_DIR || '';
const WB_PROXY = process.env.WB_PROXY || 'http://127.0.0.1:8788';
// 账号池站点标识，逗号分隔，例如 'cn-cli,intl-work'
const WB_SITES = (process.env.WB_SITES || '').split(',').map(s => s.trim()).filter(Boolean);

// ============================================================
// 配置
// ============================================================
const DEFAULT_CFG = {
  version: 1,
  port: 8790,
  host: '0.0.0.0',
  // 首次启动时会自动生成随机 key 并写回配置文件
  apiKey: process.env.RELAY_API_KEY || '',
  /** 对外暴露的唯一模型名，AstrBot 里只填这一个 */
  exposeModel: 'dafeiyu',
  /** 看图的模型：链上任何一条都行，但只有部分支持图片，所以单独指定 */
  visionModel: { providerId: '', modelId: '', enabled: false },
  /** 上游全部失败时给客户端的兜底话术 */
  fallbackReply: '（鱼鱼现在没白饭了…稍后再叫我）',
  providers: [],
  chain: [],
  checkin: { enabled: true },
  failover: { probeIntervalMs: 300000, cooldownMs: 120000, maxFailBeforeSkip: 1 },
};

function loadCfg() {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch {
    c = {};
  }
  const cfg = { ...structuredClone(DEFAULT_CFG), ...c };
  // 没配 key 就生成一个并落盘，免得暴露成无鉴权网关
  if (!cfg.apiKey) {
    cfg.apiKey = 'relay-' + crypto.randomBytes(16).toString('hex');
    try {
      fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true });
      fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      console.log('[relay] 已生成新的 API Key 并写入配置文件:', cfg.apiKey);
    } catch (e) {
      console.error('[relay] 无法写入配置文件，本次运行使用临时 key:', e.message);
    }
  }
  return cfg;
}
function saveCfg(c) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

/** 运行态：不进 relay.json，避免频繁写主配置 */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { health: {}, usage: { days: {} } }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {}
}

// ============================================================
// 工具
// ============================================================
const nowMs = () => Date.now();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

function jsonRes(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  return JSON.parse(b.toString('utf8'));
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

/**
 * 上下文长度兜底表 —— 绝大多数中转站 /v1/models 不返回上下文长度，
 * 这里按模型名关键词给一个可信的默认值，面板里仍可手动改。
 * 前缀匹配，长的放前面。
 */
const KNOWN_CONTEXT = [
  ['claude',            200000],
  ['gpt-6',            1000000],
  ['gpt-5.6',          1000000],
  ['gpt-5.5',           400000],
  ['gpt-5',             400000],
  ['gpt-4o',            128000],
  ['gemini-4',         1000000],
  ['gemini-3',         1000000],
  ['gemini-2.5',       1000000],
  ['deepseek-v4.1',    1000000],
  ['deepseek-v4',       128000],
  ['deepseek-v3',       128000],
  ['deepseek-r1',       128000],
  ['glm-5',            1000000],
  ['glm-4',             128000],
  ['kimi-k3',           500000],
  ['kimi-k2',           256000],
  ['minimax-m3',        500000],
  ['minimax-m2',        200000],
  ['qwen3',             200000],
  ['qwen-3',            200000],
  ['grok-4',           2000000],
  ['doubao',            256000],
  ['hunyuan',           256000],
  ['step-5',            256000],
  ['mimo',              256000],
  ['hy3',               128000],
  ['auto',             1000000],
];

function guessContext(modelId) {
  const s = String(modelId || '').toLowerCase();
  for (const [kw, v] of KNOWN_CONTEXT) if (s.includes(kw)) return v;
  return 0;
}

// ============================================================
// 供应商调用
// ============================================================
class UpstreamError extends Error {
  constructor(msg, { status = 0, kind = 'upstream' } = {}) {
    super(msg);
    this.status = status;
    this.kind = kind;   // quota | rate | auth | network | upstream | bad_request
  }
}

/** 从上游报错文本里判断错误类型 —— 决定要不要降级 */
function classify(status, text) {
  const t = String(text || '');
  if (/insufficient|quota|额度|余额不足|exceeded your current quota|积分不足|credit/i.test(t)) return 'quota';
  if (status === 402) return 'quota';
  if (status === 429 || /rate.?limit|rpm_exceeded|too many requests|频率/i.test(t)) return 'rate';
  if (status === 401 || status === 403) {
    if (/GROUP_DELETED|retired|invalid.?key|unauthorized/i.test(t)) return 'auth';
    return 'quota';
  }
  if (status >= 500) return 'upstream';
  if (status === 0) return 'network';
  return 'upstream';
}

/** OpenAI 消息 → Anthropic 消息 */
function openaiToAnthropic(openaiBody) {
  const sysParts = [];
  const msgs = [];
  for (const m of openaiBody.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string') sysParts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'text') sysParts.push(p.text);
      }
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = [];
      for (const p of m.content) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          const url = p.image_url?.url || '';
          const mm = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (mm) content.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
          else if (/^https?:/.test(url)) content.push({ type: 'image', source: { type: 'url', url } });
        }
      }
      if (!content.length) content = '';
    } else content = '';
    // Anthropic 不允许连续同角色，合并
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === 'string' && typeof content === 'string') last.content += '\n' + content;
      else {
        const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
        const b = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
        last.content = [...a, ...b];
      }
    } else {
      msgs.push({ role, content });
    }
  }
  if (!msgs.length) msgs.push({ role: 'user', content: '(空)' });
  const out = {
    model: openaiBody.model,
    max_tokens: openaiBody.max_tokens || openaiBody.max_completion_tokens || 4096,
    messages: msgs,
  };
  if (sysParts.length) out.system = sysParts.join('\n\n');
  if (typeof openaiBody.temperature === 'number') out.temperature = openaiBody.temperature;
  if (typeof openaiBody.top_p === 'number') out.top_p = openaiBody.top_p;
  if (openaiBody.stop) out.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
  if (openaiBody.stream) out.stream = true;
  return out;
}

/** Anthropic 响应 → OpenAI 响应 */
function anthropicToOpenai(a, model) {
  const text = (a.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return {
    id: a.id || 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(nowMs() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: a.stop_reason === 'max_tokens' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: a.usage?.input_tokens || 0,
      completion_tokens: a.usage?.output_tokens || 0,
      total_tokens: (a.usage?.input_tokens || 0) + (a.usage?.output_tokens || 0),
    },
  };
}

function chatUrl(p) {
  const base = trimSlash(p.base);
  if (p.api === 'anthropic') return base + '/v1/messages';
  return base + '/chat/completions';
}
function modelsUrl(p) {
  const base = trimSlash(p.base);
  if (p.api === 'anthropic') return base + '/v1/models';
  return base + '/models';
}
function authHeaders(p) {
  if (p.api === 'anthropic') {
    // 大多数 Anthropic 兼容站认 x-api-key，但 MiniMax Code 网关只认
    // Authorization: Bearer（实测 x-api-key 回 401 token is required），
    // 所以用 authStyle 显式区分，缺省保持原行为。
    const h = {
      'content-type': 'application/json',
      'anthropic-version': p.anthropicVersion || '2023-06-01',
    };
    if (p.authStyle === 'bearer') h['Authorization'] = 'Bearer ' + p.key;
    else h['x-api-key'] = p.key;
    return h;
  }
  return {
    'content-type': 'application/json',
    'Authorization': 'Bearer ' + p.key,
  };
}

/** 发一次上游请求；openaiBody 为 OpenAI 格式；返回原始 Response（未消费 body） */
async function callUpstream(p, modelId, openaiBody, timeoutMs = 180000) {
  const url = chatUrl(p);
  let body;
  if (p.api === 'anthropic') {
    const a = openaiToAnthropic({ ...openaiBody, model: modelId });
    if (!a.max_tokens || a.max_tokens < 16) a.max_tokens = 4096;
    body = JSON.stringify(a);
  } else {
    const o = { ...openaiBody, model: modelId, stream: !!openaiBody.stream };
    // WorkBuddy 代理认自家模型名，直接透传
    body = JSON.stringify(o);
  }
  try {
    return await fetch(url, {
      method: 'POST',
      headers: authHeaders(p),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new UpstreamError(`网络错误 ${String(e).slice(0, 120)}`, { status: 0, kind: 'network' });
  }
}

// ============================================================
// SSE 转换：Anthropic → OpenAI chunk
// ============================================================
async function* sseEvents(stream) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let data = '';
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (s.startsWith('data:')) data += s.slice(5).trim();
      }
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

function openaiChunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(nowMs() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

// ============================================================
// 降级链执行
// ============================================================
function cfgProvider(cfg, id) {
  return cfg.providers.find((p) => p.id === id);
}

function chainEntries(cfg) {
  return (cfg.chain || []).filter((c) => c.enabled !== false);
}

function healthOf(state, key) {
  return state.health[key] || { ok: true, fails: 0, downUntil: 0, lastError: '', lastOkAt: 0 };
}
function setHealth(state, key, patch) {
  state.health[key] = { ...healthOf(state, key), ...patch };
  saveState(state);
}

function recordUsage(state, providerId, modelId, { prompt = 0, completion = 0, ok = true, ms = 0 }) {
  const d = today();
  state.usage.days[d] = state.usage.days[d] || { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, models: {} };
  const day = state.usage.days[d];
  const k = `${providerId}/${modelId}`;
  const m = (day.models[k] = day.models[k] || { providerId, modelId, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, ms: 0 });
  day.calls++; m.calls++; day.promptTokens += prompt; m.promptTokens += prompt;
  day.completionTokens += completion; m.completionTokens += completion; m.ms += ms;
  if (!ok) { day.errors++; m.errors++; }
  saveState(state);
}

/** 主路径：按链顺序尝试 */
async function dispatch(cfg, state, openaiBody, res) {
  // 看图请求单独指定模型：带图片的消息走视觉得那条，不走链。
  // 原因：链上只有部分模型支持图片，让它们轮流试会一直降级到能看的那条，
  // 既慢又浪费额度。这里直接钉死用户选的那一条。
  //
  // 注意顺序：必须在「链为空」检查之前判断，否则看图模型不在链里时会被误判成没配置。
  const hasImage = (openaiBody.messages || []).some((m) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' || p.type === 'image')
  );
  const vis = cfg.visionModel;
  if (hasImage && vis && vis.enabled && vis.providerId && vis.modelId) {
    const p = cfgProvider(cfg, vis.providerId);
    const m = (p?.models || []).find((x) => x.id === vis.modelId);
    if (p && p.enabled !== false && m) {
      return dispatchTo(cfg, state, openaiBody, res, [{
        providerId: vis.providerId, modelId: vis.modelId, enabled: true, vision: true,
      }]);
    }
  }

  const entries = chainEntries(cfg);
  if (!entries.length) {
    jsonRes(res, 503, { error: { message: '降级链为空，请先在面板里启用至少一条', type: 'relay_no_chain' } });
    return;
  }

  return dispatchTo(cfg, state, openaiBody, res, entries);
}

async function dispatchTo(cfg, state, openaiBody, res, entries) {
  const errors = [];
  for (const entry of entries) {
    const p = cfgProvider(cfg, entry.providerId);
    if (!p || p.enabled === false) continue;
    const model = (p.models || []).find((m) => m.id === entry.modelId);
    if (!model || model.enabled === false) continue;

    const key = `${entry.providerId}/${entry.modelId}`;
    const h = healthOf(state, key);
    if (h.downUntil && h.downUntil > nowMs()) { errors.push(`${key}: 冷却中`); continue; }

    const t0 = nowMs();
    let up;
    try {
      up = await callUpstream(p, entry.modelId, openaiBody);
    } catch (e) {
      setHealth(state, key, { ok: false, fails: (h.fails || 0) + 1, downUntil: nowMs() + cfg.failover.cooldownMs, lastError: e.message });
      recordUsage(state, entry.providerId, entry.modelId, { ok: false, ms: nowMs() - t0 });
      errors.push(`${key}: ${e.message}`);
      continue;
    }

    if (!up.ok) {
      const text = await up.text().catch(() => '');
      const kind = classify(up.status, text);
      setHealth(state, key, {
        ok: false, fails: (h.fails || 0) + 1,
        downUntil: nowMs() + (kind === 'rate' ? cfg.failover.cooldownMs * 2 : cfg.failover.cooldownMs),
        lastError: `HTTP ${up.status} ${text.slice(0, 200)}`,
      });
      recordUsage(state, entry.providerId, entry.modelId, { ok: false, ms: nowMs() - t0 });
      errors.push(`${key}: HTTP ${up.status} ${text.slice(0, 120)}`);
      continue;
    }

    // 成功 —— 回写健康
    setHealth(state, key, { ok: true, fails: 0, downUntil: 0, lastError: '', lastOkAt: nowMs() });

    // 非流式
    if (!openaiBody.stream) {
      if (p.api === 'anthropic') {
        const a = await up.json();
        const o = anthropicToOpenai(a, openaiBody.model || cfg.exposeModel);
        recordUsage(state, entry.providerId, entry.modelId, {
          prompt: o.usage.prompt_tokens, completion: o.usage.completion_tokens, ms: nowMs() - t0,
        });
        return jsonRes(res, 200, o);
      }
      const buf = Buffer.from(await up.arrayBuffer());
      try {
        const o = JSON.parse(buf.toString('utf8'));
        recordUsage(state, entry.providerId, entry.modelId, {
          prompt: o.usage?.prompt_tokens || 0, completion: o.usage?.completion_tokens || 0, ms: nowMs() - t0,
        });
      } catch { recordUsage(state, entry.providerId, entry.modelId, { ok: false, ms: nowMs() - t0 }); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    // 流式
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Relay-Provider': entry.providerId,
      'X-Relay-Model': entry.modelId,
    });

    const id = 'chatcmpl-' + crypto.randomUUID();
    const outModel = openaiBody.model || cfg.exposeModel;

    try {
      if (p.api === 'anthropic') {
        let usage = { prompt: 0, completion: 0 };
        for await (const ev of sseEvents(up.body)) {
          if (ev.type === 'message_start') {
            usage.prompt = ev.message?.usage?.input_tokens || 0;
          } else if (ev.type === 'content_block_delta') {
            const t = ev.delta?.text;
            if (t) res.write(openaiChunk(id, outModel, { content: t }));
          } else if (ev.type === 'message_delta') {
            if (ev.usage?.output_tokens) usage.completion = ev.usage.output_tokens;
            if (ev.delta?.stop_reason) {
              res.write(openaiChunk(id, outModel, {}, ev.delta.stop_reason === 'max_tokens' ? 'length' : 'stop'));
            }
          }
        }
        recordUsage(state, entry.providerId, entry.modelId, {
          prompt: usage.prompt, completion: usage.completion, ms: nowMs() - t0,
        });
      } else {
        // OpenAI 流：原样转发，只补 [DONE]
        const dec = new TextDecoder();
        for await (const chunk of up.body) res.write(Buffer.from(chunk));
        void dec;
        recordUsage(state, entry.providerId, entry.modelId, { ms: nowMs() - t0 });
      }
      res.write('data: [DONE]\n\n');
    } catch (e) {
      setHealth(state, key, { ok: false, fails: (h.fails || 0) + 1, lastError: '流中断 ' + String(e).slice(0, 120) });
      try { res.write(`data: ${JSON.stringify({ error: { message: '流中断' } })}\n\n`); } catch {}
    }
    return res.end();
  }

  jsonRes(res, 503, {
    error: {
      message: '所有上游都不可用',
      type: 'relay_all_down',
      detail: errors.slice(0, 12),
    },
  });
}

// ============================================================
// 供应商探测 / 模型清单 / 额度
// ============================================================
async function fetchModels(p) {
  const url = modelsUrl(p);
  try {
    const r = await fetch(url, { headers: authHeaders(p), signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 300), models: [] };
    const j = JSON.parse(text);
    const arr = j.data || j.models || [];
    const models = arr.map((m) => {
      const ctx = m.input_modalities?.find((x) => x.type === 'text')
        ?.supported_inputs?.max_context_length?.value
        || m.context_length || m.context_window || m.max_context_length || 0;
      // 是否支持图片：不同站点字段名不一样，全部兼容
      const hasImage = !!(
        m.supports_images || m.supportsImages || m.vision || m.multimodal
        || (Array.isArray(m.input_modalities) && m.input_modalities.some((x) => x.type === 'image'))
        || (Array.isArray(m.input) && m.input.includes('image'))
        || (Array.isArray(m.modalities) && m.modalities.includes('image'))
      );
      return {
        id: m.id || m.name,
        name: m.display_name || m.name || m.id,
        upstreamContext: Number(ctx) || 0,
        supportsImages: hasImage,
        credits: m.credits || '',
      };
    }).filter((m) => m.id);
    return { ok: true, status: r.status, models };
  } catch (e) {
    return { ok: false, status: 0, error: String(e).slice(0, 200), models: [] };
  }
}

async function queryQuota(p) {
  // WorkBuddy 代理：走它自己的 /console/api/state
  if (p.billingKind === 'workbuddy') {
    try {
      // 控制台接口要鉴权：用代理自己的 apiKey
      const r = await fetch(WB_PROXY + '/console/api/state', {
        headers: { 'Authorization': 'Bearer ' + p.key, 'X-Api-Key': p.key },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return { kind: 'workbuddy', ok: false, error: `HTTP ${r.status} ${t.slice(0, 120)}` };
      }
      const j = await r.json();
      // 站点 key 是数组下标（0/1/2），要靠 label 分辨国内版 / 国际版
      // j.sites 是数组（不是对象），所以 site 必须取元素自带的 site 字段，
      // 不能把 Object.entries 的下标 "0"/"1" 当站点名——那会导致账号池读错文件。
      const rawSites = Array.isArray(j.sites)
        ? j.sites.map((s, i) => [String(s.site || i), s])
        : Object.entries(j.sites || {});
      const all = rawSites.map(([id, s]) => ({
        site: s.site || id,
        label: s.label || id,
        apiBase: s.apiBase || '',
        loggedIn: !!s.logged_in,
        credit: typeof s.credit === 'number' ? s.credit : null,
        creditDetail: s.credit_detail || null,
        creditError: s.credit_error || null,
      }));
      // 只返回属于这个供应商的站点
      const pick = p.siteMatch
        ? all.filter((s) => (s.label || '').includes(p.siteMatch))
        : all;
      const sites = pick.length ? pick : all;
      // 站点合计是给「这个站还剩多少」用的；账号级明细要另查 /console/api/pool。
      // 两个站点并行查，实测 cn-cli 0.6s、intl-work 0.35s。
      await Promise.all(sites.map(async (s) => {
        // state 里的 site 就是账号池文件名（cn-cli / intl-cli / intl-work）
        const cm = await poolCreditMap(s.site);
        s.supportsCredit = cm.supported;
        s.accounts = (loadPool(s.site) || []).map((a) => {
          const c = cm.map[a.id];
          return {
            id: a.id,
            label: a.nickname || a.label || a.id,
            enabled: a.enabled,
            credit: c ? c.credit : null,
            creditDetail: c ? c.creditDetail : null,
            creditError: c ? c.creditError : (cm.error || null),
          };
        });
      }));
      return { kind: 'workbuddy', ok: true, sites };
    } catch (e) {
      return { kind: 'workbuddy', ok: false, error: String(e).slice(0, 160) };
    }
  }
  // new-api 系：/v1/dashboard/billing/usage 给「已用美元」
  // MiniMax Code：OAuth 凭证查会员/积分余额
  if (p.billingKind === 'minimax') {
    try {
      const r = await fetch('https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + (p.key || ''),
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return { kind: 'minimax', ok: false, error: `HTTP ${r.status} ${t.slice(0, 120)}` };
      }
      const j = await r.json();
      const br = j.base_resp || {};
      if (br.status_code && br.status_code !== 0) {
        return { kind: 'minimax', ok: false, error: `status ${br.status_code} ${br.status_msg || ''}`.slice(0, 160) };
      }
      const sum = j.op_credit_summary || {};
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const remains = num(sum.total_remaining_amount);
      return {
        kind: 'minimax',
        ok: true,
        credit: remains,
        creditFree: num(sum.free_remaining_amount),
        creditPurchased: num(sum.purchased_remaining_amount),
        hasTokenPlan: !!j.has_token_plan,
        planTier: j.token_plan_tier || '',
        planExpiresAt: j.token_plan_expires_at || j.expires_at || null,
        // 账号级明细：号池结构，先只有一个号
        accounts: (p.accounts || []).map((a) => ({
          id: a.id,
          label: a.label || a.id,
          enabled: a.enabled !== false,
          expiresAt: a.expiresAt || null,
          // 单号时把总余额记到唯一的号上；多号后这里要按号逐个查
          credit: (p.accounts || []).length === 1 ? remains : null,
        })),
      };
    } catch (e) {
      return { kind: 'minimax', ok: false, error: String(e).slice(0, 160) };
    }
  }
  if (p.billingKind === 'newapi') {
    const base = p.api === 'anthropic' ? trimSlash(p.base) : trimSlash(p.base).replace(/\/v1$/, '');
    const hit = async (path) => {
      const r = await fetch(base + path, {
        headers: { Authorization: 'Bearer ' + p.key }, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    };
    // 网络抖动很常见（实测同样请求 3 次里 1 次 fetch failed），所以重试两次
    let usage = null, lastErr = null;
    for (let i = 0; i < 3; i++) {
      try { usage = await hit('/v1/dashboard/billing/usage'); lastErr = null; break; }
      catch (e) { lastErr = e; if (e.status === 404) break; await new Promise((r) => setTimeout(r, 400)); }
    }
    if (!usage) {
      // 404 说明这个站是自研网关，根本没有 new-api 的账单接口
      const notSupport = lastErr && lastErr.status === 404;
      return {
        kind: 'newapi', ok: false,
        error: notSupport ? '该站没有额度查询接口' : String(lastErr && lastErr.message || lastErr).slice(0, 160),
        unsupported: !!notSupport,
      };
    }
    let remainUSD = null;
    try {
      const sub = await hit('/v1/dashboard/billing/subscription');
      const hard = Number(sub.hard_limit_usd);
      if (Number.isFinite(hard) && hard > 0 && hard < 1e7) remainUSD = Math.max(0, hard - (Number(usage.total_usage) || 0));
    } catch {}
    return { kind: 'newapi', ok: true, usedUSD: Number(usage.total_usage) || 0, remainUSD };
  }
  return { kind: 'none' };
}

/** 一次极小的真实请求：唯一可信的「还有没有额度」判据 */
async function probeUsable(p, modelId) {
  const t0 = nowMs();
  try {
    const r = await callUpstream(p, modelId, {
      model: modelId, max_tokens: 8, stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, 40000);
    const text = await r.text();
    if (r.ok) return { ok: true, ms: nowMs() - t0 };
    return { ok: false, status: r.status, kind: classify(r.status, text), error: text.slice(0, 240) };
  } catch (e) {
    return { ok: false, status: 0, kind: 'network', error: String(e).slice(0, 200) };
  }
}

// ============================================================
// WorkBuddy 账号池 / 签到（复用服务器上已有的实现）
// ============================================================
// 逐个账号查余额（WorkBuddy 代理的 /console/api/pool 才有账号级数据；
// /console/api/state 只给站点合计）。串行打上游容易被限流，但这里账号数很少，
// 实测 cn-cli 2 个账号 0.6s、intl-work 3 个账号 0.35s。
async function poolCreditMap(site) {
  const prov = loadCfg().providers.find((x) => x.billingKind === 'workbuddy');
  if (!prov) return { supported: false, map: {} };
  try {
    const r = await fetch(WB_PROXY + '/console/api/pool?site=' + encodeURIComponent(site), {
      headers: { Authorization: 'Bearer ' + prov.key, 'X-Api-Key': prov.key },
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) return { supported: false, map: {}, error: 'HTTP ' + r.status };
    const j = await r.json();
    const map = {};
    for (const a of j.accounts || []) {
      map[a.id] = {
        credit: typeof a.credit === 'number' ? a.credit : null,
        creditDetail: Array.isArray(a.credit_detail) ? a.credit_detail : null,
        creditError: a.credit_error || null,
      };
    }
    return { supported: !!j.supports_credit, map };
  } catch (e) {
    return { supported: false, map: {}, error: String(e).slice(0, 160) };
  }
}

function loadPool(site) {
  if (!WB_PROXY_DIR) return [];
  const p = path.join(WB_PROXY_DIR, `auth.${site}.pool.json`);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = j.accounts ? Object.values(j.accounts) : Array.isArray(j) ? j : [j];
    return arr.map((a) => ({
      id: a.id, label: a.label || a.nickname || a.uid,
      nickname: a.nickname, uid: a.uid, domain: a.domain,
      enabled: a.enabled !== false,
      expiresAt: a.expiresAt, exhaustedAt: a.exhaustedAt || null,
      cooldownUntil: a.cooldownUntil || null,
      failCount: a.failCount || 0,
      lastError: a.lastError || '', lastErrorAt: a.lastErrorAt || null,
      lastUsedAt: a.lastUsedAt || null,
      hasRefresh: !!a.refreshToken,
      // 签到：每个账号独立开关
      checkinEnabled: a.checkinEnabled !== false,
      checkinDisabledReason: a.checkinDisabledReason || '',
      lastCheckinAt: a.lastCheckinAt || null,
      lastCheckinMsg: a.lastCheckinMsg || '',
      lastCheckinOk: a.lastCheckinOk === undefined ? null : !!a.lastCheckinOk,
      lastCheckinSkipped: !!a.lastCheckinSkipped,
    }));
  } catch { return []; }
}

async function checkinStatus() {
  if (!WB_PROXY_DIR) return { enabled: false, next: '', log: '' };
  const [timer, last] = await Promise.all([
    sh('systemctl --user is-enabled workbuddy-checkin.timer 2>&1'),
    sh('systemctl --user show workbuddy-checkin.timer -p NextElapseUSecRealtime --value 2>&1'),
  ]);
  let log = '';
  try { log = fs.readFileSync(path.join(WB_PROXY_DIR, 'checkin.log'), 'utf8').split('\n').slice(-14).join('\n'); } catch {}
  return { enabled: timer.trim() === 'enabled', next: last.trim(), log };
}

async function sh(cmd, timeout = 20000) {
  try { const { stdout } = await execAsync(cmd, { timeout, maxBuffer: 8 * 1024 * 1024 }); return stdout.trim(); }
  catch (e) { return String(e.stdout || e.message || '').trim(); }
}

// ============================================================
// HTTP 路由
// ============================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  // ---------- 健康检查 ----------
  if (p === '/health' || p === '/healthz') {
    const cfg = loadCfg();
    const state = loadState();
    return jsonRes(res, 200, {
      ok: true,
      exposeModel: cfg.exposeModel,
      chain: chainEntries(cfg).length,
      healthChain: chainEntries(cfg).map((c) => {
        const k = `${c.providerId}/${c.modelId}`;
        const h = healthOf(state, k);
        return { key: k, ok: h.ok, downUntil: h.downUntil, lastError: h.lastError };
      }),
    });
  }

  // ---------- OpenAI 兼容入口 ----------
  if (p === '/v1/models' || p === '/models') {
    const cfg = loadCfg();
    // 模型列表不暴露上游供应商和真实模型名，避免泄露降级链结构
    return jsonRes(res, 200, {
      object: 'list',
      data: [{ id: cfg.exposeModel, object: 'model', created: 1700000000, owned_by: 'dafeiyu-relay' }],
    });
  }

  if (p === '/v1/chat/completions' || p === '/chat/completions') {
    const cfg = loadCfg();
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (cfg.apiKey && auth !== cfg.apiKey) {
      return jsonRes(res, 401, { error: { message: 'invalid relay api key', type: 'invalid_api_key' } });
    }
    let body;
    try { body = await readJson(req); }
    catch (e) { return jsonRes(res, 400, { error: { message: 'bad json: ' + e.message, type: 'invalid_request' } }); }
    const state = loadState();
    try { return await dispatch(cfg, state, body, res); }
    catch (e) {
      return jsonRes(res, 500, { error: { message: String(e).slice(0, 300), type: 'relay_internal' } });
    }
  }

  // ---------- 管理 API ----------
  if (p.startsWith('/api/')) {
    const cfg = loadCfg();
    // 管理接口必须带密钥（面板反代会自动注入）。:8790 是 0.0.0.0 监听，
    // 不校验就等于把全部供应商密钥裸奔在公网上。
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const adminTok = req.headers['x-relay-admin'] || '';
    if (cfg.apiKey && auth !== cfg.apiKey && adminTok !== cfg.apiKey) {
      return jsonRes(res, 401, { error: { message: '需要管理员密钥', type: 'unauthorized' } });
    }
    const action = p.slice(5);

    try {
      // 全量状态
      if (action === 'state' && method === 'GET') {
        const state = loadState();
        const out = structuredClone(cfg);
        // 面板本身有登录鉴权，密钥可以明文回显（否则没法核对/迁移）。
        // 同时给一份脱敏版用于列表展示。
        for (const prov of out.providers) {
          prov.keyMasked = prov.key ? `${prov.key.slice(0, 6)}…${prov.key.slice(-4)}` : '';
        }
        out.health = chainEntries(cfg).map((c) => {
          const k = `${c.providerId}/${c.modelId}`;
          return { key: k, ...healthOf(state, k) };
        });
        out.usage = state.usage;
        out.runtime = {
          uptimeSec: Math.floor(process.uptime()),
          memMB: Math.round(process.memoryUsage().rss / 1048576),
          node: process.version,
          publicHost: cfg.publicHost || process.env.PUBLIC_HOST || 'localhost',
          dockerHost: cfg.dockerHost || '172.17.0.1',
          port: cfg.port,
        };
        return jsonRes(res, 200, out);
      }

      // ---- 供应商 ----
      if (action === 'provider/add' && method === 'POST') {
        const b = await readJson(req);
        if (!b.label || !b.base) return jsonRes(res, 400, { error: 'label 和 base 必填' });
        const id = b.id || (b.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex'));
        if (cfg.providers.some((x) => x.id === id)) return jsonRes(res, 400, { error: 'id 已存在' });
        cfg.providers.push({
          id, label: b.label, api: b.api === 'anthropic' ? 'anthropic' : 'openai',
          base: trimSlash(b.base), key: b.key || '',
          enabled: b.enabled !== false,
          billingKind: b.billingKind || 'newapi',
          models: [],
        });
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true, id });
      }

      if (action === 'provider/update' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.id);
        if (!prov) return jsonRes(res, 404, { error: '未找到' });
        for (const k of ['label', 'api', 'base', 'billingKind', 'anthropicVersion']) {
          if (b[k] !== undefined) prov[k] = k === 'base' ? trimSlash(b[k]) : b[k];
        }
        if (b.key !== undefined && b.key !== '') prov.key = b.key;
        if (b.enabled !== undefined) prov.enabled = !!b.enabled;
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      if (action === 'provider/remove' && method === 'POST') {
        const b = await readJson(req);
        cfg.providers = cfg.providers.filter((x) => x.id !== b.id);
        cfg.chain = cfg.chain.filter((c) => c.providerId !== b.id);
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      if (action === 'provider/test' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.id);
        if (!prov) return jsonRes(res, 404, { error: '未找到' });
        const models = await fetchModels(prov);
        const first = (b.modelId && models.models.find((m) => m.id === b.modelId)) || models.models[0];
        const probe = first ? await probeUsable(prov, first.id) : null;
        const quota = await queryQuota(prov);
        return jsonRes(res, 200, { models, probe, quota });
      }

      if (action === 'provider/quota' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.id);
        if (!prov) return jsonRes(res, 404, { error: '未找到' });
        return jsonRes(res, 200, await queryQuota(prov));
      }

      // ---- 模型 ----
      if (action === 'model/refresh' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.id);
        if (!prov) return jsonRes(res, 404, { error: '未找到' });
        const r = await fetchModels(prov);
        if (!r.ok) return jsonRes(res, 200, { ok: false, error: r.error, added: 0, total: prov.models.length });
        // 合并：已有的保留启用状态与手工设置；新的加入
        const map = new Map(prov.models.map((m) => [m.id, m]));
        let added = 0;
        for (const um of r.models) {
          if (map.has(um.id)) {
            const em = map.get(um.id);
            if (!em.contextWindow) em.contextWindow = um.upstreamContext || guessContext(um.id);
            if (!em.name) em.name = um.name;
            if (um.supportsImages) em.supportsImages = true;
            if (um.credits) em.credits = um.credits;
          } else {
            map.set(um.id, {
              id: um.id, name: um.name, enabled: false,
              contextWindow: um.upstreamContext || guessContext(um.id),
              maxTokens: 4096,
              ...(um.supportsImages ? { supportsImages: true } : {}),
              ...(um.credits ? { credits: um.credits } : {}),
            });
            added++;
          }
        }
        prov.models = [...map.values()];
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true, added, total: prov.models.length, listed: r.models.length });
      }

      if (action === 'model/toggle' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.providerId);
        const m = prov?.models.find((x) => x.id === b.modelId);
        if (!m) return jsonRes(res, 404, { error: '未找到' });
        m.enabled = !!b.enabled;
        // 关掉模型时，把它从链里摘掉（保留条目但标记禁用，方便恢复）
        for (const c of cfg.chain) {
          if (c.providerId === b.providerId && c.modelId === b.modelId) c.enabled = m.enabled;
        }
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      if (action === 'model/update' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.providerId);
        const m = prov?.models.find((x) => x.id === b.modelId);
        if (!m) return jsonRes(res, 404, { error: '未找到' });
        if (b.contextWindow !== undefined) m.contextWindow = Number(b.contextWindow) || 0;
        if (b.maxTokens !== undefined) m.maxTokens = Number(b.maxTokens) || 4096;
        if (b.name !== undefined) m.name = b.name;
        if (b.supportsImages !== undefined) m.supportsImages = !!b.supportsImages;
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      if (action === 'model/add' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.providerId);
        if (!prov) return jsonRes(res, 404, { error: '未找到' });
        if (!b.modelId) return jsonRes(res, 400, { error: 'modelId 必填' });
        if (prov.models.some((m) => m.id === b.modelId)) return jsonRes(res, 400, { error: '模型已存在' });
        prov.models.push({
          id: b.modelId, name: b.name || b.modelId, enabled: true,
          contextWindow: Number(b.contextWindow) || 0, maxTokens: Number(b.maxTokens) || 4096,
        });
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      if (action === 'model/remove' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.providerId);
        if (!prov) return jsonRes(res, 404, { error: '未找到' });
        prov.models = prov.models.filter((m) => m.id !== b.modelId);
        cfg.chain = cfg.chain.filter((c) => !(c.providerId === b.providerId && c.modelId === b.modelId));
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      if (action === 'model/guess-context' && method === 'POST') {
        let n = 0;
        for (const prov of cfg.providers) {
          for (const m of prov.models || []) {
            if (!m.contextWindow) { const g = guessContext(m.id); if (g) { m.contextWindow = g; n++; } }
          }
        }
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true, filled: n });
      }

      // ---- 降级链 ----
      if (action === 'chain/set' && method === 'POST') {
        const b = await readJson(req);
        if (!Array.isArray(b.chain)) return jsonRes(res, 400, { error: 'chain 必须是数组' });
        const next = [];
        for (const c of b.chain) {
          const prov = cfg.providers.find((x) => x.id === c.providerId);
          const m = prov?.models.find((x) => x.id === c.modelId);
          if (!prov || !m) continue;
          next.push({
            providerId: c.providerId, modelId: c.modelId,
            enabled: c.enabled !== false && m.enabled !== false,
          });
        }
        cfg.chain = next;
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true, length: next.length });
      }

      if (action === 'chain/add' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.providerId);
        const m = prov?.models.find((x) => x.id === b.modelId);
        if (!prov || !m) return jsonRes(res, 404, { error: '未找到供应商或模型' });
        if (cfg.chain.some((c) => c.providerId === b.providerId && c.modelId === b.modelId)) {
          return jsonRes(res, 400, { error: '已在链中' });
        }
        cfg.chain.push({ providerId: b.providerId, modelId: b.modelId, enabled: true });
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      if (action === 'chain/remove' && method === 'POST') {
        const b = await readJson(req);
        cfg.chain = cfg.chain.filter((c) => !(c.providerId === b.providerId && c.modelId === b.modelId));
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      // ---- 全局设置 ----
      if (action === 'settings' && method === 'POST') {
        const b = await readJson(req);
        if (b.exposeModel) cfg.exposeModel = String(b.exposeModel);
        if (b.apiKey) cfg.apiKey = String(b.apiKey);
        if (b.fallbackReply !== undefined) cfg.fallbackReply = String(b.fallbackReply);
        if (b.failover) Object.assign(cfg.failover, b.failover);
        if (b.visionModel !== undefined) {
          const v = b.visionModel || {};
          cfg.visionModel = {
            providerId: String(v.providerId || ''),
            modelId: String(v.modelId || ''),
            enabled: !!v.enabled,
          };
        }
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true });
      }

      // ---- 看图模型测试 ----
      if (action === 'vision/test' && method === 'POST') {
        const b = await readJson(req);
        const prov = cfg.providers.find((x) => x.id === b.providerId);
        const m = (prov?.models || []).find((x) => x.id === b.modelId);
        if (!prov || !m) return jsonRes(res, 404, { error: '未找到供应商或模型' });
        // 1x1 红色 PNG
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';
        const t0 = nowMs();
        try {
          const r = await callUpstream(prov, m.id, {
            model: m.id, max_tokens: 40, stream: false,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: '这张图是什么颜色？只回答颜色名。' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } },
              ],
            }],
          }, 60000);
          const txt = await r.text();
          if (!r.ok) {
            return jsonRes(res, 200, { ok: false, status: r.status, ms: nowMs() - t0, error: txt.slice(0, 300) });
          }
          let reply = '';
          try {
            const j = JSON.parse(txt);
            reply = j.choices?.[0]?.message?.content || '';
          } catch { reply = txt.slice(0, 200); }
          return jsonRes(res, 200, { ok: !!reply, ms: nowMs() - t0, reply: String(reply).slice(0, 120) });
        } catch (e) {
          return jsonRes(res, 200, { ok: false, ms: nowMs() - t0, error: String(e).slice(0, 200) });
        }
      }

      // ---- 健康重置 ----
      if (action === 'health/reset' && method === 'POST') {
        const state = loadState();
        state.health = {};
        saveState(state);
        return jsonRes(res, 200, { ok: true });
      }

      // ---- 签到 ----
      if (action === 'checkin/status' && method === 'GET') {
        return jsonRes(res, 200, await checkinStatus());
      }
      if (action === 'checkin/toggle' && method === 'POST') {
        const b = await readJson(req);
        const cmd = b.enabled
          ? 'systemctl --user enable --now workbuddy-checkin.timer 2>&1'
          : 'systemctl --user disable --now workbuddy-checkin.timer 2>&1';
        const out = await sh(cmd);
        cfg.checkin.enabled = !!b.enabled;
        saveCfg(cfg);
        return jsonRes(res, 200, { ok: true, out });
      }
      if (action === 'checkin/run' && method === 'POST') {
        // 直接跑 --now（跳过随机延迟），不走 systemd service，
        // 因为 service 里含 0~90 分钟随机等待，手动点击时等不起。
        if (!WB_PROXY_DIR) return jsonRes(res, 400, { error: '未配置 WB_PROXY_DIR' });
        const cmd = 'cd ' + WB_PROXY_DIR
          + ' && nohup node checkin.mjs --now >> checkin.log 2>&1 &';
        const out = await sh(cmd);
        return jsonRes(res, 200, { ok: true, out });
      }

      // ---- WorkBuddy 账号池 ----
      if (action === 'accounts' && method === 'GET') {
        // 余额是可选项：带 ?credit=1 才去查（要串行打上游，会慢一点）
        const wantCredit = url.searchParams.get('credit') === '1';
        const sites = WB_SITES;
        const out = {};
        const credits = {};
        for (const site of sites) {
          out[site] = loadPool(site);
          credits[site] = wantCredit ? await poolCreditMap(site) : { supported: false, map: {} };
        }
        for (const site of sites) {
          const cm = credits[site];
          for (const a of out[site]) {
            const c = cm.map[a.id];
            a.credit = c ? c.credit : null;
            a.creditDetail = c ? c.creditDetail : null;
            a.creditError = c ? c.creditError : (cm.error || null);
          }
        }
        const meta = {};
        for (const site of sites) meta[site] = { supportsCredit: credits[site].supported };
        return jsonRes(res, 200, Object.assign(out, { _meta: meta }));
      }

      if (action === 'accounts/quota' && method === 'POST') {
        const b = await readJson(req);
        const sites = b.site ? [String(b.site)] : WB_SITES;
        const out = {};
        for (const site of sites) out[site] = await poolCreditMap(site);
        return jsonRes(res, 200, { ok: true, sites: out });
      }
      // 单个账号的签到开关
      if (action === 'account/checkin-toggle' && method === 'POST') {
        const b = await readJson(req);
        const site = String(b.site || '');
        const accId = String(b.accountId || '');
        if (!site || !accId) return jsonRes(res, 400, { error: 'site 和 accountId 必填' });

        if (!WB_PROXY_DIR) return jsonRes(res, 400, { error: '未配置 WB_PROXY_DIR' });
        const p = path.join(WB_PROXY_DIR, `auth.${site}.pool.json`);
        let raw;
        try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return jsonRes(res, 404, { error: '账号池读取失败' }); }
        const arr = raw.accounts ? Object.values(raw.accounts) : (Array.isArray(raw) ? raw : [raw]);
        const acc = arr.find((a) => a.id === accId);
        if (!acc) return jsonRes(res, 404, { error: '账号不存在' });

        acc.checkinEnabled = !!b.enabled;
        if (b.enabled) delete acc.checkinDisabledReason;
        else acc.checkinDisabledReason = '手动关闭';
        fs.writeFileSync(p, JSON.stringify(raw, null, 2), { mode: 0o600 });

        return jsonRes(res, 200, { ok: true, site, accountId: accId, enabled: acc.checkinEnabled });
      }

      // ---- 用量 ----
      if (action === 'usage/reset' && method === 'POST') {
        const state = loadState();
        state.usage = { days: {} };
        saveState(state);
        return jsonRes(res, 200, { ok: true });
      }

      return jsonRes(res, 404, { error: 'unknown api: ' + action });
    } catch (e) {
      return jsonRes(res, 500, { error: String(e).slice(0, 400) });
    }
  }

  // ---------- 静态 UI ----------
  const file = p === '/' ? '/index.html' : p;
  const full = path.join(UI_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(UI_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = fs.readFileSync(full);
    const ext = path.extname(full);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
    // 管理接口需要密钥。页面本身由中转站提供，把手上的 apiKey 注入进去，
    // 这样点开就能用，不用手填（和 WorkBuddy 控制台的做法一致）。
    if (ext === '.html') {
      const cfgNow = loadCfg();
      const html = buf.toString('utf8').replace(
        '<head>',
        `<head>\n<script>window.__RELAY_KEY__=${JSON.stringify(cfgNow.apiKey || '')};</script>`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return res.end(buf);
  } catch {
    // 单页应用兜底
    try {
      const idx = fs.readFileSync(path.join(UI_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(idx);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('relay UI 未部署');
    }
  }
});

// ============================================================
// 启动
// ============================================================
const cfg0 = loadCfg();
if (!fs.existsSync(CFG_PATH)) saveCfg(cfg0);

server.listen(cfg0.port, cfg0.host, () => {
  console.log(`[relay] listening on ${cfg0.host}:${cfg0.port}`);
  console.log(`[relay] exposeModel=${cfg0.exposeModel} chain=${chainEntries(cfg0).length}`);
});

process.on('uncaughtException', (e) => console.error('[relay] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[relay] unhandled', e));
