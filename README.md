<div align="center">

# 🐋 大肥鱼 · Dafeiyu

**一个跑在 2 核 2G 云服务器上的 QQ 机器人全家桶**

QQ 机器人 · 统一模型网关 · 多供应商自动降级 · Web 运维控制台 · 自动备份

[![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero Deps](https://img.shields.io/badge/deps-zero-brightgreen)](./relay/relay.mjs)
[![Size](https://img.shields.io/badge/%E5%86%85%E5%AD%98-2GB%20%E5%B0%B1%E8%83%BD%E8%B7%91-blue)]()
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**👉 想自己搭一套？直接跳 [快速开始](#-快速开始三步跑起来)。**

</div>

---

## 📖 这是什么

这不是一个玩具 demo，而是一套**真在线上跑着**的个人 QQ 机器人基础设施，全部代码开源。

它的核心价值不在于「能聊天」，而在于**怎么在极其有限的资源里，让一个 AI 机器人 7×24 稳定存活**：

> **2 核 CPU / 2GB 内存 / 40GB 硬盘 / 每月 40 块钱的阿里云学生机**
>
> 上面同时跑着：QQ 客户端（Docker）、机器人框架（Docker）、模型网关、运维控制台、自动备份。
> 连续在线 **20+ 天**，内存占用长期贴着上限，但没有 OOM 崩过。

### 一句话架构

```
QQ 用户
   ↓ 发消息
┌─────────────┐      ┌─────────────┐      ┌──────────────┐
│  SnowLuma   │ ───→ │   AstrBot   │ ───→ │  中转站 Relay │
│ (QQ 协议端)  │      │  (Bot 框架)  │      │  (模型网关)   │
│  Docker     │      │  Docker     │      │  零依赖 Node  │
└─────────────┘      └─────────────┘      └──────┬───────┘
                                                  │ 失败自动降级
                                    ┌─────────────┼─────────────┐
                                    ↓             ↓             ↓
                                 供应商A       供应商B       供应商C
```

**为什么要中间加一层「中转站」？**

因为大模型 API 太容易挂了 —— 限流、欠费、封号、网络抖动。如果 AstrBot 直连某一个供应商，那家一挂机器人就哑了。中转站对外只暴露**一个固定模型名**，内部维护一条**可手动排序的降级链**：第一个挂了自动掉到第二个，恢复了自动爬回来。换供应商、调顺序，全在网页上点，AstrBot 一行配置都不用改。

---

## ✨ 有什么

### 🛰️ 中转站（`relay/`）—— 本项目的主角

一个**零依赖、单文件**的模型网关，纯 Node 标准库，`node relay.mjs` 就能跑。

| 能力 | 说明 |
|---|---|
| **双协议互转** | 上游是 OpenAI 格式还是 Anthropic 格式都能接，自动转换请求/响应/流式 SSE |
| **自动降级链** | 失败自动下沉，健康探测恢复后自动回升；网页上拖拽改顺序 |
| **多账号池** | 同一供应商多账号轮换，额度或用尽自动切换 |
| **额度可见** | 各家供应商余额/已用量统一展示，一眼看出谁快没钱了 |
| **自动签到** | 支持定时签到型供应商（每天固定时段随机延迟执行，降低风控概率） |
| **对外单一模型名** | 客户端只认一个名字，内部怎么换都无感 |
| **内置管理面板** | 一个 HTML 单文件，概览/降级链/供应商/模型/账号/接入，全部网页操作 |
| **用量统计** | 每天调用次数、Token 消耗、失败率，保留 7 天 |

关键设计取舍：**不用数据库**（状态存 JSON）、**不用框架**（原生 http）、**不用构建**（无 npm install）。整个网关 2000 多行，一个文件，改起来和读起来都不需要上下文切换。

### 🖥️ 运维控制台（`dashboard/`）

一个页面看全所有服务：容器状态、CPU/内存/磁盘、Bot 身份、模型账号池、实时日志。

带登录鉴权，把 SnowLuma / AstrBot / 中转站 / noVNC 全部收进同一个入口，不用记一堆端口。

### 🔐 自动备份（`backup/`）

每天定时打包全站配置 + 代码 → 上传到私有 GitHub 仓库 → 保留最近 N 份。
配套 `restore.sh` 一键拉回来，灾难恢复不用靠记忆。

**关键设计**：备份包内**代码和密钥分离**（`code/` 与 `secrets/`），密钥部分在本地生成一份 `REPLACE_ME` 占位模板，即使备份仓库万一泄露，也不会直接丢掉所有 key。

### 🔄 MiniMax 号池（`minimax/`）

MiniMax Code 的 OAuth 凭证会 12 小时过期，而且**续期会轮换 refresh token**（旧的立刻作废）—— 这是个很容易踩的坑。

这里提供两个脚本：`refresh.mjs` 每 3 小时自动续期并同步写回网关配置，`checkin.mjs` 每天自动签到领积分。都带原子写入，不会写坏配置文件。

---

## 🚀 快速开始（三步跑起来）

### 前置要求

- **Node.js ≥ 18**（用到了原生 `fetch`）
- 一台能跑 Docker 的 Linux 机器（1 核 1G 也能跑，2G 更稳）
- 一个 QQ 号（建议小号）

### 第一步：起中转站

```bash
git clone https://github.com/ZhengWill/dafeiyu.git
cd dafeiyu/relay

# 复制配置模板
cp relay.example.json relay.json

# 编辑，至少填一个供应商
nano relay.json
```

`relay.json` 里先改这两处：

```jsonc
{
  "apiKey": "改成你自己的随机字符串",     // 客户端连你时用的钥匙
  "exposeModel": "dafeiyu",              // 对外暴露的模型名，叫什么都行
  "providers": [
    {
      "id": "my-provider",
      "label": "我的供应商",
      "api": "openai",                   // 或 "anthropic"
      "base": "https://api.xxx.com/v1",  // 供应商的地址
      "key": "sk-你的真实key",
      "models": [
        { "id": "deepseek-chat", "enabled": true }
      ]
    }
  ],
  "chain": [
    { "providerId": "my-provider", "modelId": "deepseek-chat", "enabled": true }
  ]
}
```

启动：

```bash
node relay.mjs
```

看到 `relay listening on 0.0.0.0:8790` 就成了。打开 `http://你的IP:8790/` 是管理面板。

**验证一下通不通：**

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer 你刚才填的apiKey" \
  -H "Content-Type: application/json" \
  -d '{"model":"dafeiyu","messages":[{"role":"user","content":"你好"}]}'
```

### 第二步：起 QQ 协议端 + Bot 框架

```bash
# QQ 协议端（首次启动要扫码登录）
docker run -d --name snowluma -p 5099:5099 -p 3000:3000 \
  -v qq-client-config:/app/.config \
  -v qq-gateway-data:/app/data \
  motricseven7/snowluma:latest

# Bot 框架
docker run -d --name astrbot -p 6185:6185 \
  -v /你的路径/astrbot/data:/AstrBot/data \
  soulter/astrbot:latest
```

打开 `http://你的IP:5099` 扫码登录 QQ，打开 `http://你的IP:6185` 进 AstrBot 面板。

### 第三步：把 AstrBot 接到中转站

在 AstrBot 面板里：**服务提供商 → 新增 → OpenAI 兼容**

| 字段 | 填什么 |
|---|---|
| API Base | `http://你的IP:8790/v1` |
| API Key | `relay.json` 里那个 `apiKey` |
| 模型名 | `relay.json` 里那个 `exposeModel`（默认 `dafeiyu`） |

完事。以后要换供应商、调顺序，**全在中转站网页上操作，AstrBot 不用再动**。

---

## 📂 目录结构

```
dafeiyu/
├── relay/                  # 🛰️ 中转站（核心）
│   ├── relay.mjs           #    主程序，零依赖单文件
│   ├── relay.example.json  #    配置模板（复制成 relay.json 再改）
│   └── ui/index.html       #    管理面板单文件
│
├── dashboard/              # 🖥️ 运维控制台
│   ├── server.mjs          #    服务端，含鉴权与反向代理
│   └── index.html          #    前端单文件
│
├── backup/                 # 🔐 备份与恢复
│   ├── backup.sh           #    打包（代码/密钥分离）
│   ├── push_backup.py      #    上传到 GitHub 私有仓库
│   └── restore.sh          #    一键恢复
│
├── minimax/                # 🔄 MiniMax 号池维护
│   ├── refresh.mjs         #    OAuth 续期（每 3 小时）
│   └── checkin.mjs         #    每日签到
│
└── docs/                   # 📚 详细文档
    ├── 部署.md              #    从零到跑通的完整步骤
    ├── 中转站.md            #    网关的配置项与工作原理
    └── 避坑.md              #    踩过的坑和怎么绕
```

---

## 🔧 上手前必须知道的几件事

### 1. 所有密钥都从环境变量或配置文件读，代码里没有

这个仓库里**没有任何真实密钥**。你在代码里看到的都是 `process.env.XXX` 或 `REPLACE_ME` 占位。

### 2. 中转站默认会生成自己的 API Key

第一次启动如果配置里没填 `apiKey`，它会自动生成一个随机串并写回 `relay.json`，同时在控制台打印出来。**这是故意的** —— 一个没有鉴权的模型网关等于把你的额度白送给全网。

### 3. 控制台密码必须手动设置，不设就登不上

```bash
export DASH_USER=admin
export DASH_PASS=你的密码
node dashboard/server.mjs
```

`DASH_PASS` 留空时，登录逻辑会**拒绝所有尝试** —— 宁可你用不了，也不能默认密码裸奔。

### 4. 关于 QQ 协议端的合规提醒

SnowLuma / NapCat 这类项目走的是**协议模拟**，不是官方 API。腾讯对此有风控，理论上存在封号风险。

**降低风险的做法**（本项目实际在用的）：

- 只挂小号，不上大号
- 不群发、不主动加好友、不做营销行为
- 消息频率控制在人类正常范围
- 敏感操作加冷却时间

如果你要的是**企业级合规方案**，请直接用腾讯官方的 QQ 机器人开放平台。

---

## 📊 资源占用参考（真实数据）

在这台 2C/2G 的机器上实测：

| 组件 | 内存 | 说明 |
|---|---|---|
| SnowLuma（QQ 客户端） | ~495 MB | 本质是个 Electron，最吃内存 |
| AstrBot | ~185 MB | Python，插件多了会涨 |
| 中转站 | ~60 MB | Node，几乎不涨 |
| 控制台 | ~25 MB | Node |
| 系统 + Docker | ~250 MB | |
| **合计** | **~1.0 GB** | 剩下约 700MB 余量 + 4GB swap |

**结论**：2G 内存是这条路的**下限**。要加微信、加更多插件，建议 4G 起步。

---

## 🗺️ Roadmap

- [x] 中转站：双协议互转 + 降级链 + 管理面板
- [x] 运维控制台：服务状态 / 系统指标 / 实时日志
- [x] 自动备份到 Git 仓库 + 一键恢复
- [x] MiniMax OAuth 自动续期与签到
- [ ] 中转站：WebSocket 流式转发优化
- [ ] 控制台：移动端适配
- [ ] 统一暗/亮主题切换
- [ ] 更完善的健康探测策略（按错误类型分级）

---

## 🤝 参与

发现问题、想加功能，欢迎提 Issue 或 PR。

特别欢迎这几类反馈：
- 你接了哪些供应商、遇到什么坑
- 你的降级链是怎么排的
- 资源占用能不能再压

---

## 🙏 致谢与第三方授权

**本项目为原创实现，但站在了几个优秀项目的肩膀上。如实标注如下（详见 [CREDITS.md](./CREDITS.md)）：**

### ⭐ workbuddy-openai-proxy —— 设计思路来源

| | |
|---|---|
| 作者 | **yuan240324** |
| 仓库 | https://github.com/yuan240324/workbuddy-openai-proxy |
| 协议 | **MIT** |

本项目**不含**它的源码，但两处有实质参考：

1. **设计参考**：中转站的「多账号池 / 额度降级 / 失败分类（quota·rate·auth·network）」
   这套思路来自该项目，`relay.mjs` 中相应部分是参照其实现重写的。
2. **接口对接**：账号池与额度面板通过它的 `/console/api/*` 接口通信。

> 想用 WorkBuddy 相关功能，**请自行安装该项目**（本项目不分发、不修改它）。

### AstrBot —— 运行框架

| | |
|---|---|
| 作者 | AstrBotDevs |
| 仓库 | https://github.com/AstrBotDevs/AstrBot |
| 协议 | **AGPL-3.0** |

本项目作为它的**外部服务**运行，仅通过 OpenAI 兼容 HTTP 接口通信（进程隔离、无代码链接）。
因此本项目采用 MIT **不违反** AGPL —— 两者是独立程序。

> 若你修改 AstrBot 本体并对外提供服务，那部分改动需遵循 AGPL-3.0。

### astrbot_plugin_meme_manager —— 踩坑经验的来源

| | |
|---|---|
| 作者 | **anka** |
| 仓库 | https://github.com/anka-afk/astrbot_plugin_meme_manager |
| 协议 | **MIT** |

`docs/避坑.md` 中第 11~13 条（页面 token 绑定、嵌入维度、并发僵尸任务）
是在调试该插件时踩出来的，经验描述与它直接相关。本项目不分发其代码。

### SnowLuma / NapCat —— QQ 协议端

- [SnowLuma](https://github.com/motricseven7/snowluma)（当前使用，Docker 独立运行）
- [NapCatQQ](https://github.com/NapNeko/NapCatQQ)（前代方案，已迁移）

### 公开 API 规范

OpenAI Chat Completions / Anthropic Messages —— 协议互转的格式依据（公开规范，非代码）。

---

**本仓库不含任何第三方代码副本，也未使用任何 npm 依赖或 CDN 资源。**
如果你认为标注有不妥，请提 Issue，我立即调整。

---

## 📄 License

本项目代码：**MIT** —— 随便用，出事了别找我。

二次分发时请保留：

- 本项目的 MIT 声明（Copyright (c) 2026 ZhengWill）
- 若同时分发上述第三方项目，各自的版权声明

---

<div align="center">

**如果这套东西帮你省下了几天踩坑时间，点个 ⭐ 就行。**

*Built with 🐟 on a very small server.*

</div>
