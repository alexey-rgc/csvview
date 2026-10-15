"""Per-column filter expressions and global search, parsed into parameterised SQL fragments.

Grammar: `a | b` is OR, `a & b` is AND (binds tighter); an atom is `null`,
`!null`, `=v`, `!=v`, `>v` `>=v` `<v` `<=v`, `a..b` (number and date columns), `^v`, `v$`,
`/re/`, `!atom`, or plain text (contains; equals on a numeric column when it is a number).
Values are bound as `?` parameters; `Fragment.text` is the same SQL with literals inlined, for
display only.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time

INT_TYPES = frozenset({"TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT", "UINTEGER"})
WIDE_INT_TYPES = frozenset({"BIGINT", "HUGEINT", "UBIGINT", "UHUGEINT"})
FLOAT_TYPES = frozenset({"FLOAT", "DOUBLE", "REAL"})
NUMERIC_KINDS = frozenset({"int", "bigint", "float", "decimal"})
TEMPORAL_KINDS = frozenset({"date", "timestamp", "time"})

_NUMBER_RE = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")
_INT_RE = re.compile(r"[+-]?\d+")
_COMPARE_OPS = (">=", "<=", ">", "<")
# Every character DuckDB can print when it casts a value of the kind to VARCHAR.
_RENDER_CHARS = {
    "int": frozenset("0123456789-"),
    "bigint": frozenset("0123456789-"),
    "float": frozenset("0123456789.-+einfa"),
    "decimal": frozenset("0123456789.-"),
    "date": frozenset("0123456789-: ()bcinfty"),
    "timestamp": frozenset("0123456789-:. +()bcinfty"),
    "time": frozenset("0123456789:.+-"),
}
_BOOL_TEXTS = ("true", "false")


def column_kind(type_name: str) -> str:
    """Classify a DuckDB type string into the kind that drives filtering and JSON conversion."""
    t = type_name.upper().strip()
    if t.endswith("]") or t.startswith(("STRUCT", "MAP", "UNION")):
        return "other"
    if t in WIDE_INT_TYPES:
        return "bigint"
    if t in INT_TYPES:
        return "int"
    if t in FLOAT_TYPES:
        return "float"
    if t.startswith("DECIMAL"):
        return "decimal"
    if t == "DATE":
        return "date"
    if t.startswith("TIMESTAMP"):
        return "timestamp"
    if t.startswith("TIME"):
        return "time"
    if t == "BOOLEAN":
        return "bool"
    if t.startswith("VARCHAR"):
        return "text"
    if t == "BLOB":
        return "blob"
    return "other"


def quote_ident(name: str) -> str:
    """Quote an SQL identifier, doubling embedded quotes."""
    return '"' + name.replace('"', '""') + '"'


def sql_literal(value: object) -> str:
    """Render a bound value as a readable SQL literal."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, datetime):
        kind = "TIMESTAMPTZ" if value.tzinfo else "TIMESTAMP"
        return f"{kind} '{value.isoformat(sep=' ')}'"
    if isinstance(value, date):
        return f"DATE '{value.isoformat()}'"
    if isinstance(value, time):
        return f"TIME '{value.isoformat()}'"
    return "'" + str(value).replace("'", "''") + "'"


def value_expr(name: str, type_name: str) -> str:
    """The column as compared and sorted; NaN counts as NULL, the way it is displayed."""
    quoted = quote_ident(name)
    return f"nullif({quoted}, 'NaN'::DOUBLE)" if column_kind(type_name) == "float" else quoted


class FilterError(ValueError):
    """A malformed filter expression for one column."""

    def __init__(self, column: str, message: str) -> None:
        super().__init__(f"{column}: {message}")
        self.column = column


