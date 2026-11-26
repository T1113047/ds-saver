#!/usr/bin/env python3
"""Reproduce the DeepSeek context measurements used by ds-saver.

Read-only: opens the OpenCode SQLite DB with mode=ro.
Aggregates only: prints no session titles, message text, IPs or keys.

Usage:
    python3 scripts/measure-context.py
    python3 scripts/measure-context.py --db ~/.local/share/opencode/opencode.db
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
from collections import defaultdict

BINS = [
    (0, 50), (50, 100), (100, 150), (150, 200), (200, 250), (250, 300),
    (300, 400), (400, 500), (500, 600), (600, 700), (700, 800), (800, 1200),
]


def med(values):
    return statistics.median(values) if values else 0


def quantiles(values, points=(0.5, 0.75, 0.9, 0.95)):
    values = sorted(values)
    if not values:
        return [0 for _ in points]
    return [values[min(len(values) - 1, int(len(values) * p))] for p in points]


def tokens_of(data):
    return data.get("tokens") or {}


def context_of(tokens):
    cache = tokens.get("cache") or {}
    return (
        (tokens.get("input") or 0)
        + (cache.get("read") or 0)
        + (cache.get("write") or 0)
    )


def is_ds(data):
    return (data.get("model") or {}).get("providerID") == "deepseek"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--db",
        default=os.path.expanduser("~/.local/share/opencode/opencode.db"),
    )
    args = parser.parse_args()

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    sessions = defaultdict(lambda: {"msgs": [], "total": 0, "ds": 0})
    bins = {
        b: {"n": 0, "tool": 0, "terr": 0, "aerr": 0, "retry": 0,
            "out": [], "rea": [], "dur": [], "cost": 0.0, "length": 0,
            "cache": 0, "ctx": 0}
        for b in BINS
    }

    for sid, raw in con.execute(
        "select session_id, data from session_message where type='assistant'"
    ):
        try:
            data = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue

        session = sessions[sid]
        session["total"] += 1

        if not is_ds(data):
            continue
        tokens = tokens_of(data)
        if not tokens:
            continue

        ctx = context_of(tokens)
        if ctx <= 0:
            continue

        session["msgs"].append(data)
        session["ds"] += 1

        key = next((b for b in BINS if b[0] <= ctx / 1000 < b[1]), None)
        if key:
            agg = bins[key]
            agg["n"] += 1
            agg["ctx"] += ctx
            agg["cache"] += (tokens.get("cache") or {}).get("read") or 0
            agg["cost"] += data.get("cost") or 0
            agg["out"].append(tokens.get("output") or 0)
            agg["rea"].append(tokens.get("reasoning") or 0)
            if data.get("error"):
                agg["aerr"] += 1
            if data.get("retry"):
                agg["retry"] += 1
            if data.get("finish") == "length":
                agg["length"] += 1
            t = data.get("time") or {}
            if t.get("created") and t.get("completed"):
                agg["dur"].append(t["completed"] - t["created"])
            for part in data.get("content") or []:
                if part.get("type") != "tool":
                    continue
                agg["tool"] += 1
                if (part.get("state") or {}).get("status") == "error":
                    agg["terr"] += 1

    long_sessions = [
        s for s in sessions.values()
        if s["total"] >= 50 and s["ds"] / s["total"] >= 0.8
    ]

    # Composition from session_part (bytes), only long sessions
    comp = {"tool": [], "reasoning": [], "text": []}
    for sid, s in sessions.items():
        if s["total"] < 50 or s["ds"] / s["total"] < 0.8:
            continue
        rows = con.execute(
            "select type, sum(length(data)) from session_part "
            "where session_id=? group by type",
            (sid,),
        ).fetchall()
        total = sum(v or 0 for _, v in rows)
        if not total:
            continue
        shares = {k: (v or 0) / total * 100 for k, v in rows}
        for key in comp:
            if key in shares:
                comp[key].append(shares[key])

    print("## coverage")
    print(f"ds_assistant_messages: {sum(b['n'] for b in bins.values())}")
    print(f"ds_long_sessions: {len(long_sessions)}")
    print(f"composition_sessions: {len(comp['tool'])}")
    print()

    print("## composition (bytes, p25/p50/p75)")
    for key in ("tool", "reasoning", "text"):
        q = quantiles(comp[key], (0.25, 0.5, 0.75))
        print(f"{key}: {q[0]:.1f}% / {q[1]:.1f}% / {q[2]:.1f}%")
    print()

    ratios = []
    for s in long_sessions:
        reasoning = sum((tokens_of(m).get("reasoning") or 0) for m in s["msgs"])
        if reasoning > 0:
            ratios.append(context_of(tokens_of(s["msgs"][-1])) / reasoning)
    q = quantiles(ratios, (0.25, 0.5, 0.75))
    print("## context / reasoning")
    print(f"p25={q[0]:.2f}  p50={q[1]:.2f}  p75={q[2]:.2f}")
    if q[1]:
        print(f"reasoning share p50: {100 / q[1]:.1f}%")
    print()

    # First request per session: cold-start injection cost
    first_prompt = []
    first_cache = []
    first_uncached = []
    first_output = []
    first_cost = []
    first_cold = []
    first_hit = 0
    for s in sessions.values():
        if not s["msgs"]:
            continue
        data = s["msgs"][0]
        tokens = tokens_of(data)
        cache = tokens.get("cache") or {}
        cache_read = cache.get("read") or 0
        cache_write = cache.get("write") or 0
        uncached = tokens.get("input") or 0
        output = tokens.get("output") or 0
        reasoning = tokens.get("reasoning") or 0
        prompt = uncached + cache_read + cache_write
        if prompt <= 0:
            continue
        first_prompt.append(prompt)
        first_cache.append(cache_read + cache_write)
        first_uncached.append(uncached)
        first_output.append(output)
        first_cost.append(data.get("cost") or 0)
        first_cold.append((prompt * 0.15 + output * 0.6 + reasoning * 0.6) / 1e6)
        if cache_read + cache_write > 0:
            first_hit += 1

    qp = quantiles(first_prompt, (0.25, 0.5, 0.75, 0.9))
    qc = quantiles(first_cache, (0.25, 0.5, 0.75, 0.9))
    qu = quantiles(first_uncached, (0.25, 0.5, 0.75, 0.9))
    qo = quantiles(first_output, (0.25, 0.5, 0.75, 0.9))
    qa = quantiles(first_cost, (0.25, 0.5, 0.75, 0.9))
    qcold = quantiles(first_cold, (0.25, 0.5, 0.75, 0.9))
    print("## first_request (new session injection)")
    print(f"sessions={len(first_prompt)} cache_hit_pct={first_hit / len(first_prompt) * 100:.1f}%")
    print(f"prompt p25/50/75/90: {[round(x) for x in qp]}")
    print(f"cache_read p25/50/75/90: {[round(x) for x in qc]}")
    print(f"uncached_input p25/50/75/90: {[round(x) for x in qu]}")
    print(f"output p25/50/75/90: {[round(x) for x in qo]}")
    print(f"actual_cost_usd p25/50/75/90: {[round(x, 6) for x in qa]}")
    print(f"cold_cost_usd p25/50/75/90: {[round(x, 6) for x in qcold]}")
    print()

    print("## bins")
    print("ctx_bin,n,tool_err,a_err,retry,out_med,rea_med,dur_med,len%,$/msg,cache%")
    for b, a in bins.items():
        if a["n"] < 20:
            continue
        tool_err = a["terr"] / a["tool"] * 100 if a["tool"] else 0
        print(
            f"{b[0]}-{b[1]}K,{a['n']},{tool_err:.1f}%,"
            f"{a['aerr'] / a['n'] * 100:.1f}%,{a['retry'] / a['n'] * 100:.1f}%,"
            f"{med(a['out']):.0f},{med(a['rea']):.0f},{med(a['dur']):.0f},"
            f"{a['length'] / a['n'] * 100:.1f}%,{a['cost'] / a['n']:.4f},"
            f"{a['cache'] / a['ctx'] * 100:.1f}%"
        )
    print()

    # Within-session early/late
    def stats(msgs):
        tool = terr = aerr = 0
        out, rea, dur = [], [], []
        for data in msgs:
            tokens = tokens_of(data)
            out.append(tokens.get("output") or 0)
            rea.append(tokens.get("reasoning") or 0)
            if data.get("error"):
                aerr += 1
            t = data.get("time") or {}
            if t.get("created") and t.get("completed"):
                dur.append(t["completed"] - t["created"])
            for part in data.get("content") or []:
                if part.get("type") == "tool":
                    tool += 1
                    if (part.get("state") or {}).get("status") == "error":
                        terr += 1
        return {
            "tool": tool, "terr": terr, "aerr": aerr,
            "out": med(out), "rea": med(rea), "dur": med(dur),
            "n": len(msgs),
        }

    early = defaultdict(list)
    late = defaultdict(list)
    for s in long_sessions:
        msgs = s["msgs"]
        if len(msgs) < 20:
            continue
        half = len(msgs) // 2
        e = stats(msgs[:half])
        l = stats(msgs[half:])
        for key in ("out", "rea", "dur"):
            early[key].append(e[key])
            late[key].append(l[key])
        early["toolErr"].append(e["terr"] / e["tool"] if e["tool"] else 0)
        late["toolErr"].append(l["terr"] / l["tool"] if l["tool"] else 0)
        early["aErr"].append(e["aerr"] / e["n"])
        late["aErr"].append(l["aerr"] / l["n"])
        early["toolsPerMsg"].append(e["tool"] / e["n"])
        late["toolsPerMsg"].append(l["tool"] / l["n"])

    print("## early_vs_late (median)")
    for key in ("toolErr", "aErr", "out", "rea", "dur", "toolsPerMsg"):
        print(
            f"{key}: {med(early[key]):.3f} -> {med(late[key]):.3f} "
            f"(delta {med([l - e for e, l in zip(early[key], late[key])]):+.3f})"
        )
    print()

    finals = []
    for s in long_sessions:
        for data in reversed(s["msgs"]):
            tokens = tokens_of(data)
            if tokens.get("input") or (tokens.get("cache") or {}).get("read"):
                finals.append(context_of(tokens))
                break
    q = quantiles(finals)
    print("## final_context")
    print(f"p50={q[0]:.0f} p75={q[1]:.0f} p90={q[2]:.0f} p95={q[3]:.0f}")
    for threshold in (300_000, 400_000, 500_000, 600_000, 700_000, 800_000):
        over = sum(1 for x in finals if x >= threshold)
        print(f">={threshold // 1000}K: {over}/{len(finals)} = {over / len(finals) * 100:.1f}%")
    print()

    print("## cost_latency")
    for b in [(0, 50), (100, 150), (300, 400), (500, 600), (800, 1200)]:
        a = bins[b]
        print(
            f"{b[0]}-{b[1]}K: ${a['cost'] / a['n']:.4f}/msg, "
            f"{med(a['dur']):.0f}ms"
        )


if __name__ == "__main__":
    main()
