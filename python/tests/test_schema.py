"""The models must reproduce rekordbox's own schema exactly.

A writer that emits even a slightly different schema produces a database that
may open fine in SQLite and still be rejected by a player. These tests pin the
models against ``spec/schema.sql``, captured verbatim from a real export.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from onelibrary.schema import ALL_TABLES, Base

SCHEMA_SQL = Path(__file__).resolve().parents[2] / "spec" / "schema.sql"


def parse_reference() -> dict[str, list[str]]:
    """Map table name -> declared column names, from the captured DDL."""
    text = SCHEMA_SQL.read_text()
    out: dict[str, list[str]] = {}
    for m in re.finditer(r"CREATE TABLE (\w+)\((.*?)\);", text, re.S):
        name, body = m.group(1), m.group(2)
        cols = []
        for part in body.split(","):
            part = part.strip()
            if part:
                cols.append(part.split()[0])
        out[name] = cols
    return out


REFERENCE = parse_reference()


def test_reference_schema_parsed():
    assert len(REFERENCE) == 22, f"expected 22 tables, parsed {len(REFERENCE)}"


def test_all_tables_modelled():
    assert set(Base.metadata.tables) == set(REFERENCE)


def test_model_count_matches():
    assert len(ALL_TABLES) == len(REFERENCE)


@pytest.mark.parametrize("table", sorted(REFERENCE))
def test_columns_match_exactly(table):
    """Column names and order must match rekordbox's declaration."""
    modelled = [c.name for c in Base.metadata.tables[table].columns]
    assert modelled == REFERENCE[table], (
        f"{table}: model columns diverge from the reference schema"
    )


def test_rekordbox_typos_preserved():
    """Two misspellings are load-bearing -- a writer must reproduce them."""
    assert "isComplation" in REFERENCE["album"]
    assert "isCompilation" not in REFERENCE["album"]
    assert "OutFileOffsetInBlock" in REFERENCE["cue"]
    assert "outFileOffsetInBlock" not in REFERENCE["cue"]


def test_no_declared_constraints():
    """The schema declares no NOT NULL, DEFAULT or FOREIGN KEY anywhere.

    Documented so that a future divergence is caught rather than assumed.
    """
    text = SCHEMA_SQL.read_text().upper()
    assert "NOT NULL" not in text
    assert "FOREIGN KEY" not in text
    assert "DEFAULT" not in text


def test_create_all_roundtrips(tmp_path):
    """Emitting the models into a fresh database reproduces every column."""
    import sqlite3

    from sqlalchemy import create_engine

    db = tmp_path / "generated.db"
    Base.metadata.create_all(create_engine(f"sqlite:///{db}"))
    conn = sqlite3.connect(db)
    for table, expected in REFERENCE.items():
        got = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        assert got == expected, f"{table}: generated schema diverges"
    conn.close()
