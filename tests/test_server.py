"""HTTP server: every endpoint over a real socket, plus static files and error shapes."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

from csvview.engine import Engine
from csvview.server import create_server

TABLE = "sample_data"


@pytest.fixture()
def base_url(engine: Engine, tmp_path: Path) -> Iterator[str]:
    static = tmp_path / "static"
    (static / "css").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>csvview</title>")
    (static / "css" / "app.css").write_text("body{}")
    (tmp_path / "secret.txt").write_text("nope")
    server = create_server(engine, "127.0.0.1", 0, static_dir=static)
    thread = threading.Thread(target=server.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _request(
    url: str, body: bytes | None = None, headers: dict | None = None
) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


def _get(url: str) -> tuple[int, dict]:
    status, _, data = _request(url)
    return status, json.loads(data)


def _post(url: str, payload: dict) -> tuple[int, dict]:
    body = json.dumps(payload).encode()
    status, _, data = _request(url, body, {"Content-Type": "application/json"})
    return status, json.loads(data)


def test_static_files(base_url: str) -> None:
    status, headers, body = _request(base_url + "/")
    assert status == 200
    assert headers["Content-Type"].startswith("text/html")
    assert headers["Cache-Control"] == "no-cache"
    assert b"<title>csvview</title>" in body
    status, headers, _ = _request(base_url + "/static/css/app.css")
    assert (status, headers["Content-Type"]) == (200, "text/css; charset=utf-8")
    assert _request(base_url + "/static/%2e%2e/secret.txt")[0] == 404
    assert _request(base_url + "/static/missing.js")[0] == 404


def test_tables(base_url: str) -> None:
    status, body = _get(base_url + "/api/tables")
    assert status == 200
    (table,) = body["tables"]
    assert (table["name"], table["rows"], len(table["columns"])) == (TABLE, 5, 8)


def test_view_rows_column_export(base_url: str) -> None:
    status, view = _post(
        base_url + "/api/view",
        {"source": TABLE, "filters": {"city": "paris"}, "sort": [{"col": "id", "dir": "desc"}]},
    )
    assert status == 200
    assert set(view) == {"view", "total", "columns", "rows", "sql", "ms"}
    assert view["total"] == 2
    assert [r[0] for r in view["rows"]] == [4, 2]

    status, page = _get(f"{base_url}/api/rows?view={view['view']}&offset=1&limit=10")
    assert status == 200
    assert (page["offset"], [r[0] for r in page["rows"]]) == (1, [2])

    status, stats = _get(f"{base_url}/api/column?view={view['view']}&col=price")
    assert status == 200
    assert (stats["count"], stats["nulls"], stats["max"]) == (2, 1, 10.25)

    status, headers, data = _request(f"{base_url}/api/export?view={view['view']}")
    assert status == 200
    assert headers["Content-Type"].startswith("text/csv")
    assert f'filename="{TABLE}.csv"' in headers["Content-Disposition"]
    assert data.decode().splitlines()[0].startswith("id,big,price")


def test_json_is_compact_and_safe(base_url: str) -> None:
    status, _, data = _request(base_url + "/api/view", json.dumps({"source": TABLE}).encode(), {})
    assert status == 200
    assert b'", "' not in data and b'": ' not in data
    rows = json.loads(data)["rows"]
    assert rows[0][1] == "9007199254740993"
    assert rows[1][2] == "NaN"


def test_query_result_and_statement(base_url: str) -> None:
    status, result = _post(base_url + "/api/query", {"sql": f"SELECT city FROM {TABLE}"})
    assert status == 200
    assert (result["kind"], result["source"], result["label"]) == ("result", "_cv.q1", "Query 1")
    status, view = _post(base_url + "/api/view", {"source": "_cv.q1"})
    assert (status, view["total"]) == (200, 5)
    status, statement = _post(base_url + "/api/query", {"sql": "CREATE TABLE t2 (a INTEGER)"})
    assert (status, statement["kind"], statement["message"]) == (200, "statement", "OK")
    names = [t["name"] for t in _get(base_url + "/api/tables")[1]["tables"]]
    assert names == [TABLE, "t2"]


def test_load_upload(base_url: str, sample_csv: Path) -> None:
    status, _, data = _request(
        base_url + "/api/load", sample_csv.read_bytes(), {"X-Filename": "Uploaded%20File.csv"}
    )
    assert status == 200
    table = json.loads(data)["table"]
    assert (table["name"], table["rows"], table["file"]) == (
        "uploaded_file",
        5,
        "Uploaded File.csv",
    )


def test_errors(base_url: str) -> None:
    status, body = _post(base_url + "/api/view", {"source": TABLE, "filters": {"price": ">abc"}})
    assert (status, body["column"]) == (400, "price")
    assert "price" in body["error"]
    assert _get(base_url + "/api/rows?view=vgone")[0] == 404
    assert _post(base_url + "/api/view", {"source": "nowhere"})[0] == 404
    status, body = _post(base_url + "/api/query", {"sql": "SELEC 1"})
    assert status == 400 and body["error"]
    assert _get(base_url + "/api/rows")[0] == 400
    assert _get(base_url + "/api/nope")[0] == 404
    assert _post(base_url + "/api/nope", {})[0] == 404
