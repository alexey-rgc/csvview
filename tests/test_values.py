"""JSON value rules and row conversion."""

from __future__ import annotations

from datetime import date, datetime, time
from decimal import Decimal

from csvview.values import convert_rows, to_json_value


def test_to_json_value_rules() -> None:
    assert to_json_value(2**53) == 2**53
    assert to_json_value(-(2**53) - 1) == str(-(2**53) - 1)
    assert to_json_value(float("inf")) == "Infinity"
    assert to_json_value(float("-inf")) == "-Infinity"
    assert to_json_value(float("nan")) == "NaN"
    assert to_json_value(Decimal("1.25")) == 1.25
    assert to_json_value(date(2024, 1, 2)) == "2024-01-02"
    assert to_json_value(datetime(2024, 1, 2, 3, 4)) == "2024-01-02T03:04:00"
    assert to_json_value(time(9, 30)) == "09:30:00"
    assert to_json_value(b"\x01\xff") == "01ff"
    assert to_json_value(True) is True
    assert to_json_value([1, 2]) == "[1, 2]"


def test_convert_rows_touches_only_listed_columns() -> None:
    rows = [(1, float("nan"), "a"), (2, None, "b")]
    assert convert_rows(rows, []) is rows
    assert convert_rows(rows, [(1, to_json_value)]) == [[1, "NaN", "a"], [2, None, "b"]]
