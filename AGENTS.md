# 上下文速记（给 AI 助手看）

如果你是这个仓库的 AI 助手，先看这里，能省一半时间。

## 用户偏好

- **先验证再说**。不确定就说不确定，不要猜完当结论。
- **给可直接复制的命令**，不要只说「加条记录」。
- **不要堆安全措施**。先查实际数据，用数据支撑建议。用户会问「这有必要吗」。
- 讨厌慢的界面、讨厌被锁在外面。

## 项目背景

- 这是个人自用的 QQ 机器人基础设施，**不是产品**。不要提议加多租户、计费、权限系统。
- 线上跑在阿里云 ECS 广州，`2C/2G/40G`，很紧。
- 服务器上的真实路径是 `/root/relay`、`/root/dashboard`、`/root/bot/astrbot/data`。
- 公开仓库里的代码是同一份，但**所有路径和密钥都改成了环境变量/占位符**。

## 关键约束

1. **零依赖是硬要求**。relay.mjs 不许 `import` 任何 npm 包，只用 Node 标准库。
2. **单文件**。中转站主程序、管理面板、控制台前端，都是单文件，不拆。
3. **不用数据库**。状态存 JSON。
4. **不引入构建步骤**。`node xxx.mjs` 直接跑。

## 密码/密钥位置（本仓库内）

**本仓库不含任何真实密钥。** 全部是 `process.env.XXX` 或 `REPLACE_ME_XXX`。

线上真实值在服务器的：
- `/root/relay/relay.json`（各供应商 key、网关 apiKey）
- `/root/relay/minimax-accounts.json`（MiniMax OAuth）
- `/root/.ghtoken`（备份用 GitHub token）
- systemd user service 的 `Environment=` 行（控制台密码等）

**永远不要把这些值写进本仓库或任何聊天记录。**

## 改代码时的注意事项

- 改 `relay.mjs` 后必须重启：`systemctl --user restart relay`
- 改 `dashboard/` 后：`systemctl --user restart dashboard`
- 中转站的健康状态存在 `relay-state.json`，改配置不要动它
- 删供应商前先确认它不在 `chain` 里，否则链会断

## 常见误判

- `ilinkai.weixin.qq.com` 根路径返回 **404 是正常的**（没有根资源），不代表不通。
- `api.workbuddy.ai` 解析到 `0.0.0.1` 是**被污染**，不是 DNS 配错。
- Anthropic 站报 `token is required` 大概率是鉴权头位置不对（见 `docs/避坑.md` 第 1 条）。
