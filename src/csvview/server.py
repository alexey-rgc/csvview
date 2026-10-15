"""HTTP server: the engine's JSON API and bundled static browser files."""

from __future__ import annotations

import json
import mimetypes
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .engine import DEFAULT_PAGE, Engine, EngineError
from .filters import FilterError

STATIC_DIR = Path(__file__).parent / "static"
PREFERRED_PORT = 8765
PORT_ATTEMPTS = 100
CHUNK_BYTES = 1 << 20
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

Query = dict[str, list[str]]


class CsvviewServer(ThreadingHTTPServer):
    """A threading HTTP server that carries the engine and the static folder."""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], engine: Engine, static_dir: Path) -> None:
        super().__init__(address, Handler)
        self.engine = engine
        self.static_dir = static_dir.resolve()


class Handler(BaseHTTPRequestHandler):
    """Routes `/api/*` to the engine and everything else to static files."""

    server: CsvviewServer
    protocol_version = "HTTP/1.1"
    server_version = "csvview"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        routes: dict[str, Callable[[Query], None]] = {
            "/api/tables": self._tables,
            "/api/rows": self._rows,
            "/api/column": self._column,
            "/api/export": self._export,
        }
        route = routes.get(url.path)
        if route is not None:
            self._dispatch(route, parse_qs(url.query))
        elif url.path.startswith("/api/"):
            self._json(404, {"error": f"Unknown endpoint: {url.path}"})
        else:
            self._static(url.path)

    def do_POST(self) -> None:
        url = urlsplit(self.path)
        routes: dict[str, Callable[[Query], None]] = {
            "/api/load": self._load,
            "/api/view": self._view,
            "/api/query": self._query,
        }
        route = routes.get(url.path)
        if route is None:
            self._discard_body()
            self._json(404, {"error": f"Unknown endpoint: {url.path}"})
        else:
            self._dispatch(route, parse_qs(url.query))

    def _dispatch(self, route: Callable[[Query], None], query: Query) -> None:
        try:
            route(query)
        except FilterError as exc:
            self._json(400, {"error": str(exc), "column": exc.column})
        except EngineError as exc:
            self._json(exc.status, {"error": str(exc)})
        except (ValueError, TypeError, KeyError) as exc:
            self._json(400, {"error": f"Bad request: {exc}"})
        except Exception as exc:
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})

    def _tables(self, query: Query) -> None:
        self._json(200, {"tables": self.server.engine.tables()})

    def _rows(self, query: Query) -> None:
        result = self.server.engine.rows(
            _param(query, "view"),
            int(_param(query, "offset", "0")),
            int(_param(query, "limit", str(DEFAULT_PAGE))),
        )
        self._json(200, result)

    def _column(self, query: Query) -> None:
        self._json(
            200, self.server.engine.column_stats(_param(query, "view"), _param(query, "col"))
        )

    def _export(self, query: Query) -> None:
        path, name = self.server.engine.export(_param(query, "view"))
        try:
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(name)}",
            )
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(path, "rb") as fh:
                while chunk := fh.read(CHUNK_BYTES):
                    self.wfile.write(chunk)
        finally:
            os.unlink(path)

    def _load(self, query: Query) -> None:
        name = Path(unquote(self.headers.get("X-Filename") or "upload.csv")).name or "upload.csv"
        suffix = "".join(Path(name).suffixes) or ".csv"
        fd, path = tempfile.mkstemp(prefix="csvview-upload-", suffix=suffix)
        try:
            with os.fdopen(fd, "wb") as fh:
                remaining = int(self.headers.get("Content-Length") or 0)
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK_BYTES, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
            table = self.server.engine.load_csv(path, label=name)
        finally:
            os.unlink(path)
        self._json(200, {"table": table})

    def _view(self, query: Query) -> None:
        body = self._body_json()
        source = body.get("source")
        if not isinstance(source, str) or not source:
            raise ValueError("source is required")
        result = self.server.engine.create_view(
            source,
            filters=body.get("filters") or {},
            search=body.get("search") or "",
            sort=body.get("sort") or [],
            limit=int(body.get("limit", DEFAULT_PAGE)),
        )
        self._json(200, result)

    def _query(self, query: Query) -> None:
        sql = self._body_json().get("sql")
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError("sql is required")
        self._json(200, self.server.engine.run_query(sql))

    def _body_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        if not isinstance(body, dict):
            raise ValueError("JSON body must be an object")
        return body

    def _discard_body(self) -> None:
        remaining = int(self.headers.get("Content-Length") or 0)
        while remaining > 0:
            chunk = self.rfile.read(min(CHUNK_BYTES, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    def _static(self, url_path: str) -> None:
        rel = unquote(url_path).lstrip("/") or "index.html"
        if rel.startswith("static/"):
            rel = rel[len("static/") :]
        root = self.server.static_dir
        target = (root / rel).resolve()
        if root not in target.parents or not target.is_file():
            self._json(404, {"error": f"Not found: {url_path}"})
            return
        data = target.read_bytes()
        content_type = CONTENT_TYPES.get(target.suffix.lower()) or (
            mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        )
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: int, payload: object) -> None:
        data = json.dumps(
            payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def _param(query: Query, name: str, default: str | None = None) -> str:
    values = query.get(name)
    if values:
        return values[0]
    if default is None:
        raise ValueError(f"missing parameter: {name}")
    return default


def create_server(
    engine: Engine, host: str = "127.0.0.1", port: int = 0, static_dir: Path = STATIC_DIR
) -> CsvviewServer:
    """Bind on `port`, or for port 0 on the first free port from PREFERRED_PORT upwards."""
    candidates = [port] if port else range(PREFERRED_PORT, PREFERRED_PORT + PORT_ATTEMPTS)
    error: OSError | None = None
    for candidate in candidates:
        try:
            return CsvviewServer((host, candidate), engine, static_dir)
        except OSError as exc:
            error = exc
    raise error or OSError("no free port")
