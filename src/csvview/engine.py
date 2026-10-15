"""DuckDB engine: loaded tables, query results, materialised views, pages, column stats, export.

One in-memory database; every public call works on its own cursor. Query results (`_cv.qN`) and
filtered/sorted views (`_cv.v<hash>`) are tables in schema `_cv`, bounded by LRUs; evicted ones
are dropped. Rows leave JSON-ready via `values`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import duckdb

from .filters import (
    NUMERIC_KINDS,
    FilterError,
    Fragment,
    column_kind,
    parse_filter,
    quote_ident,
    search_fragment,
    sql_literal,
    value_expr,
)
from .values import KIND_CONVERTERS, convert_rows, to_json_value

VIEW_CACHE_SIZE = 24
RESULT_CACHE_SIZE = 16
MAX_PAGE = 2000
DEFAULT_PAGE = 200
TOP_VALUES = 50
SNIFF_SAMPLE_ROWS = 20480  # sniffing the whole file (sample_size=-1) is slow on big files
_READ_ONLY_START = re.compile(
    r"^\s*(select|with|from|values|show|describe|summarize|explain|pragma|table)\b", re.I
)
_COMPRESSION_SUFFIXES = (".gz", ".zst", ".bz2")


class EngineError(Exception):
    """A request the engine cannot serve; `status` is the HTTP status to answer with."""

    status = 400


class NotFoundError(EngineError):
    """Unknown or evicted table, view, result or column."""

    status = 404


def table_name(filename: str) -> str:
    """File stem, lowercased, non-alphanumerics to `_`, prefixed `t_` if it starts with a digit."""
    base = Path(filename).name
    for suffix in _COMPRESSION_SUFFIXES:
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)]
    stem = Path(base).stem or base
    name = re.sub(r"[^0-9a-z]", "_", stem.lower()) or "table"
    return "t_" + name if name[0].isdigit() else name


@dataclass(frozen=True)
class Column:
    """One column of a table or view."""

    name: str
    type: str

    def as_dict(self) -> dict:
        return {"name": self.name, "type": self.type}


@dataclass(frozen=True)
class View:
    """A source with filters, search and sort applied; `relation` is what pages read from."""

    id: str
    source: str
    relation: str
    owned: bool
    total: int
    columns: list[Column]
    sql: str
    converters: list[tuple[int, Callable]]


class Engine:
    """The in-memory database plus the view and query-result caches."""

    def __init__(self) -> None:
        self._con = duckdb.connect(":memory:")
        self._con.execute("CREATE SCHEMA _cv")
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._files: dict[str, str] = {}
        self._views: OrderedDict[str, View] = OrderedDict()
        self._building: dict[str, threading.Lock] = {}
        self._results: OrderedDict[str, int] = OrderedDict()
        self._result_seq = 0

    def load_csv(self, path: str, label: str | None = None) -> dict:
        """Load a CSV as a new table named after `label` (default: the path); returns its entry."""
        shown = label or str(path)
        literal = sql_literal(str(path))
        with self._load_lock, self._con.cursor() as cur:
            taken = {n.lower() for n in self._main_names(cur)}
            base = name = table_name(shown)
            n = 2
            while name in taken:
                name, n = f"{base}_{n}", n + 1
            create = f"CREATE TABLE {quote_ident(name)} AS SELECT * FROM read_csv({literal}, "
            try:
                cur.execute(create + f"auto_detect=true, sample_size={SNIFF_SAMPLE_ROWS})")
            except duckdb.Error:
                try:
                    cur.execute(create + "auto_detect=true, sample_size=-1)")
                except duckdb.Error as exc:
                    raise EngineError(f"Could not load {shown}: {exc}") from exc
            self._files[name] = shown
            return self._table_entries(cur, only=name)[0]

    def tables(self) -> list[dict]:
        """Every table and view in the main schema, in creation order."""
        with self._con.cursor() as cur:
            return self._table_entries(cur)

    def create_view(
        self,
        source: str,
        filters: dict | None = None,
        search: str = "",
        sort: list | None = None,
        limit: int = DEFAULT_PAGE,
    ) -> dict:
        """Materialise (or reuse) a view and return it with its first page.

        Filters and sort keys naming columns the source lacks are ignored.
        """
        started = time.perf_counter()
        with self._con.cursor() as cur:
            ref = self._source_ref(source)
            columns = self._describe(cur, ref, source)
            names = {c.name for c in columns}
            active = {
                col: expr
                for col, expr in sorted((filters or {}).items())
                if col in names and isinstance(expr, str) and expr.strip()
            }
            order = [
                (s["col"], "DESC" if str(s.get("dir", "asc")).lower() == "desc" else "ASC")
                for s in (sort or [])
                if isinstance(s, dict) and s.get("col") in names
            ]
            search = (search or "").strip()
            key = json.dumps([source, active, search, order])
            view_id = "v" + hashlib.sha1(key.encode()).hexdigest()[:16]
            view = self._cached(view_id)
            if view is None:
                with self._lock:
                    build_lock = self._building.setdefault(view_id, threading.Lock())
                with build_lock:
                    view = self._cached(view_id) or self._build(
                        cur, view_id, source, ref, columns, active, search, order
                    )
                with self._lock:
                    self._building.pop(view_id, None)
            rows = self._page(cur, view, 0, limit)
        return {
            "view": view.id,
            "total": view.total,
            "columns": [c.as_dict() for c in view.columns],
            "rows": rows,
            "sql": view.sql,
            "ms": _elapsed(started),
        }

    def rows(self, view_id: str, offset: int = 0, limit: int = DEFAULT_PAGE) -> dict:
        """One page of a view."""
        started = time.perf_counter()
        view = self._view(view_id)
        with self._con.cursor() as cur:
            rows = self._page(cur, view, offset, limit)
        return {"rows": rows, "offset": max(0, offset), "ms": _elapsed(started)}

    def run_query(self, sql: str) -> dict:
        """Run user SQL; a row-returning statement becomes query result `_cv.qN`."""
        started = time.perf_counter()
        with self._con.cursor() as cur:
            try:
                rel = cur.sql(sql)
            except duckdb.Error as exc:
                raise EngineError(str(exc)) from exc
            if not _READ_ONLY_START.match(sql) or ";" in sql.strip().rstrip(";"):
                self._drop_views(cur, lambda v: True)
            if rel is None:
                return {"kind": "statement", "message": "OK", "ms": _elapsed(started)}
            with self._lock:
                self._result_seq += 1
                n = self._result_seq
            name = f"_cv.q{n}"
            try:
                rel.create(name)
            except duckdb.Error as exc:
                raise EngineError(str(exc)) from exc
            self._remember_result(cur, name, n)
        return {"kind": "result", "source": name, "label": f"Query {n}", "ms": _elapsed(started)}

    def column_stats(self, view_id: str, name: str) -> dict:
        """Count, nulls, distinct, min, max, mean and top values of one column of a view."""
        view = self._view(view_id)
        column = next((c for c in view.columns if c.name == name), None)
        if column is None:
            raise NotFoundError(f"Unknown column: {name}")
        kind = column_kind(column.type)
        c = value_expr(name, column.type)
        bounds = "NULL, NULL" if kind == "other" else f"min({c}), max({c})"
        mean = f"avg({c})" if kind in NUMERIC_KINDS else "NULL"
        convert = KIND_CONVERTERS.get(kind, to_json_value)
        with self._con.cursor() as cur:
            try:
                count, present, distinct, lo, hi, avg = cur.execute(
                    f"SELECT count(*), count({c}), count(DISTINCT {c}), {bounds}, {mean} "
                    f"FROM {view.relation}"
                ).fetchone()
                top = cur.execute(
                    f"SELECT {c}, count(*) AS n FROM {view.relation} WHERE {c} IS NOT NULL "
                    f"GROUP BY 1 ORDER BY n DESC, 1 LIMIT {TOP_VALUES}"
                ).fetchall()
            except duckdb.CatalogException as exc:
                raise NotFoundError(f"View {view_id} is gone") from exc
        return {
            "name": name,
            "type": column.type,
            "count": count,
            "nulls": count - present,
            "distinct": distinct,
            "min": None if lo is None else convert(lo),
            "max": None if hi is None else convert(hi),
            "mean": to_json_value(avg),
            "top": [{"value": convert(v), "count": n} for v, n in top],
        }

    def export(self, view_id: str) -> tuple[str, str]:
        """Write a view to a temporary CSV; returns (path, download name). Caller deletes it."""
        view = self._view(view_id)
        fd, path = tempfile.mkstemp(prefix="csvview-", suffix=".csv")
        os.close(fd)
        try:
            with self._con.cursor() as cur:
                cur.execute(f"COPY (SELECT * FROM {view.relation}) TO {sql_literal(path)} (HEADER)")
        except duckdb.Error as exc:
            os.unlink(path)
            raise NotFoundError(f"View {view_id} is gone") from exc
        stem = f"query_{view.source[5:]}" if view.source.startswith("_cv.q") else view.source
        return path, f"{stem}.csv"

    def _main_names(self, cur: duckdb.DuckDBPyConnection) -> list[str]:
        return [
            r[0]
            for r in cur.execute(
                "SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main' "
                "AND database_name = current_database() UNION ALL "
                "SELECT view_name FROM duckdb_views() WHERE schema_name = 'main' "
                "AND database_name = current_database() AND NOT internal"
            ).fetchall()
        ]

    def _table_entries(self, cur: duckdb.DuckDBPyConnection, only: str = "") -> list[dict]:
        rows = cur.execute(
            "SELECT table_name, column_name, data_type FROM duckdb_columns() "
            "WHERE schema_name = 'main' AND database_name = current_database() "
            "AND (? = '' OR table_name = ?) ORDER BY table_oid, column_index",
            [only, only],
        ).fetchall()
        grouped: dict[str, list[dict]] = {}
        for table, col, type_name in rows:
            grouped.setdefault(table, []).append({"name": col, "type": type_name})
        return [
            {
                "name": table,
                "rows": cur.execute(f"SELECT count(*) FROM {quote_ident(table)}").fetchone()[0],
                "columns": cols,
                "file": self._files.get(table),
            }
            for table, cols in grouped.items()
        ]

    def _source_ref(self, source: str) -> str:
        if source.startswith("_cv.q"):
            with self._lock:
                if source not in self._results:
                    raise NotFoundError(f"Unknown source: {source}")
            return '"_cv".' + quote_ident(source[4:])
        return quote_ident(source)

    def _describe(self, cur: duckdb.DuckDBPyConnection, ref: str, source: str) -> list[Column]:
        try:
            described = cur.execute(f"DESCRIBE SELECT * FROM {ref}").fetchall()
        except duckdb.CatalogException as exc:
            raise NotFoundError(f"Unknown source: {source}") from exc
        return [Column(name=r[0], type=r[1]) for r in described]

    def _build(
        self,
        cur: duckdb.DuckDBPyConnection,
        view_id: str,
        source: str,
        ref: str,
        columns: list[Column],
        filters: dict[str, str],
        search: str,
        order: list[tuple[str, str]],
    ) -> View:
        types = {c.name: c.type for c in columns}
        parsed = [(col, parse_filter(col, types[col], expr)) for col, expr in filters.items()]
        located = [(col, frag) for col, frag in parsed if frag is not None]
        found = search_fragment([(c.name, c.type) for c in columns], search)
        frags = [frag for _, frag in located] + ([found] if found else [])
        where = Fragment.join(frags, "AND") if frags else None
        order_sql = ", ".join(f"{value_expr(col, types[col])} {d} NULLS LAST" for col, d in order)
        select = f"SELECT * FROM {ref}"
        readable = select + (f" WHERE {where.text}" if where else "")
        readable += f" ORDER BY {order_sql}" if order_sql else ""
        if where is None and not order_sql:
            relation, owned = ref, False
        else:
            relation, owned = f'"_cv".{quote_ident(view_id)}', True
            sql = select + (f" WHERE {where.sql}" if where else "")
            sql += f" ORDER BY {order_sql}" if order_sql else ""
            try:
                cur.execute(
                    f"CREATE TABLE {relation} AS {sql}", list(where.params) if where else []
                )
            except duckdb.Error as exc:
                raise self._locate_error(cur, ref, located, exc) from exc
        total = cur.execute(f"SELECT count(*) FROM {relation}").fetchone()[0]
        converters = [
            (i, KIND_CONVERTERS[kind])
            for i, kind in enumerate(column_kind(c.type) for c in columns)
            if kind in KIND_CONVERTERS
        ]
        view = View(view_id, source, relation, owned, total, columns, readable, converters)
        with self._lock:
            self._views[view_id] = view
            evicted = []
            while len(self._views) > VIEW_CACHE_SIZE:
                evicted.append(self._views.popitem(last=False)[1])
        for old in evicted:
            self._drop(cur, old)
        return view

    def _locate_error(
        self,
        cur: duckdb.DuckDBPyConnection,
        ref: str,
        located: list[tuple[str, Fragment]],
        exc: duckdb.Error,
    ) -> Exception:
        """Name the filter column behind a failed view build, when one alone fails."""
        for col, frag in located:
            try:
                cur.execute(
                    f"SELECT count(*) FROM (SELECT * FROM {ref} LIMIT 1) WHERE {frag.sql}",
                    list(frag.params),
                ).fetchone()
            except duckdb.Error as probe:
                return FilterError(col, str(probe))
        return EngineError(str(exc))

    def _page(self, cur: duckdb.DuckDBPyConnection, view: View, offset: int, limit: int) -> list:
        limit = min(max(0, int(limit)), MAX_PAGE)
        offset = max(0, int(offset))
        try:
            rows = cur.execute(
                f"SELECT * FROM {view.relation} LIMIT ? OFFSET ?", [limit, offset]
            ).fetchall()
        except duckdb.CatalogException as exc:
            raise NotFoundError(f"View {view.id} is gone") from exc
        return convert_rows(rows, view.converters)

    def _cached(self, view_id: str) -> View | None:
        with self._lock:
            view = self._views.get(view_id)
            if view is not None:
                self._views.move_to_end(view_id)
            return view

    def _view(self, view_id: str) -> View:
        view = self._cached(view_id)
        if view is None:
            raise NotFoundError(f"Unknown view: {view_id}")
        return view

    def _remember_result(self, cur: duckdb.DuckDBPyConnection, name: str, n: int) -> None:
        with self._lock:
            self._results[name] = n
            evicted = []
            while len(self._results) > RESULT_CACHE_SIZE:
                evicted.append(self._results.popitem(last=False)[0])
        for old in evicted:
            cur.execute(f'DROP TABLE IF EXISTS "_cv".{quote_ident(old[4:])}')
            self._drop_views(cur, lambda v, src=old: v.source == src)

    def _drop_views(self, cur: duckdb.DuckDBPyConnection, match: Callable[[View], bool]) -> None:
        with self._lock:
            gone = [v for v in self._views.values() if match(v)]
            for v in gone:
                del self._views[v.id]
        for v in gone:
            self._drop(cur, v)

    def _drop(self, cur: duckdb.DuckDBPyConnection, view: View) -> None:
        if view.owned:
            cur.execute(f"DROP TABLE IF EXISTS {view.relation}")


def _elapsed(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)
