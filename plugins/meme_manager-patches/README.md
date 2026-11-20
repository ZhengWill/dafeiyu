# meme_manager 本地改动说明

> 针对 [astrbot_plugin_meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager)
> 的本地修改记录。
>
> **上游项目**：作者 **anka**，**MIT License**（Copyright (c) 2025 anka），版本 5.2.11
>
> **本项目不分发该插件的代码**。这里只有「改了什么、为什么改」的说明，
> 你需要自行安装上游插件，再按本文档手动应用修改。

---

## 为什么单独记这一份

这个插件本身很好用，但在**语义检索**这一块有个设计问题，会导致选图不准。
我们排查后改了 3 处，效果明显。

按 MIT 协议，修改他人代码再分发需要保留原版权声明。所以：

- **不打包完整代码**（避免混淆归属）
- **只记录改动点**，你可以自己改，也可以提给上游

---

## 改动 1：描述不再被分类前缀污染 ⭐ 最重要

### 位置

`backend/semantic/models.py` → `anchor_caption_to_category()`

### 原始行为

上游会给每条图片描述**强制加上分类前缀**：

```python
# 上游逻辑（简化）
if not value.startswith(f"以当前分类「{category_value}」"):
    return f"以当前分类「{category_value}」来看，{value}"
```

### 问题

跑了几天后发现：**95 张图里有 86 张的描述是这个句式开头**。

```
以当前分类「shy」来看，画面是一个害羞的表情
以当前分类「shy」来看，角色低头脸红
以当前分类「shy」来看，……
```

**为什么这是灾难**：

1. **向量检索失效**。所有描述开头都一样，向量空间里挤成一团，
   模型拿到「找一张害羞的图」时，无法区分具体画面
2. **描述被稀释**。真正有价值的画面信息（角色、动作、表情细节）被压到句子后半段
3. **模型读到的是分类，不是画面**。而分类本来就已经在
   `fixed_category_tag` 和 `category_description` 两个独立字段里了

### 改法

```python
def anchor_caption_to_category(
    caption: str,
    tags: Any,
    category: str,
    category_fit: str,
    category_description: str = "",
) -> str:
    """在非明确冲突时，确保描述不会完全丢失用户已有分类这一主语。"""
    value = str(caption or "").strip()
    category_value = str(category or "").strip()
    if not value or not category_value or category_fit == "conflict":
        return value
    if value.startswith(f"以当前分类“{category_value}”"):
        return value
    # 不再给描述套分类前缀。分类已经由 build_semantic_text() 的
    # 「固定分类标签」「分类含义」两个独立字段承载，这里再拼一次只会
    # 让「图片含义」被分类说明稀释，并让绝大多数描述变成同一句式开头，
    # 模型选图时读到的就不是画面了。
    return value
```

**核心就一句**：不再拼前缀，原样返回。

### 效果

改完重新生成后：**95 张图，模板化描述 0 张**（原来 86 张）。

---

## 改动 2：补全语义索引的覆盖率

### 问题

有一个 416 张图的素材包，但语义索引里只有 **242 条记录**。
意味着 **174 张图检索不到**。

### 排查

不是索引机制坏了，是**生成任务没跑完** —— 部分图因为体积大（600~900KB 的 GIF）
处理超时，异常被吞掉，状态卡在 `caption_status: running`。

### 处理

1. 把卡在 `running` 的 6 条手动改回 `pending`
2. **降低并发重跑**（从 6 降到 2~3）

### 教训

> **并发不是越高越好**。图片处理是 IO + 模型双瓶颈，
> 并发高了反而更多超时，而超时被 catch 掉之后就变成"静默丢失"。

**建议**：给批量任务加超时保护 + 启动时复位僵尸任务：

```python
# 启动时把 running 状态复位成 pending
db.execute("UPDATE items SET caption_status='pending' WHERE caption_status='running'")
```

---

## 改动 3：嵌入维度模式

### 位置

`cmd_config.json` → `provider_settings.embedding_dimensions_mode`

### 报错

```
Unknown embedding_dimensions_mode: 'manual'
```

### 原因

AstrBot 只接受三个值：`auto` / `always` / `never`。
上游文档里可能提到过 `manual`，但当前版本不支持。

### 改法

```json
"embedding_dimensions_mode": "auto"
```

### 更坑的地方

**维度不匹配不会报错**。比如模型输出 1024 维、配置写 768，
程序照跑，但向量检索结果全是垃圾。

**上线前一定要验证召回**：拿一条已知内容搜一下，看能不能找到它自己。

---

## 附：如何自己应用这些修改

### 改动 1（必做，收益最大）

```bash
cd /你的路径/astrbot/data/plugins/meme_manager
# 编辑 backend/semantic/models.py
# 找到 anchor_caption_to_category，把最后的
#   return f"以当前分类「{category_value}」来看，{value}"
# 改成
#   return value
```

改完**必须重新生成语义描述**，否则旧数据还是带前缀的。

### 改动 2

这是运维层面的事，不是改代码：

- 降低批处理并发
- 执行一次僵尸任务复位
- 重跑未完成的

### 改动 3

改 `cmd_config.json`，然后重启 AstrBot。

---

## 要不要提给上游？

**改动 1 值得提**，理由：

- 它不改变功能，只影响检索质量
- 有明确数据支撑（95 张里 86 张模板化 → 0 张）
- 注释里解释了为什么，维护者容易判断

**改动 2、3 不用提** —— 一个是并发策略建议，一个是配置错误，属于使用层面。

如果你要提 PR，记得：

1. 基于上游最新 main 分支
2. 只改 `anchor_caption_to_category` 一个函数
3. 保留原版权声明
4. PR 描述里放前后对比数据

---

## 授权说明

- 上游插件：[anka-afk/astrbot_plugin_meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager)
- 协议：**MIT**（Copyright (c) 2025 anka）
- 本文档描述的是**我们对上游代码做的修改**，修改部分同样以 MIT 释出
- **本仓库不包含该插件的任何源码**
