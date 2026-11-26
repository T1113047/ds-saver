#!/usr/bin/env python3
"""Emit one anonymized metrics record for an OpenCode session.

Read-only DB access. Output contains no prompts, message text, file paths,
session titles, IPs or API keys. The session id is hashed.

Usage:
    python3 scripts/session-metrics.py --session ses_xxx
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import statistics

SOFT = 300_000
HANDOFF = 500_000
HARD = 650_000
ABS_MAX = 800_000


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
    parser.add_argument(
        "--db",
        default=os.path.expanduser("~/.local/share/opencode/opencode.db"),
    )
    args = parser.parse_args()

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

    last = messages[-1]
    tokens = last["tokens"]
    context = context_of(tokens)
    reasoning_total = sum(
        (m["tokens"].get("reasoning") or 0) for m in messages
    )
    cost = sum(m.get("cost") or 0 for m in messages)
    model = last.get("model") or {}
    provider = model.get("providerID")
    model_id = model.get("id")

    parts = con.execute(
        "select type, sum(length(data)) from session_part "
        "where session_id=? group by type",
        (args.session,),
    ).fetchall()
    total_bytes = sum(v or 0 for _, v in parts)
    composition = None
    if total_bytes:
        composition = {
            k: round((v or 0) / total_bytes * 100, 1)
            for k, v in parts
            if k in ("tool", "reasoning", "text")
        }

    ratio = round(context / reasoning_total, 2) if reasoning_total else None
    is_ds = provider == "deepseek"
    record = {
        "schema": 1,
        "session_hash": hashlib.sha256(args.session.encode()).hexdigest()[:12],
        "model": f"{provider}/{model_id}" if provider and model_id else None,
        "profile": "deepseek" if is_ds else "default",
        "window": 1_048_576 if is_ds else None,
        "messages": len(messages),
        "context": context,
        "reasoning_total": reasoning_total,
        "context_per_reasoning": ratio,
        "composition_pct": composition,
        "policy_zone": zone_for(context) if is_ds else None,
        "cost_usd": round(cost, 6),
    }
    print(json.dumps(record, ensure_ascii=False))


if __name__ == "__main__":
    main()
