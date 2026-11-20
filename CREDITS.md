# 第三方组件与授权说明

本仓库**本身**的代码采用 [MIT 协议](../LICENSE)，但它在设计和实现上**依赖、参考或对接**了以下第三方项目。
这里如实列出，并按各自协议标注。

> 一句话总结：**本仓库不包含任何第三方代码副本**，全部是自己写的；
> 但有三个项目直接决定了它的形态和工作方式，必须点名。

---

## 一、运行时依赖（不包含代码，但必须安装）

这些是跑起来的前提，本仓库**不打包**它们的任何代码。

| 项目 | 作者 / 组织 | 协议 | 关系 |
|---|---|---|---|
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | AstrBotDevs | **AGPL-3.0** | Bot 框架本体。本项目作为它的**外部服务**存在，通过 OpenAI 兼容接口对接，**未链接、未修改、未分发**其代码 |
| [SnowLuma](https://github.com/motricseven7/snowluma) | motricseven7 | 见上游仓库 | QQ 协议端，以 Docker 镜像方式独立运行 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | NapNeko | 见上游仓库 | 前代协议端，本项目已迁移到 SnowLuma；文档中仅作历史对照提及 |

> **关于 AGPL**：AstrBot 是 AGPL-3.0。本项目与它只通过 **HTTP 接口**通信（进程隔离、无代码链接），
> 属于独立程序，因此本项目采用 MIT 不构成对 AGPL 的违反。
> 如果你打算**修改 AstrBot 本体**并对外提供服务，那部分改动需要遵循 AGPL-3.0 开源。

---

## 二、设计与实现参考（有实质参考，已标注）

### 1. workbuddy-openai-proxy ⭐ 最重要

| 项 | 内容 |
|---|---|
| 仓库 | https://github.com/yuan240324/workbuddy-openai-proxy |
| 作者 | **yuan240324** |
| 协议 | **MIT**（Copyright (c) 2026 yuan240324） |
| 版本 | 1.4.0 |

**关系说明：**

本项目**不包含**它的源码，但 `relay/` 与 `backup/` 中有大量**针对它的对接代码**：

- `relay/relay.mjs` —— 通过它的 `/console/api/state`、`/console/api/pool` 接口读取账号池与额度
- `backup/backup.sh` / `backup/restore.sh` —— 备份和恢复它的配置与账号池文件

**更重要的是：本项目的"多账号池 + 额度自动降级"这个设计思路，来自这个项目。**
`relay.mjs` 里的账号池数据结构、失败分类（quota / rate / auth / network）、冷却与轮换策略，
都是参照它的实现重写的。

**若你要使用 WorkBuddy 相关功能，必须自行安装该项目，并遵守它的 MIT 协议（保留版权声明）。**

### 2. astrbot_plugin_meme_manager

| 项 | 内容 |
|---|---|
| 仓库 | https://github.com/anka-afk/astrbot_plugin_meme_manager |
| 作者 | **anka** |
| 协议 | **MIT**（Copyright (c) 2025 anka） |
| 版本 | 5.2.11（本项目在服务器上使用的是此版本） |

**关系说明：**

本项目**未包含**该插件代码。但 `docs/避坑.md` 中的第 11~13 条，
是在调试该插件时踩出来的问题（页面 token 绑定、嵌入维度、并发僵尸任务），
因此那些经验描述与它直接相关。

如果你要复现完整功能，需要单独安装该插件。

### 3. OpenAI / Anthropic 官方 API 规范

- OpenAI Chat Completions API —— 本项目对外暴露的接口格式依据
- Anthropic Messages API —— 协议互转的目标格式依据

这两者是**公开规范**，不是开源代码，仅作事实性引用。

---

## 三、明确声明：以下内容为本项目原创

为避免混淆，以下部分**没有**参考或复制任何第三方实现：

| 文件 | 说明 |
|---|---|
| `relay/relay.mjs` | 中转站主程序，除账号池设计思路外全部自写 |
| `relay/ui/index.html` | 管理面板，全部自写 |
| `dashboard/server.mjs` | 运维控制台服务端，全部自写 |
| `dashboard/index.html` | 控制台前端，全部自写 |
| `backup/*` | 备份脚本，全部自写（含代码/密钥分离的设计） |
| `minimax/*` | MiniMax OAuth 续期与签到脚本，通过抓包实测接口后自写 |
| `docs/*` | 全部文档，基于本项目的真实部署经验 |

**本项目未使用任何 npm 第三方包**（`relay.mjs` 只 import Node 标准库），
也未在 HTML 中引用任何 CDN 资源或前端框架。

---

## 四、如果你要二次分发本项目的修改版

请遵守：

1. **保留**本仓库 `LICENSE` 中的 MIT 版权声明（Copyright (c) 2026 ZhengWill）
2. 如果你同时分发 **workbuddy-openai-proxy**，需保留其 MIT 声明（Copyright (c) 2026 yuan240324）
3. 如果你同时分发 **meme_manager**，需保留其 MIT 声明（Copyright (c) 2025 anka）
4. 如果你修改并分发 **AstrBot 本体**，需按 **AGPL-3.0** 开源你的修改

---

## 五、联系方式

如果你是上述项目的作者，认为本项目的标注方式有不妥，
请提 Issue，我会立即调整或补充。
