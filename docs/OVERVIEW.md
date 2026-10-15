# Architecture

csvview reads local CSV files into an in-memory DuckDB database, serves a local HTTP API,
and displays a virtualized table in the browser. Inputs are CSV/TSV and supported compressed
CSV files; outputs are browser views, query results, and downloaded CSV exports.

## Execution

`cli.main` parses files and options, loads inputs through `Engine`, binds the HTTP server,
and opens the browser unless `--no-open` is set. Ctrl+C closes the server. The UI can upload
additional files through the same engine. Uploads and exports use temporary files removed
after each transfer. Database contents live for the process lifetime.

The server uses Python's `ThreadingHTTPServer`. DuckDB is the only runtime dependency.
Browser code consists of native JavaScript modules and CSS, with no build step or CDN.
The wheel bundles the entire `static/` directory. There is no external service or paid API.

## Engine and caching

`engine.py` owns a connection to an in-memory database. Operations use separate cursors;
locks coordinate loads and cache changes. Loaded file names are sanitized and deduplicated.
CSV type detection samples rows and retries with the entire file if that parse fails.

An unfiltered view refers to its source. Filtered/sorted views are materialized in the `_cv`
schema and reused for matching requests. Least-recently-used caches bound views and query
results. Evicted views return 404; the browser can recreate them. Engine constants define
cache sizes and page limits. SQL statements can modify the in-memory database and use
DuckDB's file/network features; this API is for trusted local use.

`filters.py` produces SQL fragments with bound values and quoted identifiers. `values.py`
converts results into JSON-safe values. Integers outside JavaScript's exact numeric range
become strings; dates use ISO text; non-finite numbers use explicit string representations.
NaN behaves as empty for filters and statistics. Export uses the current view's rows and
sort order; hidden columns are a browser display setting.

## HTTP contract

The UI calls these routes in `server.py` through `static/js/api.js`.

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /api/tables` | None | `tables`: names, row counts, columns/types, source file labels |
| `POST /api/load` | Raw bytes; URL-encoded `X-Filename` header | `table`: newly loaded table metadata |
| `POST /api/view` | JSON: `source`, optional `filters`, `search`, `sort`, `limit` | View identifier, total, columns, first-page rows, SQL, elapsed milliseconds |
| `GET /api/rows` | Query: `view`, `offset`, `limit` | Rows, offset, elapsed milliseconds |
| `POST /api/query` | JSON: `sql` | Result source/label or statement status |
| `GET /api/column` | Query: `view`, `col` | Count, nulls, distinct, bounds, mean, top values |
| `GET /api/export` | Query: `view` | CSV attachment |
| `GET /` and `/static/...` | Asset path | Bundled HTML, CSS, JS with appropriate content type |

`sort` is a list of objects such as `{"col":"price","dir":"desc"}`. `filters` maps
column names to expression strings. Errors return `{"error":"message"}` with HTTP
400, 404, or 500; filter errors also identify `column`. See `tests/test_server.py` for
executable requests and response assertions. Python internals have no stability guarantee.

## Browser responsibilities

`app.js` coordinates sources, views, and actions. `grid.js`, `blocks.js`, and the column
modules render and page the visible data. The SQL editor, inspector, row drawer, keyboard
bindings, and intake flow have separate modules. `dom.js` centralizes shared browser helpers.
Browser local storage persists preferences, per-table settings, SQL drafts, and history.
Backend rows remain authoritative; the browser is not a persistent database.

## Distribution

Hatchling builds a wheel and source archive using `pyproject.toml`. The version comes from
`__init__.py`. `uv.lock` pins development/CI dependencies; consumers resolve package metadata.
CI tests source and installed wheels across the declared OS/Python matrix. `main` is the
immediate update channel; users refresh it with the README reinstall command. Tagged
releases run checks before attaching packages and SHA-256 checksums to GitHub Releases.
