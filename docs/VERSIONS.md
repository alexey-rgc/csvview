# Versions

The package version is defined once in `src/csvview/__init__.py`. `pyproject.toml` reads it
through Hatchling's dynamic version configuration. Release tags are `v` plus that version.

| Version | Scope |
| --- | --- |
| 0.1.0 | First distributed CSV viewer: local browser UI, SQL, filters, export, installable packages, GitHub updates |

Use `MAJOR.MINOR.PATCH`: patch for compatible fixes, minor for new compatible features,
and major for breaking user-facing behavior. During 0.x development, document breaking
changes with a minor bump. Never overwrite an existing release or move its tag.

Every release updates the version, lock file, README versioned examples, this table, and
CHANGES.md. Main-branch users may have newer commits with the same version until the next
release. A tag identifies fixed code; `--version` does not identify every main-branch commit.
