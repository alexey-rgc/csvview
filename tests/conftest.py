"""Shared fixtures: a small mixed-type CSV and an engine with it loaded."""

from __future__ import annotations

from pathlib import Path

import pytest

from csvview.engine import Engine

SAMPLE_CSV = """id,big,price,name,city,day,ts,flag
1,9007199254740993,1.5,Alice Smith,London,2024-01-01,2024-01-01 10:00:00,true
2,2,nan,Bob 50% off,Paris,2024-01-02,2024-01-02 11:30:00,false
3,3,,carol_x,,2024-01-03,2024-01-03 12:00:00,true
4,4,10.25,Dave,Paris,2024-02-01,2024-02-01 00:00:00,
5,5,3.0,Eve 50 off,Oslo,,2024-03-01 08:00:00,false
"""


@pytest.fixture()
def sample_csv(tmp_path: Path) -> Path:
    path = tmp_path / "Sample Data.csv"
    path.write_text(SAMPLE_CSV)
    return path


@pytest.fixture()
def engine(sample_csv: Path) -> Engine:
    eng = Engine()
    eng.load_csv(str(sample_csv))
    return eng
