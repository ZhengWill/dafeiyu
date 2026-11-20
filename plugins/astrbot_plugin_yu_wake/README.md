# 大肥鱼 · 唤醒与互动插件

> `astrbot_plugin_yu_wake` v12.0.0 · MIT License
>
> 给 QQ 机器人加「类人群聊行为」。解决的不是「能不能聊天」，
> 而是**「群里的人愿不愿意留着它」**。

---

## 解决什么问题

默认的 AstrBot 是**被动响应**的：@ 它才说话，说完就消失。

放在群里，这种表现有几个硬伤：

| 问题 | 表现 |
|---|---|
| **叫不醒** | 群友喊「大肥鱼」但没 @，机器人当没看见 |
| **一次就断** | 聊两句又得重新 @，像在跟客服对话 |
| **太死板** | 从不主动说话，像个开关 |
| **太吵** | 一旦接了话就每句都回，刷屏 |
| **被戳没反应** | 拍一拍、戳一戳完全无视 |

这个插件就是逐条解决上面这些。

---

## 四个核心机制

### 1. 分层唤醒词

不是「消息里有名字就回」，而是分两级：

```python
# 强触发：唯一指向她，必回
strong_keywords = ["大肥鱼", "鲸鱼娘", "小鲸鱼", "肥鱼", "鱼娘", "肥鱼娘",
                   "维护不起", "吃白饭的鱼", "白饭鱼"]

# 弱触发：可能是她，也接受概率筛选
weak_keywords = ["吃白饭", "白饭", "大鲸鱼", "鲸鱼", "鱼鱼"]
weak_hit_rate = 0.25
```

**为什么要分层**：

- 「大肥鱼」这种词**只可能指她**，出现就该回
- 「白饭」「鲸鱼」是**日常高频词**——群友聊吃饭、聊别的鲸鱼、聊白饭，都不一定在叫她

所以弱触发词还要再过一道**语境检查**：

```python
call_markers = ["吗", "呢", "吧", "？", "?", "在不在", "在吗", "谁",
                "怎么", "多少", "能不能", "是不是", "有没有", "你说", "你觉得"]

def _weak_hit(self, event):
    if not any(kw in msg for kw in self.weak_keywords):
        return False
    # 「白饭」这种高频词，必须是疑问句/呼语才算在叫她
    if "白饭" in msg:
        return any(m in msg for m in self.call_markers)
    return True
```

**效果**：说「今天吃白饭」不会触发；说「白饭是什么」或者「白饭在吗」才会触发。

这是整个插件最关键的判断——**宁可漏掉，也不要乱插话**。

### 2. 连续对话（会话 TTL）

被叫醒之后，5 分钟内不需要再点名：

```python
self.session_ttl = 300   # 秒
```

```python
def _in_session(self, event):
    return time.time() < self._sessions.get(event.unified_msg_origin, 0)
```

**效果**：@ 一次之后能连聊几句，像真人对话，而不是每次都要重新喊。

### 3. 主动发言 + 节流

按群设定「主动插话的概率和冷却」：

```python
# 按群定制：{群号: (发言概率, 冷却秒数)}
self.group_profiles = {}
self.default_profile = (0.30, 120)   # 默认 30% 命中，2 分钟冷却
```

但更重要的是一套**仿照真人的节流规则**：

```python
self.max_per_minute = 4        # 每分钟最多 4 条
self.max_per_10min  = 8        # 每 10 分钟最多 8 条
self.max_burst      = 3        # 15 秒内最多连发 3 条
self.burst_window   = 15

self.max_images_per_10min = 3  # 图片另算，10 分钟最多 3 张
self.max_images_per_hour = 10
```

**设计依据**：观察真实群友的发言节奏——总量不高，但会**连发两三条**。
所以这里不是「强制间隔」，而是允许连发、但限制窗口内的总量。

**这也是防封控的一部分**：稳定的、像人的节奏，比任何伪装都有效。

### 4. 戳一戳必须回

```python
self.poke_reply_rate = 1.0   # 必回
self.poke_back_rate = 0.6    # 60% 概率回戳
```

但有个 **OneBot 协议限制**必须绕开：

```
retcode=1400 message element "poke" can only be sent in a direct private chat
```

**群聊里发不出 poke 消息段**。所以逻辑是：

- **私聊**：回戳（用 `Poke` 组件）
- **群聊**：只回文字，不回戳

代码里对应 `_poke_hit_me()` 和 `_reply_poke()` 两个方法。

### 附加：无文本事件的处理

戳一戳没有文本内容，靠 `event.is_wake = True` 这种标记**不生效**（框架的唤醒判断走文本匹配）。

所以这里直接调 provider：