@dataclass(frozen=True)
class Fragment:
    """A boolean SQL expression with `?` parameters and a literal-inlined twin."""

    sql: str
    params: tuple
    text: str

    @classmethod
    def build(cls, pattern: str, column_sql: str, values: Sequence[object] = ()) -> Fragment:
        """Fill `{c}` with the column expression and `{0}`, `{1}`... with the values."""
        return cls(
            sql=pattern.format(*("?" for _ in values), c=column_sql),
            params=tuple(values),
            text=pattern.format(*(sql_literal(v) for v in values), c=column_sql),
        )

    @classmethod
    def join(cls, parts: Sequence[Fragment], op: str) -> Fragment:
        """Combine fragments with AND / OR."""
        if len(parts) == 1:
            return parts[0]
        sep = f" {op} "
        return cls(
            sql="(" + sep.join(p.sql for p in parts) + ")",
            params=tuple(v for p in parts for v in p.params),
            text="(" + sep.join(p.text for p in parts) + ")",
        )


@dataclass(frozen=True)
class _Column:
    name: str
    kind: str
    expr: str
    text_expr: str


def _split(expr: str, sep: str) -> list[str]:
    """Split on `sep`, leaving `/regex/` atoms intact; `\\|` and `\\&` are literal characters."""
    parts: list[str] = []
    buf: list[str] = []
    at_start = True
    i = 0
    while i < len(expr):
        ch = expr[i]
        if at_start and ch.isspace():
            buf.append(ch)
            i += 1
            continue
        if at_start:
            at_start = False
            start = i + 1 if ch == "!" and expr[i + 1 : i + 2] == "/" else i
            if expr[start : start + 1] == "/":
                end = _regex_end(expr, start)
                if end > 0:
                    buf.append(expr[i : end + 1])
                    i = end + 1
                    continue
        if ch == "\\" and expr[i + 1 : i + 2] in ("|", "&"):
            buf.append(expr[i : i + 2] if expr[i + 1] != sep else sep)
            i += 2
            continue
        if ch == sep:
            parts.append("".join(buf))
            buf = []
            at_start = True
        else:
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts


def _regex_end(expr: str, start: int) -> int:
    """Index of the closing `/` of a regex opened at `start`, or -1."""
    j = start + 1
    while j < len(expr):
        if expr[j] == "\\":
            j += 2
            continue
        if expr[j] == "/":
            return j
        j += 1
    return -1


def _number(raw: str) -> object | None:
    if _INT_RE.fullmatch(raw):
        return int(raw)
    if _NUMBER_RE.fullmatch(raw):
        return float(raw)
    return None


def _temporal(kind: str, raw: str) -> object | None:
    try:
        if kind == "date":
            return date.fromisoformat(raw)
        if kind == "time":
            return time.fromisoformat(raw)
        return datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
    except ValueError:
        return None


def _operand(col: _Column, raw: str, strict: bool) -> tuple[str, object]:
    """The (left-hand SQL, bound value) pair for comparing `col` with `raw`."""
    if col.kind in NUMERIC_KINDS:
        value = _number(raw)
        if value is None:
            raise FilterError(col.name, f'"{raw}" is not a number')
        return col.expr, value
    if col.kind in TEMPORAL_KINDS:
        value = _temporal(col.kind, raw)
        if value is not None:
            return col.expr, value
        if strict:
            raise FilterError(col.name, f'"{raw}" is not a valid {col.kind}')
    return col.text_expr, raw


def _text_match(col: _Column, body: str, starts: bool = False, ends: bool = False) -> Fragment:
    """Case-insensitive literal match (`%` and `_` are plain characters); faster than ILIKE."""
    fn = {(False, False): "contains", (True, False): "starts_with", (False, True): "ends_with"}
    pattern = "lower({c}) = {0}" if starts and ends else fn[(starts, ends)] + "(lower({c}), {0})"
    return Fragment.build(pattern, col.text_expr, [body.lower()])


def _empty_check(col: _Column, negate: bool) -> Fragment:
    if col.kind == "text":
        pattern = "({c} IS NOT NULL AND {c} <> '')" if negate else "({c} IS NULL OR {c} = '')"
    else:
        pattern = "{c} IS NOT NULL" if negate else "{c} IS NULL"
    return Fragment.build(pattern, col.expr)


