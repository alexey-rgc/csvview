"""Command line: load CSV files into the engine, start the server, open the browser."""

from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser
from collections.abc import Sequence
from pathlib import Path

from . import __version__
from .engine import Engine, EngineError
from .server import create_server


def build_parser() -> argparse.ArgumentParser:
    """The `csvview` argument parser."""
    parser = argparse.ArgumentParser(
        prog="csvview", description="Open CSV files in a fast local browser UI."
    )
    parser.add_argument("files", nargs="*", help="CSV files to load (none opens an empty UI)")
    parser.add_argument(
        "--port", type=int, default=0, help="port to listen on (0: 8765 or the next free one)"
    )
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    parser.add_argument("--version", action="version", version=f"csvview {__version__}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run csvview; returns the process exit code."""
    args = build_parser().parse_args(argv)
    engine = Engine()
    started = time.perf_counter()
    for name in args.files:
        path = Path(name).expanduser()
        if not path.is_file():
            print(f"csvview: no such file: {name}", file=sys.stderr)
            return 1
        try:
            engine.load_csv(str(path.resolve()))
        except EngineError as exc:
            print(f"csvview: {exc}", file=sys.stderr)
            return 1
    loaded_in = time.perf_counter() - started
    tables = engine.tables()
    try:
        server = create_server(engine, args.host, args.port)
    except OSError as exc:
        print(f"csvview: cannot listen on {args.host}: {exc}", file=sys.stderr)
        return 1
    url = f"http://{args.host}:{server.server_address[1]}"
    rows = sum(t["rows"] for t in tables)
    noun = "table" if len(tables) == 1 else "tables"
    print(
        f"csvview → {url}  ({len(tables)} {noun}, {rows:,} rows, loaded in {loaded_in:.2f} s)",
        flush=True,
    )
    if not args.no_open:
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
