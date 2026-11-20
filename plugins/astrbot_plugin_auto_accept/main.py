"""自动通过好友申请 / 群邀请，并给通过的人发一句欢迎语。

Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
本文件为原创实现，无第三方代码。
"""
import time

from astrbot.api.all import *
from astrbot.api.event import filter as _fm
from astrbot.core.star.filter.event_message_type import EventMessageType
from astrbot.core.message.message_event_result import MessageChain
from astrbot.api.message_components import Plain

import logging
_lg = logging.getLogger("astrbot")

PLUGIN_NAME = "astrbot_plugin_auto_accept"


@register(PLUGIN_NAME, "dafeiyu", "自动通过好友申请与群邀请", "1.0.0")
class AutoAcceptPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        _lg.info(f"[{PLUGIN_NAME}] 已加载")

    async def _get_client(self):
        """拿到 aiocqhttp 的 CQHttp 客户端。"""
        try:
            mgr = self.context.platform_manager
            for inst in mgr.get_insts():
                getter = getattr(inst, "get_client", None)
                if callable(getter):
                    cli = getter()
                    if cli is not None:
                        return cli
        except Exception as e:
            _lg.warning(f"[{PLUGIN_NAME}] 取客户端失败: {e}")
        return None

    @_fm.event_message_type(EventMessageType.ALL)
    async def on_all(self, event):
        raw = getattr(event.message_obj, "raw_message", None)
        if not isinstance(raw, dict):
            return
        if raw.get("post_type") != "notice":
            return
        sub = str(raw.get("sub_type") or "")

        # 只有加好友 / 邀请加群才自动通过；leave、kick 等不动
        if sub not in ("add", "invite"):
            return

        flag = str(raw.get("flag") or "").strip()
        if not flag:
            _lg.warning(f"[{PLUGIN_NAME}] {sub} 事件没有 flag，跳过: {raw}")
            return

        cli = await self._get_client()
        if cli is None:
            _lg.warning(f"[{PLUGIN_NAME}] 没有可用客户端，无法通过 {sub}")
            return

        is_group = sub == "invite" or raw.get("request_type") == "group"
        try:
            if is_group:
                await cli.call_action("set_group_add_request", {
                    "flag": flag, "sub_type": sub, "approve": True,
                })
                _lg.info(f"[{PLUGIN_NAME}] 已通过群邀请 flag={flag[:24]}…")
            else:
                await cli.call_action("set_friend_add_request", {
                    "flag": flag, "approve": True,
                })
                uid = raw.get("user_id")
                _lg.info(f"[{PLUGIN_NAME}] 已通过好友申请 user={uid} flag={flag[:24]}…")
                # 给新好友发一句欢迎，顺便测试能不能私聊
                if uid:
                    try:
                        await self.context.send_message(
                            f"default:FriendMessage:{uid}",
                            MessageChain(chain=[Plain(
                                text="你好呀，我是维护不起的一只大肥鱼，请多指教。"
                            )]),
                        )
                    except Exception as e:
                        _lg.info(f"[{PLUGIN_NAME}] 欢迎语没发出去（不影响加好友）: {e}")
        except Exception as e:
            _lg.error(f"[{PLUGIN_NAME}] 通过 {sub} 失败: {e}")
