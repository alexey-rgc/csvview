"""Filter grammar: SQL shape, bound parameters, escaping and errors."""

from __future__ import annotations

from datetime import date, datetime

import pytest

from csvview.filters import (
    FilterError,
    column_kind,
    parse_filter,
    quote_ident,
    search_fragment,
)


def ci(expr: str) -> str:
    return f"contains(lower({expr}), ?)"


C = ci('"c"')


def test_blank_expression_is_no_filter() -> None:
    assert parse_filter("c", "VARCHAR", "") is None
    assert parse_filter("c", "VARCHAR", "   ") is None
    assert parse_filter("c", "BIGINT", ">") is None


def test_plain_text_is_case_insensitive_contains() -> None:
    frag = parse_filter("name", "VARCHAR", "abc")
    assert frag.sql == ci('"name"')
    assert parse_filter("name", "VARCHAR", "AbC").params == ("abc",)


def test_number_on_numeric_column_is_equality() -> None:
    frag = parse_filter("n", "BIGINT", "42")
    assert frag.sql == '"n" = ?'
    assert frag.params == (42,)
    assert parse_filter("x", "DOUBLE", "2.5").params == (2.5,)


def test_non_number_on_numeric_column_falls_back_to_contains() -> None:
    frag = parse_filter("n", "INTEGER", "abc")
    assert frag.sql == ci('CAST("n" AS VARCHAR)')


def test_exact_and_not_equal() -> None:
    assert parse_filter("c", "VARCHAR", "=Abc").sql == '"c" = ?'
    assert parse_filter("n", "BIGINT", "=5").params == (5,)
    frag = parse_filter("c", "VARCHAR", "!=abc")
    assert frag.sql == '("c" <> ? OR "c" IS NULL)'
    assert frag.params == ("abc",)


def test_not_contains_includes_nulls() -> None:
    frag = parse_filter("c", "VARCHAR", "!abc")
    assert frag.sql == f'(NOT ({C}) OR "c" IS NULL)'
    assert frag.params == ("abc",)


def test_comparisons_cast_value_to_column_type() -> None:
    assert parse_filter("n", "BIGINT", ">5").params == (5,)
    assert parse_filter("n", "BIGINT", ">= 5").sql == '"n" >= ?'
    assert parse_filter("d", "DATE", "<2024-01-31").params == (date(2024, 1, 31),)
    ts = parse_filter("t", "TIMESTAMP", ">2024-01-01 10:00")
    assert ts.params == (datetime(2024, 1, 1, 10, 0),)
    text = parse_filter("c", "VARCHAR", "<=m")
    assert (text.sql, text.params) == ('"c" <= ?', ("m",))


def test_malformed_numeric_comparison_names_the_column() -> None:
    with pytest.raises(FilterError) as err:
        parse_filter("price", "DOUBLE", ">abc")
    assert err.value.column == "price"
    assert "price" in str(err.value)
    with pytest.raises(FilterError):
        parse_filter("d", "DATE", ">yesterday")
    with pytest.raises(FilterError):
        parse_filter("n", "BIGINT", "=abc")


def test_ranges() -> None:
    frag = parse_filter("n", "BIGINT", "5..10")
    assert (frag.sql, frag.params) == ('"n" BETWEEN ? AND ?', (5, 10))
    assert parse_filter("n", "DOUBLE", "1.5..").sql == "nullif(\"n\", 'NaN'::DOUBLE) >= ?"
    assert parse_filter("n", "INTEGER", "..2").sql == '"n" <= ?'
    assert parse_filter("d", "DATE", "2024-01-01..2024-02-01").params == (
        date(2024, 1, 1),
        date(2024, 2, 1),
    )
    with pytest.raises(FilterError):
        parse_filter("n", "BIGINT", "5..x")


def test_dots_in_text_column_are_contains() -> None:
    assert parse_filter("c", "VARCHAR", "wait...").params == ("wait...",)