```python
resp = await self.context.get_using_provider().text_chat(
    prompt="用户戳了你一下",
    session_id=event.session_id,
)
await event.send(MessageChain().message(resp.completion_text))
```

---

## 指令列表

| 指令 | 作用 | 备注 |
|---|---|---|
| `#白饭` | 查模型用量（调用次数、Token、花了多少） | **需要中转站配合**，见下 |
| `#群分析` | 看本群活跃度统计 | |
| `#醒醒` | 叫醒 | 其实就是回一句「醒着呢…」 |
| `#ping` | 存活检测 | |
| `#reset` | 清空当前会话上下文 | 仅管理员 |
| `#help` | 指令列表 | |
| `#sl` | SnowLuma 状态 | 需要 SnowLuma |
| `#sing` | 唱歌 | 占位，没实现 |

### `#白饭` 的工作原理

它不是自己统计的，而是**读中转站的用量文件**：

```python
os.environ.get("RELAY_USAGE_FILE", "/root/relay/relay-usage.json")
```

然后做一层人类可读的转换：

```python
def _num(n):
    if n >= 100000000:  return format(n / 100000000.0, ".1f") + "亿"
    if n >= 10000:      return format(n / 10000.0, ".1f") + "万"
    return str(n)
```

输出类似：

```
白饭账单 · 今天
聊天 deepseek-v4.1-flash ×142
看图 MiniMax-M3.1-Flash ×18
共 8.3万 token
```

**如果你不用中转站**，这个指令会返回「查不到账单…」，不影响其他功能。

---

## 安装

### 方式一：手动放进去

```bash
# 进 AstrBot 的插件目录
cd /你的路径/astrbot/data/plugins

# 建目录，把 main.py 和 metadata.yaml 放进去
mkdir astrbot_plugin_yu_wake
cp main.py metadata.yaml astrbot_plugin_yu_wake/

# 重启 AstrBot
docker restart astrbot
```

### 方式二：AstrBot 面板

面板 → 插件 → 从文件安装 → 选择这个目录打包成的 zip。

### 配置

**必改项（二选一）**：

```bash
# 方式 A：环境变量（推荐，不改代码）
docker run -e OWNER_QQ=你的QQ号 ...

# 方式 B：直接改代码
# 找到这一行，把空字符串换掉
_owner = os.environ.get("OWNER_QQ", "")
```

**可选项**：

```python
# 主动发言策略：{群号: (概率, 冷却秒)}
self.group_profiles = {"123456789": (0.35, 90)}

# 唤醒词：换成你自己的角色名
self.strong_keywords = [...]
self.weak_keywords = [...]
```

---

## 调参建议

这套参数是**针对特定群氛围调出来的**，照搬大概率不合适。

| 参数 | 怎么调 |
|---|---|
| `strong_keywords` | 换成你机器人的名字。**一定要有唯一指向的词**（只可能指它的那种） |
| `weak_keywords` | 高频词，必须配 `call_markers` 用。宁可少列几个 |
| `weak_hit_rate` | 0.25 是实测比较稳的。调高会明显变吵 |
| `max_per_minute` | 你的群越活跃，这个可以越低。冷清群可以适当放宽 |
| `group_profiles` | 热闹的群调低概率，安静的群调高 |
| `poke_reply_rate` | 设 1.0 就是必回。觉得太频繁可以降 |

**最重要的建议**：先用**小号测试**，在你的群里跑几天，看群友反应。
如果有人说「话太多了」，第一件事是降 `weak_hit_rate` 和 `max_per_10min`。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **群聊不能回戳** | OneBot 协议限制，poke 消息段仅私聊可用 |
| **依赖 AstrBot API** | 用的是 `astrbot.api` 的接口，AstrBot 大版本升级可能需要适配 |
| **群号要手动配** | 没有自动发现机制，多群部署时每个群单独设 |
| **`#白饭` 只认中转站格式** | 如果你用的是别的网关，需要改 `_rj()` 里的解析逻辑 |

### 防封控的诚实说明

这个插件做了节流、限制了频率、模仿了真人节奏，**但这不是免死金牌**。

QQ 协议端（NapCat / SnowLuma 等）本身走的是协议模拟，腾讯有风控。
再像人的节奏也可能被封，**建议只挂小号**。

插件能做的只是**把明显的机器特征去掉**：
定时发送、固定间隔、无限高频、机械回复——这些都会加速暴露。

---

## 免责与致谢

- 本插件面向**个人自用场景**，没有做多租户隔离和权限体系
- 用它产生的任何后果（包括账号被封）由使用者自行承担
- 依赖 [AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0）运行，
  本项目通过其插件 API 对接，未修改其源码
- 详见仓库根目录 [CREDITS.md](../../CREDITS.md)

---

## License

MIT —— 随便改。改成你自己的角色更有意思。
