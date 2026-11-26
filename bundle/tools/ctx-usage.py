#!/usr/bin/env python3
"""查看当前 OpenCode 会话的上下文占用与成本。

用法：
    python3 ctx-usage.py                # 读 $OPENCODE_SESSION_ID
    python3 ctx-usage.py ses_xxx        # 指定会话
    python3 ctx-usage.py --json         # 机器可读
    python3 ctx-usage.py --window 200000  # 覆盖模型窗口

口径：上下文 = 上一条有效 assistant 请求的 input + cache.read + cache.write
      + output + reasoning（与 OpenCode 侧边栏百分比一致）。
数据源：~/.local/share/opencode/opencode.db（只读打开，不写库）。
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

_HOME = Path.home()
DB = Path(os.environ.get("DS_SAVER_OPENCODE_DB") or _HOME / ".local/share/opencode/opencode.db")
MODELS = Path(os.environ.get("DS_SAVER_MODELS_JSON") or _HOME / ".cache/opencode/models.json")
CONFIG = Path(os.environ.get("DS_SAVER_OPENCODE_CONFIG") or _HOME / ".config/opencode/opencode.jsonc")

REMIND = 300_000
URGENT = 500_000
AUTO_BUFFER = 0.15  # OpenCode 默认 buffer：留 15% 不填


def fmt(n: float) -> str:
    return f"{n / 1000:.1f}K" if n < 1_000_000 else f"{n / 1_000_000:.2f}M"


def _strip_jsonc(s: str) -> str:
    s = re.sub(r"^\s*//.*$", "", s, flags=re.M)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return s


def auto_ceiling(window: int) -> tuple[int, str]:
    """按配置里的 compaction.buffer 算自动压缩阈值；读不到则用默认 15%。"""
    fixed = int(window * (1 - AUTO_BUFFER))
    try:
        cfg = json.loads(_strip_jsonc(CONFIG.read_text()))
    except Exception:
        return fixed, "默认 15%"
    buf = (cfg.get("compaction") or {}).get("buffer")
    if isinstance(buf, str) and buf.endswith("%"):
        pct = float(buf[:-1])
        if 0 < pct < 100:
            return int(window * (1 - pct / 100)), f"config {buf}"
    if isinstance(buf, (int, float)) and 0 < buf < window:
        return int(window - buf), f"config {int(buf)} tokens"
    return fixed, "默认 15%"


def window_for(provider: str, model: str) -> int:
    try:
        data = json.loads(MODELS.read_text())
        limit = data.get(provider, {}).get("models", {}).get(model, {}).get("limit", {})
        ctx = limit.get("context") or 0
        if ctx > 0:
            return int(ctx)
    except Exception:
        pass
    return 1_048_576


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("session", nargs="?")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--window", type=int)
    ap.add_argument("--db", type=Path, default=DB, help="OpenCode 会话库路径")
    args = ap.parse_args()

    db = args.db
    if not db.exists():
        print(f"找不到数据库：{db}", file=sys.stderr)
        print("提示：ctx_status 只支持 OpenCode；可用 --db 或 DS_SAVER_OPENCODE_DB 指定路径。", file=sys.stderr)
        return 1

    sid = args.session or os.environ.get("OPENCODE_SESSION_ID")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    if not sid:
        row = con.execute(
            "select id from session_v2 order by time_updated desc limit 1"
        ).fetchone()
        if not row:
            print("数据库里没有会话", file=sys.stderr)
            return 1
        sid = row[0]

    s = con.execute(
        "select title, cost, tokens_cache_read, tokens_input, tokens_output "
        "from session_v2 where id=?",
        (sid,),
    ).fetchone()
    if not s:
        print(f"找不到会话：{sid}", file=sys.stderr)
        return 1
    title, cost, tot_cr, tot_in, tot_out = s

    msgs = con.execute(
        "select data from session_message where session_id=? and type='assistant' "
        "order by time_created desc limit 20",
        (sid,),
    ).fetchall()

    last = None
    for (raw,) in msgs:
        try:
            j = json.loads(raw)
        except Exception:
            continue
        tk = j.get("tokens") or {}
        if tk.get("input") or (tk.get("cache") or {}).get("read"):
            last = j
            break

    if not last:
        print(f"{title}（{sid}）：还没有可计量的请求", file=sys.stderr)
        return 1

    tk = last["tokens"]
    cr = (tk.get("cache") or {}).get("read", 0) or 0
    cw = (tk.get("cache") or {}).get("write", 0) or 0
    mi = tk.get("input", 0) or 0
    out = tk.get("output", 0) or 0
    rs = tk.get("reasoning", 0) or 0

    prompt = mi + cr + cw
    used = prompt + out + rs
    model = last.get("model") or {}
    window = args.window or window_for(
        model.get("providerID", ""), model.get("id", "")
    )
    pct = used / window * 100
    auto_at, auto_label = auto_ceiling(window)

    if used >= URGENT:
        level, advice = "紧张", "先 /compact 或开新会话，不要再接新任务"
    elif used >= REMIND:
        level, advice = "提醒", "在自然断点 /compact，或开新会话继续"
    else:
        level, advice = "正常", "可继续"

    if args.json:
        print(
            json.dumps(
                {
                    "session": sid,
                    "title": title,
                    "context": used,
                    "prompt": prompt,
                    "cache_read": cr,
                    "cache_write": cw,
                    "uncached_input": mi,
                    "output": out,
                    "reasoning": rs,
                    "window": window,
                    "percent": round(pct, 2),
                    "level": level,
                    "cost": cost,
                    "auto_compact_at": auto_at,
                    "auto_compact_source": auto_label,
                },
                ensure_ascii=False,
            )
        )
        return 0

    print(f"会话：{title}（{sid[-6:]}）")
    print(
        f"上下文：{fmt(used)} / {fmt(window)}（{pct:.1f}%）  [{level}] {advice}"
    )
    print(
        f"  上一请求：输入 {fmt(prompt)}（命中 {fmt(cr)} / 未命中 {fmt(mi)}）"
        f" + 输出 {fmt(out)} + 推理 {fmt(rs)}"
    )
    print(
        f"累计：命中 {fmt(tot_cr)} / 未命中 {fmt(tot_in)} / 输出 {fmt(tot_out)}"
        f" / ${cost:.4f}"
    )
    print(
        f"阈值：{fmt(REMIND)} 提醒 · {fmt(URGENT)} 先压缩 · "
        f"{fmt(auto_at)} 自动压缩（{auto_label}）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