def _atom(col: _Column, s: str) -> Fragment | None:
    """Parse one stripped atom; None when it has no value yet (e.g. a lone `>`)."""
    if not s:
        return None
    low = s.lower()
    if low in ("null", "!null"):
        return _empty_check(col, negate=low == "!null")
    if s.startswith("!="):
        raw = s[2:].strip()
        if not raw:
            return None
        lhs, value = _operand(col, raw, strict=False)
        return Fragment.build("({c} <> {0} OR {c} IS NULL)", lhs, [value])
    if s.startswith("!") and len(s) > 1:
        inner = _atom(col, s[1:].strip())
        if inner is None:
            return None
        tail = f") OR {col.expr} IS NULL)"
        return Fragment("(NOT (" + inner.sql + tail, inner.params, "(NOT (" + inner.text + tail)
    if s.startswith("="):
        raw = s[1:].strip()
        if not raw:
            return None
        lhs, value = _operand(col, raw, strict=False)
        return Fragment.build("{c} = {0}", lhs, [value])
    for op in _COMPARE_OPS:
        if s.startswith(op):
            raw = s[len(op) :].strip()
            if not raw:
                return None
            lhs, value = _operand(col, raw, strict=True)
            return Fragment.build("{c} " + op + " {0}", lhs, [value])
    if len(s) > 2 and s.startswith("/") and s.endswith("/"):
        return Fragment.build("regexp_matches({c}, {0})", col.text_expr, [s[1:-1]])
    if ".." in s and (col.kind in NUMERIC_KINDS or col.kind in TEMPORAL_KINDS):
        return _range(col, s)
    starts, ends = s.startswith("^"), len(s) > 1 and s.endswith("$")
    body = s[1 if starts else 0 : -1 if ends else None]
    if (starts or ends) and body:
        return _text_match(col, body, starts=starts, ends=ends)
    if col.kind in NUMERIC_KINDS:
        value = _number(s)
        if value is not None:
            return Fragment.build("{c} = {0}", col.expr, [value])
    return _text_match(col, s)


def _range(col: _Column, s: str) -> Fragment | None:
    lo_raw, hi_raw = (part.strip() for part in s.split("..", 1))
    lo = _operand(col, lo_raw, strict=True)[1] if lo_raw else None
    hi = _operand(col, hi_raw, strict=True)[1] if hi_raw else None
    if lo is not None and hi is not None:
        return Fragment.build("{c} BETWEEN {0} AND {1}", col.expr, [lo, hi])
    if lo is not None:
        return Fragment.build("{c} >= {0}", col.expr, [lo])
    if hi is not None:
        return Fragment.build("{c} <= {0}", col.expr, [hi])
    return None


def _make_column(name: str, type_name: str) -> _Column:
    kind = column_kind(type_name)
    quoted = quote_ident(name)
    text_expr = quoted if kind == "text" else f"CAST({quoted} AS VARCHAR)"
    return _Column(name=name, kind=kind, expr=value_expr(name, type_name), text_expr=text_expr)


def parse_filter(name: str, type_name: str, expr: str) -> Fragment | None:
    """Parse one column's filter expression; None when it is blank."""
    col = _make_column(name, type_name)
    groups: list[Fragment] = []
    for alternative in _split(expr, "|"):
        terms = [_atom(col, part.strip()) for part in _split(alternative, "&")]
        present = [t for t in terms if t is not None]
        if present:
            groups.append(Fragment.join(present, "AND"))
    return Fragment.join(groups, "OR") if groups else None


def _could_contain(kind: str, q_lower: str) -> bool:
    """False when no value of this kind, cast to text, can contain `q_lower`."""
    if kind == "bool":
        return any(q_lower in text for text in _BOOL_TEXTS)
    chars = _RENDER_CHARS.get(kind)
    return chars is None or chars.issuperset(q_lower)


def search_fragment(columns: Sequence[tuple[str, str]], query: str) -> Fragment | None:
    """Global search: any column's text contains `query`, case-insensitive.

    Columns whose text form cannot contain the query (letters in a number column) are skipped.
    """
    q = query.strip()
    if not q:
        return None
    cols = [_make_column(name, type_name) for name, type_name in columns]
    parts = [_text_match(col, q) for col in cols if _could_contain(col.kind, q.lower())]
    return Fragment.join(parts, "OR") if parts else Fragment("FALSE", (), "FALSE")
