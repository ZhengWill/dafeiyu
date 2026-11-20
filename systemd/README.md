# systemd 单元文件

> 这套服务的所有定时任务和守护进程都在这里。
> 用的是 **user 级 systemd**（`systemctl --user`），不是系统级。

---

## 为什么用 user 级而不是系统级

| 方式 | 优点 | 缺点 |
|---|---|---|
| 系统级 `/etc/systemd/system/` | 开机即启，无需 linger | 要 root 权限改，配置和用户目录分离 |
| **user 级 `~/.config/systemd/user/`** | 不用 root，改起来方便，和代码放一起好备份 | 需要 `loginctl enable-linger` 才能在未登录时运行 |

我们选 user 级，因为**备份脚本可以直接把整个目录打包**，恢复时一把拷回去。

**必须做的第一步**：

```bash
loginctl enable-linger $USER
```

不执行这句，用户服务会在你退出 SSH 后停止。

---

## 文件清单

### 常驻服务（service，Restart=always）

| 单元 | 作用 | 依赖 |
|---|---|---|
| `relay.service` | 中转站网关 | 无（可选 workbuddy-proxy） |
| `dashboard.service` | 运维控制台 | docker |
| `sync-usage.service` | 每分钟同步用量给 AstrBot | relay |
| `astrbot-tls.service` | AstrBot 面板的 HTTPS 前置 | docker |
| `conn-guard.sh` 对应的服务 | 连接守卫（见 `backup/conn-guard.sh`） | docker |

### 定时任务（timer + oneshot service）

| 定时器 | 时间 | 作用 |
|---|---|---|
| `dafeiyu-backup.timer` | 每天 04:20 + 随机 0~40 分 | 备份并推 GitHub |
| `minimax-refresh.timer` | 每 3 小时（00/03/06/... 的 :15） | OAuth 续期 |
| `minimax-checkin.timer` | 每天 08:30 + 随机 0~90 分 | 每日签到 |
| `workbuddy-checkin.timer` | 每天 08:00 + 随机 0~120 分 | WorkBuddy 签到 |

### 第三方项目的单元（仅供参考）

| 单元 | 说明 |
|---|---|
| `workbuddy-proxy.service` | [workbuddy-openai-proxy](https://github.com/yuan240324/workbuddy-openai-proxy)（yuan240324 / MIT） |
| `workbuddy-checkin.service/timer` | 同上项目的签到 |

这两个单元**不属于本仓库**，列在这里只是为了让你的部署完整。

---

## 时间安排的讲究

几个定时任务的时间是**故意错开**的，不是随手写的：

```
00:15 / 03:15 / 06:15 ...   minimax-refresh    每 3 小时
04:20 (+40min 随机)          dafeiyu-backup     每日备份
08:00 (+120min 随机)         workbuddy-checkin  签到
08:30 (+90min 随机)          minimax-checkin    签到
```

**为什么这么排**：

1. **备份放在凌晨** —— 服务器最闲的时候，打包不占资源
2. **两个签到错开半小时** —— 避免同时打上游，触发风控
3. **加随机延迟** —— 固定时刻执行是明显的机器特征，随机化更像人
4. **续期每 3 小时检查一次** —— token 有效期 12 小时，脚本只在剩余不足 2 小时时真续期，
   等于每 12 小时一次，但有 4 次重试机会

---

## 安装

```bash
# 1. 复制到用户目录
mkdir -p ~/.config/systemd/user
cp *.service *.timer ~/.config/systemd/user/

# 2. 按你的实际路径改 ExecStart / WorkingDirectory
#    默认都是 /root/...，部署到别处要整体替换
sed -i 's|/root/|/你的路径/|g' ~/.config/systemd/user/*.service

# 3. 重新加载
systemctl --user daemon-reload

# 4. 启用需要的
systemctl --user enable --now relay.service
systemctl --user enable --now dashboard.service
systemctl --user enable --now dafeiyu-backup.timer
systemctl --user enable --now minimax-refresh.timer
systemctl --user enable --now minimax-checkin.timer

# 5. 【关键】让服务在你退出 SSH 后继续运行
loginctl enable-linger $USER
```

---

## 查看状态

```bash
# 所有本项目的单元
systemctl --user list-units --type=service | grep -E 'relay|dash|astrbot|minimax|dafeiyu'

# 定时器下次触发时间
systemctl --user list-timers

# 看日志
journalctl --user -u relay -f
journalctl --user -u dafeiyu-backup -n 50
```

---

## 常见问题

**Q：`Failed to connect to bus: No such file or directory`**

没有 user session。先 `loginctl enable-linger $USER`，或者用 `machinectl shell` 拿一个干净会话。

**Q：服务启了但不干活**

十有八九是 `WorkingDirectory` 写错，或者 `ExecStart` 里的脚本没有执行权限。
`journalctl --user -u <unit>` 看具体报错。

**Q：重启后服务没自动起来**

检查两件事：`systemctl --user is-enabled <unit>` 是不是 enabled，
以及 `loginctl show-user $USER | grep Linger` 是不是 yes。

---

## 关于 `.timer` 和 `cron` 的选择

用 systemd timer 而不是 cron，理由：

1. **能查状态**：`systemctl --user list-timers` 直接看下次触发时间和上次结果
2. **能记日志**：`journalctl --user -u xxx` 统一管理
3. **支持 `Persistent=true`**：机器关机错过了，开机后补跑（备份特别需要）
4. **随机延迟**：`RandomizedDelaySec` 一行搞定，cron 要自己写 sleep

代价是配置比一行 crontab 长。但对**需要可靠运行的定时任务**，这点复杂度值得。

---

## License

MIT —— 配置没法谈版权，都是公开的 systemd 语法。随便用。
