"""Engine: loading, naming, views and their cache, paging, queries, stats, export."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from csvview import engine as engine_module
from csvview.engine import (
    MAX_PAGE,
    Engine,
    EngineError,
    NotFoundError,
    table_name,
)
from csvview.filters import FilterError

TABLE = "sample_data"


def _cv_tables(eng: Engine) -> set[str]:
    with eng._con.cursor() as cur:
        rows = cur.execute(
            "SELECT table_name FROM duckdb_tables() WHERE schema_name = '_cv'"
        ).fetchall()
    return {r[0] for r in rows}


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("My Data-2024.csv", "my_data_2024"),
        ("/tmp/2024 sales.csv", "t_2024_sales"),
        ("orders.csv.gz", "orders"),
        ("plain", "plain"),
    ],
)
def test_table_name(filename: str, expected: str) -> None:
    assert table_name(filename) == expected


def test_load_names_and_deduplicates(engine: Engine, sample_csv: Path) -> None:
    second = engine.load_csv(str(sample_csv))
    third = engine.load_csv(str(sample_csv), label="Sample Data.csv")
    assert (second["name"], third["name"]) == (f"{TABLE}_2", f"{TABLE}_3")
    assert third["file"] == "Sample Data.csv"
    assert [t["name"] for t in engine.tables()] == [TABLE, f"{TABLE}_2", f"{TABLE}_3"]


def test_tables_shape(engine: Engine, sample_csv: Path) -> None:
    (table,) = engine.tables()
    assert table["rows"] == 5
    assert table["file"] == str(sample_csv)
    types = {c["name"]: c["type"] for c in table["columns"]}
    assert types == {
        "id": "BIGINT",
        "big": "BIGINT",
        "price": "DOUBLE",
        "name": "VARCHAR",
        "city": "VARCHAR",
        "day": "DATE",
        "ts": "TIMESTAMP",
        "flag": "BOOLEAN",
    }


def test_load_failure_is_an_engine_error(tmp_path: Path) -> None:
    with pytest.raises(EngineError):
        Engine().load_csv(str(tmp_path / "missing.csv"))


def test_unfiltered_view_is_the_source(engine: Engine) -> None:
    result = engine.create_view(TABLE)
    assert result["total"] == 5
    assert result["sql"] == f'SELECT * FROM "{TABLE}"'
    assert [r[0] for r in result["rows"]] == [1, 2, 3, 4, 5]
    assert _cv_tables(engine) == set()


def test_json_values(engine: Engine) -> None:
    rows = engine.create_view(TABLE)["rows"]
    assert rows[0][1] == "9007199254740993"
    assert rows[1][1] == 2
    assert rows[1][2] == "NaN"
    assert rows[2][2] is None
    assert rows[0][5] == "2024-01-01"
    assert rows[0][6] == "2024-01-01T10:00:00"
    assert rows[0][7] is True
    json.dumps(rows, allow_nan=False)


def test_filter_sort_and_readable_sql(engine: Engine) -> None:
    result = engine.create_view(
        TABLE,
        filters={"city": "paris | london", "missing_col": "x"},
        sort=[{"col": "price", "dir": "desc"}],
    )
    assert result["total"] == 3
    assert [r[0] for r in result["rows"]] == [4, 1, 2]
    assert "contains(lower(\"city\"), 'paris')" in result["sql"]
    assert result["sql"].endswith("ORDER BY nullif(\"price\", 'NaN'::DOUBLE) DESC NULLS LAST")


def test_nulls_sort_last_both_ways(engine: Engine) -> None:
    asc = engine.create_view(TABLE, sort=[{"col": "day", "dir": "asc"}])
    desc = engine.create_view(TABLE, sort=[{"col": "day", "dir": "desc"}])
    assert asc["rows"][-1][0] == 5
    assert desc["rows"][-1][0] == 5


def test_like_wildcards_match_literally(engine: Engine) -> None:
    assert engine.create_view(TABLE, filters={"name": "50%"})["total"] == 1
    assert engine.create_view(TABLE, filters={"name": "l_x"})["total"] == 1
    assert engine.create_view(TABLE, filters={"name": "o_x"})["total"] == 0


def test_typed_filters_run(engine: Engine) -> None:
    def total(col: str, expr: str) -> int:
        return engine.create_view(TABLE, filters={col: expr})["total"]

    assert total("id", "2..4") == 3
    assert total("price", ">2") == 2
    assert total("day", ">=2024-01-02") == 3
    assert total("ts", "<2024-01-02") == 1
    assert total("city", "null") == 1
    assert total("city", "!=Paris") == 3
    assert total("name", "/^[A-Z]/") == 4
    assert total("flag", "=true") == 2
    assert total("big", "9007199254740993") == 1


def test_search_spans_columns(engine: Engine) -> None:
    assert engine.create_view(TABLE, search="paris")["total"] == 2
    assert engine.create_view(TABLE, search="2024-02")["total"] == 1
    assert engine.create_view(TABLE, search="10.25")["total"] == 1


def test_filter_errors_name_the_column(engine: Engine) -> None:
    with pytest.raises(FilterError) as bad_number:
        engine.create_view(TABLE, filters={"price": ">abc"})
    assert bad_number.value.column == "price"
    with pytest.raises(FilterError) as bad_regex:
        engine.create_view(TABLE, filters={"name": "/a(/"})
    assert bad_regex.value.column == "name"


def test_identical_requests_reuse_the_view(engine: Engine) -> None:
    first = engine.create_view(TABLE, filters={"city": "paris"}, limit=1)
    second = engine.create_view(TABLE, filters={"city": "paris"}, limit=5)
    assert first["view"] == second["view"]
    assert len(first["rows"]) == 1 and len(second["rows"]) == 2
    assert _cv_tables(engine) == {first["view"]}


def test_view_lru_drops_evicted_tables(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engine_module, "VIEW_CACHE_SIZE", 3)
    ids = [engine.create_view(TABLE, filters={"id": f">{n}"})["view"] for n in range(5)]
    assert _cv_tables(engine) == set(ids[2:])
    with pytest.raises(NotFoundError):
        engine.rows(ids[0])
    assert len(engine.rows(ids[4])["rows"]) == 1


def test_paging(engine: Engine) -> None:
    view = engine.create_view(TABLE, sort=[{"col": "id", "dir": "desc"}])["view"]
    page = engine.rows(view, offset=1, limit=2)
    assert page["offset"] == 1
    assert [r[0] for r in page["rows"]] == [4, 3]
    assert len(engine.rows(view, offset=0, limit=MAX_PAGE + 10)["rows"]) == 5
    with pytest.raises(NotFoundError):
        engine.rows("vnope")


def test_query_result_becomes_a_source(engine: Engine) -> None:
    result = engine.run_query(f"SELECT city, count(*) AS n FROM {TABLE} GROUP BY city")
    assert (result["kind"], result["source"], result["label"]) == ("result", "_cv.q1", "Query 1")
    view = engine.create_view("_cv.q1", filters={"n": ">1"})
    assert view["total"] == 1
    assert view["rows"][0][0] == "Paris"
    assert [t["name"] for t in engine.tables()] == [TABLE]


def test_statement_refreshes_tables_and_drops_views(engine: Engine) -> None:
    view = engine.create_view(TABLE, filters={"id": ">1"})["view"]
    result = engine.run_query(f"CREATE TABLE small AS SELECT * FROM {TABLE} WHERE id < 3")
    assert result["kind"] == "statement"
    assert [t["name"] for t in engine.tables()] == [TABLE, "small"]
    assert _cv_tables(engine) == set()
    with pytest.raises(NotFoundError):
        engine.rows(view)


def test_query_errors_and_unknown_sources(engine: Engine) -> None:
    with pytest.raises(EngineError):
        engine.run_query("SELECT nope FROM nowhere")
    with pytest.raises(NotFoundError):
        engine.create_view("nowhere")
    with pytest.raises(NotFoundError):
        engine.create_view("_cv.q99")


def test_result_lru_drops_results_and_their_views(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(engine_module, "RESULT_CACHE_SIZE", 2)
    engine.run_query("SELECT 1 AS a")
    view = engine.create_view("_cv.q1", filters={"a": "1"})["view"]
    engine.run_query("SELECT 2 AS a")
    engine.run_query("SELECT 3 AS a")
    assert _cv_tables(engine) == {"q2", "q3"}
    with pytest.raises(NotFoundError):
        engine.rows(view)
    with pytest.raises(NotFoundError):
        engine.create_view("_cv.q1")


def test_column_stats(engine: Engine) -> None:
    view = engine.create_view(TABLE)["view"]
    price = engine.column_stats(view, "price")
    assert (price["count"], price["nulls"], price["min"], price["max"]) == (5, 2, 1.5, 10.25)
    assert math.isclose(price["mean"], (1.5 + 10.25 + 3.0) / 3)
    city = engine.column_stats(view, "city")
    assert city["top"][0] == {"value": "Paris", "count": 2}
    assert city["mean"] is None
    big = engine.column_stats(view, "big")
    assert big["max"] == "9007199254740993"
    assert engine.column_stats(view, "day")["min"] == "2024-01-01"
    json.dumps(price, allow_nan=False)
    with pytest.raises(NotFoundError):
        engine.column_stats(view, "nope")


def test_export_writes_the_view(engine: Engine) -> None:
    view = engine.create_view(TABLE, filters={"city": "paris"})["view"]
    path, name = engine.export(view)
    try:
        lines = Path(path).read_text().splitlines()
    finally:
        Path(path).unlink()
    assert name == f"{TABLE}.csv"
    assert lines[0].startswith("id,big,price")
    assert len(lines) == 3
    engine.run_query("SELECT 1 AS a")
    query_path, query_name = engine.export(engine.create_view("_cv.q1")["view"])
    Path(query_path).unlink()
    assert query_name == "query_1.csv"
