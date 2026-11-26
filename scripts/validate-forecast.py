#!/usr/bin/env python3
"""Validate ctx-forecast predictions against historical DS sessions.

Read-only DB access. No model call.

Checks:
1. first-request prompt prediction (constant p50 vs actual)
2. turns-to-threshold prediction (rolling growth vs actual crossing)
3. task-consumption identity (prompt + output + reasoning)
"""

from __future__ import annotations

import json
import os
import sqlite3
import statistics
from collections import defaultdict

TARGETS = [300_000, 500_000, 650_000]
BASE_PROMPT_P25 = 5255
BASE_PROMPT_P50 = 5418
BASE_PROMPT_P90 = 10053
MIN_CONTEXT = 50_000
MAX_GROWTH = 50_000


def context_of(tokens):
    cache = tokens.get("cache") or {}
    return (
        (tokens.get("input") or 0)
        + (cache.get("read") or 0)
        + (cache.get("write") or 0)
    )


def median(values):
    return statistics.median(values) if values else 0


def p90(values):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * 0.9))] if values else 0


def main():
    db = os.path.expanduser("~/.local/share/opencode/opencode.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    sessions = defaultdict(lambda: {"all": [], "ds": 0, "total": 0})
    for sid, raw in con.execute(
        "select session_id, data from session_message where type='assistant'"
    ):
        try:
            data = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        s = sessions[sid]
        s["all"].append(data)
        s["total"] += 1
        if (data.get("model") or {}).get("providerID") == "deepseek":
            s["ds"] += 1

    long_sessions = [
        s for s in sessions.values()
        if s["total"] >= 50 and s["ds"] / s["total"] >= 0.8
    ]
    ds_sessions = [
        s for s in sessions.values()
        if s["ds"] > 0
    ]

    # 1) first request
    first_prompts = []
    for s in ds_sessions:
        for data in s["all"]:
            if (data.get("model") or {}).get("providerID") != "deepseek":
                continue
            tokens = data.get("tokens") or {}
            if not tokens:
                continue
            prompt = context_of(tokens)
            if prompt > 0:
                first_prompts.append(prompt)
                break

    errors = [abs(x - BASE_PROMPT_P50) for x in first_prompts]
    pct = [abs(x - BASE_PROMPT_P50) / x * 100 for x in first_prompts]
    covered = sum(1 for x in first_prompts if BASE_PROMPT_P25 <= x <= BASE_PROMPT_P90)
    print("## first_request_prediction")
    print(f"n={len(first_prompts)} predicted_p50={BASE_PROMPT_P50}")
    print(f"actual p50/p90={median(first_prompts):.0f}/{p90(first_prompts):.0f}")
    print(f"MAE={median(errors):.0f} tokens  MAPE={median(pct):.1f}%")
    print(f"within p25-p90 range ({BASE_PROMPT_P25}-{BASE_PROMPT_P90}): "
          f"{covered}/{len(first_prompts)} = {covered / len(first_prompts) * 100:.1f}%")
    print()

    # 2) turns-to-threshold
    for target in TARGETS:
        abs_err = []
        rel_err = []
        within5 = 0
        within10 = 0
        range_cov = 0
        samples = 0
        for s in long_sessions:
            msgs = [
                m for m in s["all"]
                if (m.get("model") or {}).get("providerID") == "deepseek"
                and (m.get("tokens") or {})
            ]
            ctxs = [context_of(m["tokens"]) for m in msgs]
            ctxs = [c for c in ctxs if c > 0]
            if len(ctxs) < 20:
                continue
            deltas = [b - a for a, b in zip(ctxs, ctxs[1:]) if b > a]
            for i, c in enumerate(ctxs):
                if c < MIN_CONTEXT or c >= target:
                    continue
                history = [d for d in deltas[:i] if d > 0][-10:]
                if not history:
                    continue
                ordered = sorted(history)
                g25 = max(500, min(MAX_GROWTH, ordered[int(len(ordered) * 0.25)]))
                g50 = max(500, min(MAX_GROWTH, statistics.median(ordered)))
                g75 = max(500, min(MAX_GROWTH, ordered[min(len(ordered) - 1, int(len(ordered) * 0.75))]))
                predicted = (target - c) / g75
                fast = (target - c) / g75
                slow = (target - c) / g25
                actual = None
                for j in range(i + 1, len(ctxs)):
                    if ctxs[j] >= target:
                        actual = j - i
                        break
                if actual is None or actual <= 0:
                    continue
                samples += 1
                abs_err.append(abs(predicted - actual))
                rel_err.append(abs(predicted - actual) / actual * 100)
                if fast <= actual <= slow:
                    range_cov += 1
                if abs(predicted - actual) <= 5:
                    within5 += 1
                if abs(predicted - actual) <= 10:
                    within10 += 1
        if not samples:
            print(f"## turns_to_{target // 1000}k: no samples")
            continue
        print(f"## turns_to_{target // 1000}k")
        print(f"samples={samples}  point_estimator=growth_p75")
        print(f"MAE={median(abs_err):.1f} turns  p90={p90(abs_err):.1f} turns  "
              f"MAPE={median(rel_err):.1f}%")
        print(f"within ±5 turns={within5 / samples * 100:.1f}%  "
              f"within ±10 turns={within10 / samples * 100:.1f}%  "
              f"range(p25-p75 growth) coverage={range_cov / samples * 100:.1f}%")
        print()

    # 3) task consumption identity
    billed = []
    prompts = []
    for s in long_sessions:
        msgs = [
            m for m in s["all"]
            if (m.get("model") or {}).get("providerID") == "deepseek"
            and (m.get("tokens") or {})
        ]
        if not msgs:
            continue
        p = sum(context_of(m["tokens"]) for m in msgs)
        o = sum((m["tokens"].get("output") or 0) for m in msgs)
        r = sum((m["tokens"].get("reasoning") or 0) for m in msgs)
        prompts.append(p)
        billed.append(p + o + r)
    print("## task_consumption")
    print(f"sessions={len(billed)}")
    print(f"prompt_total p50/p90={median(prompts):.0f}/{p90(prompts):.0f}")
    print(f"total_tokens p50/p90={median(billed):.0f}/{p90(billed):.0f}")
    print("identity: total_tokens = prompt_total + output + reasoning (exact by construction)")


if __name__ == "__main__":
    main()
