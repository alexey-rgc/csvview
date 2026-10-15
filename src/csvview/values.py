"""JSON-safe values: browser-compatible representations of DuckDB results.

Ints outside +-2^53 become strings, NaN and +-inf become "NaN" / "Infinity" / "-Infinity",
Decimal becomes float, dates and times become ISO strings, bytes become hex, anything else
`str()`. Converters are chosen once per column kind, so only columns that need conversion
are touched.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import date
from datetime import time as dtime
from decimal import Decimal
from typing import Any, Callable

MAX_SAFE_INT = 2**53  # largest integer a JavaScript number holds exactly


def _safe_int(v: int) -> object:
    return v if -MAX_SAFE_INT <= v <= MAX_SAFE_INT else str(v)


def _finite(v: float) -> float | str:
    if math.isfinite(v):
        return v
    return "NaN" if math.isnan(v) else ("Infinity" if v > 0 else "-Infinity")


def _decimal(v: Decimal) -> float | str:
    return _finite(float(v))


def _iso(v: Any) -> str:
    return v.isoformat()


def _hex(v: Any) -> str:
    return bytes(v).hex()


def to_json_value(v: Any) -> Any:
    """Convert any DuckDB-returned value to a JSON-safe value."""
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, int):
        return _safe_int(v)
    if isinstance(v, float):
        return _finite(v)
    if isinstance(v, Decimal):
        return _decimal(v)
    if isinstance(v, (date, dtime)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return _hex(v)
    return str(v)


KIND_CONVERTERS: dict[str, Callable[[Any], Any]] = {
    "bigint": _safe_int,
    "float": _finite,
    "decimal": _decimal,
    "date": _iso,
    "timestamp": _iso,
    "time": _iso,
    "blob": _hex,
    "other": to_json_value,
}


def convert_rows(rows: list[tuple], converters: Sequence[tuple[int, Callable]]) -> list:
    """Apply per-column converters; rows of columns that need none pass through untouched."""
    if not converters:
        return rows
    out = []
    for row in rows:
        values = list(row)
        for i, fn in converters:
            v = values[i]
            if v is not None:
                values[i] = fn(v)
        out.append(values)
    return out
