#!/usr/bin/env python3
"""Normalize provider JSON/JSONL at the engine adapter boundary."""

from __future__ import annotations

import json
import math
import sys
from typing import Any


def number(value: Any, *, integer: bool = False) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        valid = math.isfinite(value) and value >= 0
    except OverflowError:
        return None
    if not valid or (integer and int(value) != value):
        return None
    return int(value) if integer else value


def documents(raw: str) -> list[dict[str, Any]]:
    try:
        decoded = json.loads(raw)
        values = decoded if isinstance(decoded, list) else [decoded]
    except json.JSONDecodeError:
        values = []
        for row in raw.splitlines():
            try:
                values.append(json.loads(row))
            except json.JSONDecodeError:
                continue
    return [value for value in values if isinstance(value, dict)]


def usage_fields(item: dict[str, Any], engine: str) -> dict[str, Any]:
    usage = item.get("usage")
    source = usage if isinstance(usage, dict) else item
    incoming = number(source.get("input_tokens", source.get("prompt_tokens")), integer=True)
    outgoing = number(source.get("output_tokens", source.get("completion_tokens")), integer=True)
    # Claude input_tokens excludes cache buckets; Codex cached_input_tokens is
    # already included in input_tokens and must never be counted twice.
    if engine == "claude" and incoming is not None:
        for field in ("cache_creation_input_tokens", "cache_read_input_tokens"):
            if field in source:
                cached = number(source[field], integer=True)
                incoming = incoming + cached if cached is not None else None
                if incoming is None:
                    break
    total = number(source.get("total_tokens"), integer=True)
    if total is None and incoming is not None and outgoing is not None:
        total = incoming + outgoing
    cost = number(item.get("total_cost_usd", item.get("cost_usd", source.get("cost_usd"))))
    return {"input_tokens": incoming, "output_tokens": outgoing, "total_tokens": total, "cost_usd": cost}


def normalize(engine: str, raw: str) -> dict[str, Any]:
    items = documents(raw)
    result: dict[str, Any] = {
        "result": "", "status": "error", "subtype": "invalid_metadata",
        "type": f"{engine}_exec", "cost_usd": None,
        "input_tokens": None, "output_tokens": None, "total_tokens": None,
    }
    if engine == "codex":
        turns = [item for item in items if item.get("type") == "turn.completed"]
        failures = [item for item in items if item.get("type") == "turn.failed"]
        if turns:
            metrics = [usage_fields(item, engine) for item in turns]
            for field in ("cost_usd", "input_tokens", "output_tokens", "total_tokens"):
                values = [metric[field] for metric in metrics]
                result[field] = sum(values) if all(value is not None for value in values) else None
            result.update(status="success", subtype="success", type="turn.completed")
        if failures:
            result.update(status="error", subtype="turn.failed", type="turn.failed")
            error = failures[-1].get("error")
            result["result"] = str(error.get("message", "")) if isinstance(error, dict) else str(error or "")
        for item in items:
            message = item.get("item")
            if isinstance(message, dict) and message.get("type") == "agent_message":
                result["result"] = str(message.get("text", ""))
        return result

    candidates = [item for item in items if any(key in item for key in ("result", "usage", "status", "is_error", "subtype"))]
    if not candidates:
        return result
    item = candidates[-1]
    result.update(usage_fields(item, engine))
    status = item.get("status", "success")
    subtype = str(item.get("subtype") or status)
    if item.get("is_error") is True or subtype.startswith("error"):
        status = "error"
    result.update(
        status=status if isinstance(status, str) and status in {"success", "error", "timeout"} else "error",
        subtype=subtype, type=str(item.get("type") or f"{engine}_exec"),
    )
    message = item.get("result", item.get("message", item.get("output_text", "")))
    result["result"] = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
    return result


if __name__ == "__main__":
    metadata = normalize(sys.argv[1], sys.stdin.read())
    # NUL-delimited values preserve multiline results without shell evaluation.
    for key in ("result", "cost_usd", "input_tokens", "output_tokens", "total_tokens", "subtype", "type", "status"):
        value = metadata[key]
        sys.stdout.write(("" if value is None else str(value)).replace("\0", "") + "\0")
