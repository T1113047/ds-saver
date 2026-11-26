#!/usr/bin/env python3
"""Forecast the next-session injection and the current task's token usage.

Read-only DB access. Deterministic math; no model call.

Formulas
--------
C        = current context = input + cache.read + cache.write
R        = cumulative reasoning tokens
M        = assistant messages
G        = median of the last 10 per-message context deltas (clamped 500..50000)
N(t)     = max(0, (t - C) / G)          turns until context reaches t
P_next   = P_base + H_doc + D_task      next session first prompt
U_next   = U_base + H_doc + D_task      next session uncached input
Cost_next= (U_next*p_in + Cache_base*p_cache + O_base*p_out) / 1e6
Carry    = (C*p_cache + U_avg*p_in) / 1e6   cost of one more turn in this session
Payback  = (H_doc*p_out + Cost_next) / Carry

Prices (DS official, RMB per 1M): p_in=1, p_cache=0.02, p_out=4.
Base constants come from 100 DS first requests (p50/p90).
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics

SOFT = 300_000
HANDOFF = 500_000
HARD = 650_000
ABS_MAX = 800_000

P_IN = 1.0
P_CACHE = 0.02
P_OUT = 4.0

# 100 DS first requests, 2026-11-26 snapshot
BASE = {
    "prompt_p50": 5418,
    "prompt_p90": 10053,
    "cache_p50": 4224,
    "cache_p90": 7296,
    "uncached_p50": 1214,
    "uncached_p90": 5013,
    "output_p50": 128,
    "output_p90": 239,
}


def context_of(tokens):
    cache = tokens.get("cache") or {}
    return (
        (tokens.get("input") or 0)
        + (cache.get("read") or 0)
        + (cache.get("write") or 0)
    )


def zone_for(context):
    if context < SOFT:
        return "green"
    if context < HANDOFF:
        return "yellow"
    if context < HARD:
        return "orange"
    if context < ABS_MAX:
        return "red"
    return "over"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--handoff-chars", type=int, default=1500)
    parser.add_argument("--task-data-tokens", type=int, default=0)
    parser.add_argument("--target", type=int, default=HANDOFF)
    parser.add_argument(
        "--calibration",
        default=os.path.expanduser(
            "~/.local/share/opencode/ds-saver/calibration/latest.json"
        ),
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("DS_SAVER_OPENCODE_DB")
        or os.path.expanduser("~/.local/share/opencode/opencode.db"),
    )
    args = parser.parse_args()

    cal = {}
    if args.calibration and os.path.exists(args.calibration):
        try:
            with open(args.calibration, "r", encoding="utf-8") as f:
                cal = json.load(f)
        except (OSError, json.JSONDecodeError):
            cal = {}
    base = {**BASE, **(cal.get("base") or {})}
    mult = float(cal.get("growth_multiplier") or 1.0)
    mult = max(0.5, min(2.0, mult))

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    rows = con.execute(
        "select data from session_message "
        "where session_id=? and type='assistant' order by time_created",
        (args.session,),
    ).fetchall()

    messages = []
    for (raw,) in rows:
        try:
            data = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if data.get("tokens"):
            messages.append(data)

    if not messages:
        raise SystemExit("no assistant messages with token usage for this session")

    contexts = [context_of(m["tokens"]) for m in messages]
    contexts = [c for c in contexts if c > 0]
    if not contexts:
        raise SystemExit("no positive context")

    C = contexts[-1]
    C0 = contexts[0]
    M = len(messages)
    R = sum((m["tokens"].get("reasoning") or 0) for m in messages)
    O = sum((m["tokens"].get("output") or 0) for m in messages)
    P_total = sum(contexts)
    cache_total = sum(
        (m["tokens"].get("cache") or {}).get("read") or 0 for m in messages
    )
    uncached_total = max(0, P_total - cache_total)
    U_avg = uncached_total / M if M else 0

    deltas = [
        b - a for a, b in zip(contexts, contexts[1:]) if b > a
    ]
    recent = deltas[-10:] if deltas else []
    if recent:
        ordered = sorted(recent)
        g25 = max(500, min(50_000, ordered[int(len(ordered) * 0.25)]))
        g50 = max(500, min(50_000, statistics.median(ordered)))
        g75 = max(500, min(50_000, ordered[min(len(ordered) - 1, int(len(ordered) * 0.75))]))
    else:
        g25 = g50 = g75 = max(500, min(50_000, (C - C0) / max(1, M - 1)))

    g25 = max(500, min(50_000, g25 * mult))
    g50 = max(500, min(50_000, g50 * mult))
    g75 = max(500, min(50_000, g75 * mult))

    def turns_range(target):
        if C >= target:
            return {"fast": 0, "mid": 0, "slow": 0, "reached": True}
        return {
            "fast": round((target - C) / g75, 1),
            "mid": round((target - C) / g50, 1),
            "slow": round((target - C) / g25, 1),
            "reached": False,
        }

    H_doc = max(0, args.handoff_chars / 2.5)
    D_task = max(0, args.task_data_tokens)

    def next_cost(prompt_base, cache_base, uncached_base, output_base):
        prompt = prompt_base + H_doc + D_task
        uncached = uncached_base + H_doc + D_task
        cost = (uncached * P_IN + cache_base * P_CACHE + output_base * P_OUT) / 1e6
        return {
            "prompt": round(prompt),
            "uncached": round(uncached),
            "cost_rmb": round(cost, 6),
            "cost_usd": round(cost / 7.2, 6),
        }

    next_p50 = next_cost(
        base["prompt_p50"], base["cache_p50"], base["uncached_p50"], base["output_p50"]
    )
    next_p90 = next_cost(
        base["prompt_p90"], base["cache_p90"], base["uncached_p90"], base["output_p90"]
    )

    carry_rmb = (C * P_CACHE) / 1e6
    full_turn_rmb = (C * P_CACHE + U_avg * P_IN) / 1e6
    handoff_rmb = (H_doc * P_OUT) / 1e6 + next_p50["cost_rmb"]
    payback = handoff_rmb / carry_rmb if carry_rmb > 0 else None

    zone = zone_for(C)
    h = turns_range(HANDOFF)
    if zone == "green":
        advice = f"继续；到 300K 前用 misc 筛工具输出（按中位约 {turns_range(SOFT)['mid']} 轮）"
    elif zone == "yellow":
        advice = (
            f"开始 misc 筛工具输出；到 500K 按中位约 {h['mid']} 轮"
            f"（区间 {h['fast']}–{h['slow']}），在自然断点 handoff"
        )
    elif zone == "orange":
        advice = f"尽快在自然断点 handoff；到 650K 按中位约 {turns_range(HARD)['mid']} 轮"
    elif zone == "red":
        advice = f"立即 handoff；到 800K 按中位约 {turns_range(ABS_MAX)['mid']} 轮"
    else:
        advice = "已超过 800K，立即 handoff"

    out = {
        "schema": 1,
        "session_hash": __import__("hashlib").sha256(args.session.encode()).hexdigest()[:12],
        "calibration": {
            "applied": bool(cal),
            "growth_multiplier": mult,
            "source": args.calibration if cal else None,
        },
        "context": round(C),
        "reasoning_total": round(R),
        "context_per_reasoning": round(C / R, 2) if R else None,
        "messages": M,
        "consumed": {
            "prompt_total": round(P_total),
            "cache_read_total": round(cache_total),
            "uncached_total": round(uncached_total),
            "output_total": round(O),
            "reasoning_total": round(R),
            "total_tokens": round(P_total + O + R),
            "avg_uncached_per_turn": round(U_avg),
        },
        "growth": {
            "tokens_per_turn": {"p25": round(g25), "p50": round(g50), "p75": round(g75)},
            "turns_to_soft_300k": turns_range(SOFT),
            "turns_to_handoff_500k": turns_range(HANDOFF),
            "turns_to_hard_650k": turns_range(HARD),
            "turns_to_max_800k": turns_range(ABS_MAX),
            "confidence": "turns are a rough band: historical turn MAE ~41-68, range coverage ~50%; first-request MAPE ~8.5%",
        },
        "next_session": {
            "handoff_tokens": round(H_doc),
            "task_data_tokens": round(D_task),
            "cache_hit_pct": 98.0,
            "p50": next_p50,
            "p90": next_p90,
        },
        "handoff": {
            "carry_cost_rmb_per_turn": round(carry_rmb, 6),
            "full_turn_cost_rmb_per_turn": round(full_turn_rmb, 6),
            "handoff_cost_rmb": round(handoff_rmb, 6),
            "payback_turns": round(payback, 2) if payback else None,
        },
        "zone": zone,
        "recommendation": advice,
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
