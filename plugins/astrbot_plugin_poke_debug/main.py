"""事件调试插件 —— 把收到的每条事件的结构打到日志里。

Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
本文件为原创实现，无第三方代码。
"""
from astrbot.api.all import *
from astrbot.api.event import filter as _fm
from astrbot.core.star.filter.event_message_type import EventMessageType

import logging
_lg = logging.getLogger("astrbot")

@register(
    "astrbot_plugin_poke_debug",
    "dafeiyu",
    "调试所有事件 v5",
    "5.0.0",
)
class PokeDebugPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        _lg.info("[DBG5] 插件已实例化")

    @_fm.event_message_type(EventMessageType.ALL)
    async def on_all(self, event):
        try:
            msgs = event.get_messages()
            types = [type(m).__name__ for m in msgs]
            raw = getattr(event.message_obj, 'raw_message', None)
            raw_t = ''
            if isinstance(raw, dict):
                raw_t = f"{raw.get('post_type','')}/{raw.get('sub_type','')}"
            _lg.info(
                f"[DBG5] types={types} text={(event.message_str or '')[:30]!r} raw={raw_t} "
                f"self={event.get_self_id()} sender={event.get_sender_id()}"
            )
        except Exception as e:
            try:
                _lg.error(f"[DBG5] err={e}")
            except Exception:
                pass
