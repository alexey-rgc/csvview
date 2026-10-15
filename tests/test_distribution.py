"""Exercise installed entry points and the complete bundled browser asset tree."""

from __future__ import annotations

import re
import subprocess
import sys
import threading
import urllib.request
from importlib.metadata import version
from pathlib import Path

from csvview import __version__
from csvview.engine import Engine
from csvview.server import create_server


def test_module_entry_point(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "csvview", "--version"],
        cwd=tmp_path, capture_output=True, text=True, check=True,
    )
    assert result.stdout.strip() == f"csvview {version('csvview')}"
    assert version("csvview") == __version__


def test_missing_file_reports_error(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "csvview", str(tmp_path / "missing.csv")],
        cwd=tmp_path, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 1
    assert "no such file" in result.stderr
    assert "Traceback" not in result.stderr


def test_bundled_ui_assets() -> None:
    server = create_server(Engine())
    thread = threading.Thread(target=server.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    pending = ["/"]
    visited: set[str] = set()
    try:
        while pending:
            path = pending.pop()
            if path in visited:
                continue
            visited.add(path)
            with urllib.request.urlopen(base + path, timeout=10) as response:
                content = response.read().decode("utf-8")
                assert response.status == 200
                if path.endswith(".js"):
                    assert "javascript" in response.headers["Content-Type"]
                elif path.endswith(".css"):
                    assert "text/css" in response.headers["Content-Type"]
            pending.extend(re.findall(r'(?:src|href)="(/static/[^\"]+)"', content))
            for relative in re.findall(r"from ['\"]\./([^'\"]+)['\"]", content):
                pending.append(path.rsplit("/", 1)[0] + "/" + relative)
        assert {"/static/js/app.js", "/static/js/grid.js", "/static/css/app.css"} <= visited
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
