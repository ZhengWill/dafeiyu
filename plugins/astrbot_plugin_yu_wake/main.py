# -*- coding: utf-8 -*-
"""
大肥鱼 · 唤醒与互动插件（astrbot_plugin_yu_wake）
================================================================
Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)

给 QQ 机器人加「类人群聊行为」的 AstrBot 插件。解决四个具体问题：

  1. 分层唤醒    —— 「大肥鱼」这种称呼必回；「白饭」这种高频词要看语境
  2. 连续对话    —— 被叫醒后一段时间内持续参与，不用每句都点名
  3. 主动发言    —— 按群设定概率主动插话，带节流防止刷屏
  4. 防封控      —— 发言频率、连发、图片数量三重限制，模拟真人节奏

附带几个实用指令：
  #白饭    查模型用量（需要中转站 relay 配合）
  #群分析  看本群活跃度
  #醒醒    叫醒
  #sl      SnowLuma 状态
  #ping    存活检测

【设计要点】
· 强/弱两级唤醒词：「大肥鱼」唯一指向 → 必回；「白饭」多义 → 需配合疑问词
· 发言节流仿照真人：总量低（4条/分、8条/10分）但允许连发
· 戳一戳必回，但群聊中只能文字（OneBot 限制 poke 仅私聊可用）

本文件为原创实现，未包含第三方源码。
第三方致谢见 CREDITS.md
"""
import os
import time
import random
import logging

from astrbot.api.all import *
from astrbot.api.event import filter
from astrbot.core.message.components import At, Reply, AtAll, Poke, Image, Plain
from astrbot.core.message.message_event_result import MessageChain

_lg = logging.getLogger("astrbot")