def test_starts_and_ends_with() -> None:
    assert parse_filter("c", "VARCHAR", "^Abc").sql == 'starts_with(lower("c"), ?)'
    assert parse_filter("c", "VARCHAR", "abc$").sql == 'ends_with(lower("c"), ?)'
    exact = parse_filter("c", "VARCHAR", "^ABC$")
    assert (exact.sql, exact.params) == ('lower("c") = ?', ("abc",))


def test_regex_keeps_its_pipes() -> None:
    frag = parse_filter("c", "VARCHAR", "/a|b/")
    assert (frag.sql, frag.params) == ('regexp_matches("c", ?)', ("a|b",))
    combined = parse_filter("c", "VARCHAR", "/x|y/ | foo")
    assert combined.sql == f'(regexp_matches("c", ?) OR {C})'
    assert combined.params == ("x|y", "foo")


def test_null_checks_cover_empty_text() -> None:
    assert parse_filter("c", "VARCHAR", "null").sql == '("c" IS NULL OR "c" = \'\')'
    assert parse_filter("c", "VARCHAR", "!NULL").sql == '("c" IS NOT NULL AND "c" <> \'\')'
    assert parse_filter("n", "BIGINT", "null").sql == '"n" IS NULL'


def test_or_and_precedence() -> None:
    frag = parse_filter("c", "VARCHAR", "a & b | c")
    assert frag.sql == f"(({C} AND {C}) OR {C})"
    assert frag.params == ("a", "b", "c")


def test_like_wildcards_are_plain_characters() -> None:
    frag = parse_filter("c", "VARCHAR", "50%_off")
    assert (frag.sql, frag.params) == (ci('"c"'), ("50%_off",))


def test_identifiers_are_quoted() -> None:
    assert quote_ident('we"ird') == '"we""ird"'
    assert parse_filter('a"b', "VARCHAR", "x").sql == ci('"a""b"')


def test_readable_text_inlines_literals() -> None:
    frag = parse_filter("c", "VARCHAR", "=it's")
    assert frag.text == "\"c\" = 'it''s'"
    assert parse_filter("d", "DATE", ">2024-01-01").text == "\"d\" > DATE '2024-01-01'"


def test_search_ors_every_column_that_could_match() -> None:
    columns = [("name", "VARCHAR"), ("n", "BIGINT"), ("d", "DATE"), ("f", "BOOLEAN")]
    frag = search_fragment(columns, " 12 ")
    name, n, d = ci('"name"'), ci('CAST("n" AS VARCHAR)'), ci('CAST("d" AS VARCHAR)')
    assert frag.sql == f"({name} OR {n} OR {d})"
    assert frag.params == ("12", "12", "12")
    assert search_fragment(columns, "Paris").sql == ci('"name"')
    assert 'CAST("f"' in search_fragment(columns, "RU").sql
    assert search_fragment([("n", "BIGINT")], "abc").sql == "FALSE"
    assert search_fragment(columns, "  ") is None


@pytest.mark.parametrize(
    ("type_name", "kind"),
    [
        ("BIGINT", "bigint"),
        ("INTEGER", "int"),
        ("DOUBLE", "float"),
        ("DECIMAL(18,3)", "decimal"),
        ("DATE", "date"),
        ("TIMESTAMP WITH TIME ZONE", "timestamp"),
        ("TIME", "time"),
        ("BOOLEAN", "bool"),
        ("VARCHAR", "text"),
        ("BLOB", "blob"),
        ("INTEGER[]", "other"),
        ("STRUCT(a INTEGER)", "other"),
    ],
)
def test_column_kind(type_name: str, kind: str) -> None:
    assert column_kind(type_name) == kind


def test_escaped_pipe_and_ampersand_are_literal():
    frag = parse_filter("name", "VARCHAR", r"=a\|b\&c")
    assert frag is not None
    assert list(frag.params) == ["a|b&c"]