@register(
    "astrbot_plugin_yu_wake",
    "dafeiyu",
    "带鱼唤醒 + 连续对话 + 主动参与 + 主人必回 + 戳一戳 + 防封控",
    "12.0.0",
)
class YuWakePlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        # ===== 分层唤醒词 =====
        # 强触发（唯一指向她，必回）
        self.strong_keywords = [
            "大肥鱼", "鲸鱼娘", "小鲸鱼", "肥鱼", "鱼娘", "肥鱼娘",
            "维护不起", "吃白饭的鱼", "白饭鱼",
        ]
        # 弱触发（可能是她，也接受概率筛）—— 只留称呼类
        self.weak_keywords = [
            "吃白饭", "白饭", "白饭鱼", "大鲸鱼", "鲸鱼", "鱼鱼",
        ]
        self.weak_hit_rate = 0.25

        # 「白饭」这类高频词，必须配合疑问/呼语才算
        self.call_markers = [
            "吗", "呢", "吧", "？", "?", "在不在", "在吗", "谁", "怎么",
            "多少", "能不能", "是不是", "有没有", "你说", "你觉得",
        ]

        self.keywords = self.strong_keywords  # 兼容旧引用
        self.session_ttl = 300
        self._sessions = {}
        # 主人 QQ 号 —— 改成你自己的，或用环境变量 OWNER_QQ 覆盖
        _owner = os.environ.get("OWNER_QQ", "")
        self.owner_ids = {_owner} if _owner else set()

        # ===== 主动发言（学习「吃白饭的」：约 0.6 条/分钟，会沉默几分钟）=====
        # 按群定制主动发言策略：{群号: (发言概率, 冷却秒数)}
        # 留空则所有群用 default_profile。示例：
        #   self.group_profiles = {"123456789": (0.35, 90)}
        self.group_profiles = {}
        self.default_profile = (0.30, 120)
        self._last_proactive = {}

        # ===== 发言节流（学习群里「吃白饭的」：总量低但会连发）=====
        self.msg_times = []
        self.max_per_minute = 4
        self.max_per_10min = 8       # 它 17 分钟 10 条，这里 10 分钟 8 条
        self.min_interval = 0        # 允许连发（真人也会连发两三条）

        # 连发控制：同一轮最多连发 3 条，之后必须沉默
        self.burst_count = 0
        self.burst_start = 0
        self.max_burst = 3
        self.burst_window = 15       # 15 秒内最多 3 条

        # ===== 图片限制 =====
        self.image_times = []
        self.max_images_per_10min = 3   # 它图片占 30%，这里约 3/8
        self.max_images_per_hour = 10

        self.skip_only = {"666", "哈哈哈", "嗯", "哦", "好的", "收到", "1", "。。", "草"}

        # 戳一戳：明确互动，要积极回应
        self.poke_back_rate = 0.6
        # 已改为必回：这个概率不再参与判断，保留只为兼容旧配置读取
        self.poke_reply_rate = 1.0
        self._last_poke = {}
        # 同一人 5 秒内重复戳不再回，避免连戳刷屏；超过 5 秒必回
        self.poke_cooldown = 5

        # 指令去重：防止重复回复
        self._cmd_dedup = {}
        self.cmd_dedup_window = 3.0
        _lg.info("[YUDEBG] 插件 v12 已实例化（防封控版）")

    # ---------- 节流 ----------
    def _prune(self):
        now = time.time()
        self.msg_times = [t for t in self.msg_times if now - t < 600]
        self.image_times = [t for t in self.image_times if now - t < 3600]

    def _can_speak(self) -> bool:
        self._prune()
        now = time.time()

        # 每 10 分钟上限
        if sum(1 for t in self.msg_times if now - t < 600) >= self.max_per_10min:
            return False
        # 每分钟上限
        if sum(1 for t in self.msg_times if now - t < 60) >= self.max_per_minute:
            return False

        # 连发控制：15 秒窗口内最多 3 条
        if now - self.burst_start > self.burst_window:
            self.burst_start = now
            self.burst_count = 0
        if self.burst_count >= self.max_burst:
            return False

        return True

    def _mark_speak(self):
        now = time.time()
        if now - self.burst_start > self.burst_window:
            self.burst_start = now
            self.burst_count = 0
        self.burst_count += 1
        self.msg_times.append(now)

    def _can_send_image(self) -> bool:
        self._prune()
        now = time.time()
        if sum(1 for t in self.image_times if now - t < 600) >= self.max_images_per_10min:
            return False
        if sum(1 for t in self.image_times if now - t < 3600) >= self.max_images_per_hour:
            return False
        return True

    def _mark_image(self):
        self.image_times.append(time.time())

    # ---------- 工具 ----------
    def _sender_id(self, event) -> str:
        try:
            sid = event.get_sender_id()
            if sid:
                return str(sid)
        except Exception:
            pass
        return ""

    POKE_LINES = [
        "讨厌…戳什么戳啦，人家会害羞的",
        "呜…再戳我就要生气了哦，真的会生气的！",
        "戳戳戳，你手指不累吗…哼，讨厌死了啦",
        "别戳啦别戳啦，再戳我就咬你！",
        "唔…这样戳人家，是不是有点过分了呀",
        "再戳…再戳我就哭给你看！真的那种！",
    ]

    POKE_PROMPT = (
        "有人戳了你一下（拍一拍）。用一句话回他：\n"
        "1. 语气是「讨厌可爱」——嘴上嫌弃、撒娇、别扭，不是真生气，也不是辱骂；\n"
        "2. 带点小脾气和小得意，像被戳了很委屈但又有点开心；\n"
        "3. 只输出一句话，不超过 30 个字，不加引号，不解释，不换行。"
    )

    async def _reply_poke(self, event, sid: str):
        """戳一戳的实际回复：私聊戳回去 + 文字，群聊只回文字。"""
        import random as _random

        line = ""
        try:
            provider = await self.context.get_using_provider_async(
                umo=event.unified_msg_origin
            )
            if provider is not None:
                resp = await provider.text_chat(prompt=self.POKE_PROMPT, contexts=[])
                line = resp if isinstance(resp, str) else (
                    getattr(resp, "completion_text", "") or ""
                )
                line = line.strip().strip('「」"\'“”').replace("\n", " ").strip()
        except Exception as e:
            _lg.warning(f"[YUWAKE] 戳一戳 AI 生成失败，用内置句: {e}")
        if not line:
            line = _random.choice(self.POKE_LINES)
        line = line[:60]

        # 戳回去：只有私聊可以，群里发 poke 会被平台拒绝（retcode=1400）
        if event.is_private_chat() and sid:
            try:
                await event.send(MessageChain(chain=[Poke(id=sid)]))
            except Exception as e:
                _lg.info(f"[YUWAKE] 私聊戳回去失败（继续发文字）: {e}")

        _lg.info(f"[YUWAKE] 被 {sid} 戳了，回: {line}")
        try:
            ok = await self.context.send_message(
                event.unified_msg_origin,
                MessageChain(chain=[Plain(text=line)]),
            )
            if ok is False:
                _lg.warning("[YUWAKE] 戳一戳文字 send_message 返回 False")
        except Exception as e:
            _lg.error(f"[YUWAKE] 戳一戳文字发送失败: {e}")

    def _poke_hit_me(self, event) -> bool:
        """判断这次 Poke 事件的目标是不是大肥鱼自己。

        OneBot v11 的 notice/poke 事件里，target_id 才是被戳的人；
        Poke 组件的 target_id() 不一定被适配器填上，所以两边都看。
        """
        me = str(event.get_self_id() or "").strip()
        # 1) 原始报文里的 target_id（最可靠）
        raw = getattr(event.message_obj, "raw_message", None)
        if isinstance(raw, dict):
            tgt = str(raw.get("target_id") or "").strip()
            if tgt:
                # 有些平台 target_id 是 QQ 号，有些是 uid
                if not me:
                    return True
                if tgt == me:
                    return True
                self_uid = str(raw.get("self_id") or "").strip()
                return bool(self_uid and tgt == self_uid)
        # 2) 退回到 Poke 组件
        try:
            for seg in event.get_messages():
                if isinstance(seg, Poke):
                    tid = seg.target_id()
                    if not tid:
                        return True
                    return str(tid) == me
        except Exception:
            pass
        return True

    def _has_at_bot(self, event) -> bool:
        try:
            for seg in event.get_messages():
                if isinstance(seg, At) and str(seg.qq) == str(event.get_self_id()):
                    return True
        except Exception:
            pass
        return False

    def _has_reply_bot(self, event) -> bool:
        try:
            for seg in event.get_messages():
                if isinstance(seg, Reply) and str(seg.sender_id) == str(event.get_self_id()):
                    return True
        except Exception:
            pass
        return False

    def _is_command(self, event) -> bool:
        """是不是指令消息（/xxx），指令必须放行给 AstrBot 处理"""
        msg = (event.message_str or "").strip()
        if msg.startswith("/") or msg.startswith("#"):
            return True
        return False

    # ===== 指令表（覆盖群里出现过的全部指令）=====
    CMD_MAP = {
        "sl": "notinstalled", "snowluma": "notinstalled",
        "napcat": "napcat", "nc": "napcat",
        "状态": "status", "status": "status",
        "白饭": "rice", "rice": "rice", "token": "rice",
        "余额": "rice", "额度": "rice",
        "help": "help", "帮助": "help", "指令": "help", "菜单": "help",
        "醒醒": "wake", "ping": "ping", "在吗": "ping",
        "群分析": "groupinfo", "groupinfo": "groupinfo",
        "reset": "reset", "重置": "reset",
        "ting": "sing", "唱歌": "sing",
        "qido": "unknown",
    }

    def _parse_cmd(self, event):
        msg = (event.message_str or "").strip()
        if not msg:
            return None, None

        has_prefix = msg[:1] in ("/", "#")
        body = msg[1:].strip() if has_prefix else msg.strip()

        # 去掉唤醒词前缀
        had_wake = False
        for kw in self.strong_keywords:
            if body.startswith(kw):
                body = body[len(kw):].strip()
                had_wake = True
                break

        if not body:
            return None, None

        # 没有 / # 前缀、也没有唤醒词 → 不当指令（避免普通聊天误触发）
        if not has_prefix and not had_wake:
            return None, None

        parts = body.split()
        if not parts:
            return None, None
        word = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""
        if word.startswith("zl-"):
            return "unknown", None
        return self.CMD_MAP.get(word), arg

    def _is_admin(self, event) -> bool:
        return self._sender_id(event) in self.owner_ids

    async def _handle_cmd(self, event, cmd, arg=""):
        import subprocess, json as _json

        def sh(c, t=8):
            try:
                return subprocess.run(c, shell=True, capture_output=True,
                                      text=True, timeout=t).stdout.strip()
            except Exception:
                return ""

        def onebot(action, payload=None):
            import urllib.request
            try:
                url = "http://snowluma:3000/" + action
                data = _json.dumps(payload or {}).encode()
                req = urllib.request.Request(url, data=data, method="POST")
                req.add_header("Content-Type", "application/json")
                req.add_header("Authorization", "Bearer fisher2026token")
                return _json.loads(urllib.request.urlopen(req, timeout=6).read())
            except Exception as e:
                return {"error": str(e)}

        def get_status():
            j = onebot("get_login_info")
            nick, uid = "掉线", "?"
            if j.get("status") == "ok":
                nick = j["data"].get("nickname", "?")
                uid = j["data"].get("user_id", "?")
            ver = onebot("get_version_info")
            app = "?"
            if ver.get("status") == "ok":
                app = ver["data"].get("app_version", "?")
            up = sh("cat /proc/uptime | cut -d' ' -f1")
            try:
                hours = round(float(up) / 3600, 1)
            except Exception:
                hours = "?"
            return nick, uid, app, hours

        if cmd == "notinstalled":
            await event.send(MessageChain().message("就是 SnowLuma 呀… 协议端现在就跑着它"))
            return

        if cmd == "status":
            nick, uid, app, hours = get_status()
            txt = "在呢… " + str(nick) + " | " + str(hours) + "h | 白饭够吃"
            await event.send(MessageChain().message(txt))
            return

        if cmd == "rice":
            # 数据源优先级：宿主机 cron 生成的 relay-usage.json（中转站真实账单）
            # > 容器内旧 usage.json（兜底）
            import json as _j2
            import time as _t2

            def _rj(paths):
                for p in paths:
                    try:
                        with open(p, encoding="utf-8") as f:
                            return _j2.load(f)
                    except Exception:
                        continue
                return None

            _relay = _rj(("/AstrBot/data/relay-usage.json",
                          os.environ.get("RELAY_USAGE_FILE", "/root/relay/relay-usage.json")))
            _legacy = _rj(("/AstrBot/data/usage.json",))

            days, chat_id, vis_id = {}, "", ""
            if isinstance(_relay, dict) and _relay.get("days"):
                days = _relay.get("days") or {}
                chat_id = str((_relay.get("chatMain") or {}).get("modelId") or "")
                vis_id = str((_relay.get("visionMain") or {}).get("modelId") or "")
                if (_relay.get("visionMain") or {}).get("enabled") is False:
                    vis_id = ""
            if not days and isinstance(_legacy, dict):
                days = _legacy.get("days") or {}

            if not days:
                await event.send(MessageChain().message("查不到账单…"))
                return

            _now = _t2.time()
            today_s = _t2.strftime("%Y-%m-%d", _t2.localtime(_now))
            yday_s = _t2.strftime("%Y-%m-%d", _t2.localtime(_now - 86400))
            if today_s in days:
                day_key, day_label = today_s, "今天"
            elif yday_s in days:
                day_key, day_label = yday_s, "昨天"
            else:
                day_key = sorted(days.keys())[-1]
                day_label = day_key[5:]

            d0 = days.get(day_key) or {}
            models = d0.get("models") or {}
            calls = int(d0.get("calls") or 0)
            errs = int(d0.get("errors") or 0)
            toks = int(d0.get("promptTokens") or 0) + int(d0.get("completionTokens") or 0)

            def _num(n):
                if n >= 100000000:
                    return format(n / 100000000.0, ".1f") + "亿"
                if n >= 10000:
                    s = format(n / 10000.0, ".1f")
                    return (s[:-2] if s.endswith(".0") else s) + "万"
                return str(n)

            def _hit(mid):
                if not mid:
                    return None
                for name, mv in models.items():
                    if name == mid or name.endswith("/" + mid):
                        return mv
                return None

            def _calls_of(mid):
                mv = _hit(mid)
                return int((mv or {}).get("calls") or 0)

            # 聊天主力：链头优先，链头今天没出手就挑非看图里用得最多的
            if not chat_id and models:
                chat_id = max(models.items(),
                              key=lambda kv: int((kv[1] or {}).get("calls") or 0))[0]
            if models and _calls_of(chat_id) == 0:
                _cand = []
                for n, mv in models.items():
                    if vis_id and (n == vis_id or n.endswith("/" + vis_id)):
                        continue
                    c = int((mv or {}).get("calls") or 0)
                    if c > 0:
                        _cand.append((n, c))
                if _cand:
                    chat_id = max(_cand, key=lambda x: x[1])[0]

            def _line(title, mid):
                short = (mid.split("/")[-1] if mid else "") or "?"
                n = _calls_of(mid)
                return title + short + (" ×" + str(n) if n else " · 待命")

            ms_total = 0
            for mv in models.values():
                try:
                    ms_total += int((mv or {}).get("ms") or 0)
                except Exception:
                    pass
            avg = (ms_total / calls / 1000.0) if calls else 0.0

            lines = ["白饭账单 · " + day_label,
                     "吃了 " + _num(toks) + " 粒 · 说话 " + str(calls) + " 次"]
            if chat_id:
                lines.append(_line("聊天主力 ", chat_id))
            if vis_id:
                lines.append(_line("看图主力 ", vis_id))
            tail = "出错 " + str(errs) + " 次"
            if calls:
                tail += " · 均速 " + format(avg, ".1f") + "s"
            lines.append(tail)

            await event.send(MessageChain().message("\n".join(lines[:6])))
            return

        if cmd == "groupinfo":
            if not self._is_admin(event):
                await event.send(MessageChain().message("管理命令仅管理员可用。"))
                return
            umo = event.unified_msg_origin or ""
            gid = ""
            for p in umo.split(":"):
                if p.isdigit():
                    gid = p
                    break
            if gid:
                info = onebot("get_group_info", {"group_id": int(gid)})
                cnt = onebot("get_group_member_count", {"group_id": int(gid)})
                name = info.get("data", {}).get("group_name", "?") if info.get("status") == "ok" else "?"
                num = cnt.get("data", {}).get("member_count", "?") if cnt.get("status") == "ok" else "?"
                txt = "群分析\n群名: " + str(name) + "\n人数: " + str(num) + "\n群号: " + str(gid)
            else:
                txt = "这里不是群…"
            await event.send(MessageChain().message(txt))
            return

        if cmd == "reset":
            if not self._is_admin(event):
                await event.send(MessageChain().message("管理命令仅管理员可用。"))
                return
            self._sessions.pop(event.unified_msg_origin, None)
            await event.send(MessageChain().message("对话清空了… 重新开始"))
            return

        if cmd == "sing":
            await event.send(MessageChain().message("唱歌还没装… 先欠着"))
            return

        if cmd == "help":
            txt = ("喊我名字就能聊…\n"
                   "#sl 看 SnowLuma 状态\n"
                   "#napcat 看 NapCat 信息\n"
                   "#白饭 看余额\n"
                   "#群分析 看本群信息\n"
                   "#醒醒 叫我起床")
            await event.send(MessageChain().message(txt))
            return

        if cmd == "wake":
            await event.send(MessageChain().message("醒着呢…"))
            return

        if cmd == "ping":
            await event.send(MessageChain().message("在…"))
            return

        if cmd == "unknown":
            await event.send(MessageChain().message("这指令我不认识…"))
            return

    def _has_keyword(self, event) -> bool:
        msg = event.message_str or ""
        return any(kw and kw in msg for kw in self.keywords)

    def _strong_hit(self, event) -> bool:
        msg = event.message_str or ""
        return any(kw in msg for kw in self.strong_keywords)

    def _weak_hit(self, event) -> bool:
        msg = event.message_str or ""
        if not any(kw in msg for kw in self.weak_keywords):
            return False
        # 「白饭」这种高频词，必须是疑问句/呼语才算在叫她
        if "白饭" in msg:
            return any(m in msg for m in self.call_markers)
        return True

    def _in_session(self, event) -> bool:
        return time.time() < self._sessions.get(event.unified_msg_origin, 0)

    def _refresh(self, event):
        self._sessions[event.unified_msg_origin] = time.time() + self.session_ttl

    def _get_profile(self, event):
        umo = event.unified_msg_origin or ""
        for part in umo.split(":"):
            if part.isdigit():
                return self.group_profiles.get(part, self.default_profile)
        return self.default_profile

    def _worth_joining(self, event) -> bool:
        msg = (event.message_str or "").strip()
        if len(msg) < 2:
            return False
        if not any(c.isalnum() or '\u4e00' <= c <= '\u9fff' for c in msg):
            return False
        if msg.lower() in self.skip_only:
            return False
        return True

    def _can_proactive(self, event) -> bool:
        rate, cooldown = self._get_profile(event)
        gid = event.unified_msg_origin
        now = time.time()
        if now - self._last_proactive.get(gid, 0) < cooldown:
            return False
        return random.random() < rate

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_all_message(self, event):
        sid = self._sender_id(event)
        msgs = event.get_messages()
        types = [type(m).__name__ for m in msgs]

        # ===== 戳一戳 =====
        # 只有「戳的是大肥鱼自己」才处理（别人互戳不插嘴）。
        # 处理 = 必回：自己调 LLM 生成一句，然后主动 send_message。
        # 不能靠 event.is_wake —— Poke 事件没有文本，框架的 wake 流程会跳过。
        if 'Poke' in types:
            event.stop_event()
            if not self._poke_hit_me(event):
                return
            me = str(event.get_self_id() or "")
            if sid and me and sid == me:
                return
            key = f"{event.unified_msg_origin}:{sid}"
            now = time.time()
            if now - self._last_poke.get(key, 0) < self.poke_cooldown:
                return
            self._last_poke[key] = now
            if not self._can_speak():
                return
            self._mark_speak()
            self._refresh(event)
            try:
                await self._reply_poke(event, sid)
            except Exception as e:
                _lg.error(f"[YUWAKE] 戳一戳回复失败: {e}")
            return

        # ===== 指令系统（最优先，私聊/主人也要先判断指令）=====
        cmd, arg = self._parse_cmd(event)
        if cmd:
            # 去重：同一消息 3 秒内只处理一次
            mid = getattr(event.message_obj, "message_id", None) or ""
            dkey = str(mid) + ":" + cmd
            now_d = time.time()
            if dkey and now_d - self._cmd_dedup.get(dkey, 0) < self.cmd_dedup_window:
                event.stop_event()
                return
            if dkey:
                self._cmd_dedup[dkey] = now_d
            await self._handle_cmd(event, cmd, arg)
            event.stop_event()
            return

        # ===== 私聊：必回（不节流）=====
        if event.is_private_chat():
            self._mark_speak()
            self._refresh(event)
            return

        # ===== 主人：必回（不节流）=====
        if sid in self.owner_ids:
            self._mark_speak()
            self._refresh(event)
            event.is_wake = True
            event.is_at_or_wake_command = True
            return

        # ===== 强触发：必回（不节流，被叫必须应）=====
        if self._strong_hit(event) or self._has_at_bot(event) or self._has_reply_bot(event):
            self._mark_speak()
            self._refresh(event)
            return

        # ===== 弱触发：按概率回（不节流）=====
        if self._weak_hit(event) and random.random() < self.weak_hit_rate:
            self._mark_speak()
            self._refresh(event)
            event.is_wake = True
            event.is_at_or_wake_command = True
            return

        # ===== 连续对话（不节流）=====
        if self._in_session(event):
            self._mark_speak()
            self._refresh(event)
            return

        # ===== 主动参与 =====
        if self._worth_joining(event) and self._can_proactive(event) and self._can_speak():
            self._last_proactive[event.unified_msg_origin] = time.time()
            self._mark_speak()
            self._refresh(event)
            event.is_wake = True
            event.is_at_or_wake_command = True
            return

        event.stop_event()

    # ===== 图片硬限制：超限就删图 =====
    @filter.on_decorating_result(priority=100001)
    async def guard_images(self, event):
        try:
            result = event.get_result()
            if not result:
                return
            chain = getattr(result, "chain", None)
            if not chain:
                return
            images = [c for c in chain if isinstance(c, Image)]
            if not images:
                return

            if not self._can_send_image():
                result.chain = [c for c in chain if not isinstance(c, Image)]
                _lg.warning(f"[YUDEGUARD] 图片超限，已拦截 {len(images)} 张")
            else:
                self._mark_image()
                _lg.info(f"[YUDEGUARD] 放行 {len(images)} 张图")
        except Exception as e:
            _lg.error(f"[YUDEGUARD] err={e}")
