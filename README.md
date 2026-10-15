# csvview

Open CSV files in a local browser window. Filter, search, sort, inspect columns,
run SQL, and export results using an in-memory DuckDB database.

| Folder | Purpose |
| --- | --- |
| `src/csvview/` | Python application and bundled HTML, CSS, and JavaScript |
| `tests/` | Synthetic-data tests for filters, queries, HTTP, and installed packages |
| `docs/` | Architecture, version policy, and change history |
| `.github/` | Automated checks, release workflow, and pull request template |
| `dist/` | Generated installable packages; excluded from Git |

[Install](#install) · [Update](#update) · [Usage](#usage) ·
[Development](#development) · [Pull requests](#pull-requests) · [Releases](#releases)

## Install

Supports Python 3.9 or later on Windows, macOS, and Linux, wherever DuckDB provides
compatible Python packages. Automated checks cover Python 3.9 and 3.13 on all three
systems. A modern browser is required. No Node.js, database server, or Git installation
is needed to use the app. Python 3.13 is the default in the commands below.

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/), the Python
   package/tool manager. If your office manages software installations, ask IT to install uv.
   With Python already installed, `python -m pip install --user uv` also works
   (Windows: `py -m pip install --user uv`). Reopen your terminal after installation.
2. Install csvview from this repository:

   ```sh
   uv tool install --python 3.13 https://github.com/alexey-rgc/csvview/archive/refs/heads/main.zip
   uv tool update-shell
   ```

3. Reopen your terminal, then launch it:

   ```sh
   csvview
   ```

uv creates an isolated environment and downloads Python if a suitable interpreter is
missing. The first install needs internet access to GitHub and the Python package index.
Normal CSV viewing works offline after installation. Installation does not require an
administrator account under the usual uv setup.

For a fixed, released version instead of the latest `main` code:

```sh
uv tool install --python 3.13 https://github.com/alexey-rgc/csvview/releases/download/v0.1.0/csvview-0.1.0-py3-none-any.whl
```

You can share that wheel file with colleagues and install its downloaded copy:

```sh
uv tool install --python 3.13 ./csvview-0.1.0-py3-none-any.whl
```

The wheel contains the application and browser assets. Python and DuckDB are separate
requirements, so distributing the wheel alone is not a complete offline installer.

### Without uv

Create a virtual environment, then use pip. On macOS/Linux:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install https://github.com/alexey-rgc/csvview/archive/refs/heads/main.zip
.venv/bin/python -m csvview
```

On Windows PowerShell:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install https://github.com/alexey-rgc/csvview/archive/refs/heads/main.zip
.venv\Scripts\python -m csvview
```

## Update

Close the running app with **Ctrl+C in its terminal**, then run:

```sh
uv tool install --reinstall https://github.com/alexey-rgc/csvview/archive/refs/heads/main.zip
csvview --version
csvview
```

This downloads the current `main` branch again, even when the package version has not
changed. Once a contributor's code is merged or pushed to `main`, users can get it with
this command. No Git checkout is needed. Changes pushed only to a feature branch are not
included. Updates are manual; the app does not download or execute updates in the background.
The package version identifies a release, not every commit on `main`.

[uv's tool commands](https://docs.astral.sh/uv/concepts/tools/) keep the installation
separate from other Python projects. Use the repository URL, rather than `pip install
csvview` or an unqualified package-index upgrade, to get this particular project.

For a pip installation, rerun the matching environment's `python -m pip install
--upgrade --force-reinstall --no-cache-dir` with the same archive URL.

To return to the first release:

```sh
uv tool install --reinstall https://github.com/alexey-rgc/csvview/releases/download/v0.1.0/csvview-0.1.0-py3-none-any.whl
```

To uninstall:

```sh
uv tool uninstall csvview
```

## Usage

```text
csvview [FILES ...] [--port PORT] [--host HOST] [--no-open]
csvview --version
csvview --help
```

```sh
csvview sales.csv
csvview sales.csv returns.csv
csvview "Monthly report.csv" --port 9000
csvview --no-open
```

| Option | Behavior |
| --- | --- |
| `FILES` | Zero or more local files; without files, use Open CSV or drag and drop |
| `--port 0` | Default: use port 8765 or the next available port, through 8864 |
| `--port 9000` | Require exactly that port; report an error if it is unavailable |
| `--host 127.0.0.1` | Default: listen only on the local machine |
| `--no-open` | Print the URL without opening the browser |
| `--version` / `--help` | Print the version / command help and exit |

Keep the terminal open while using the app. Ctrl+C stops the server; closing the browser
tab alone does not. Reload the browser after restarting the server.

CSV delimiters and types are detected by DuckDB. TSV and gzip-compressed CSV files can
also be opened. Malformed files show an error instead of silently skipping rows.
Each file becomes a table named after its file stem: lowercase, punctuation replaced
with underscores, a `t_` prefix for a leading digit, and `_2`, `_3` for duplicates.

### Typical session

1. Open a file with `csvview sales.csv`, or drop it into the browser.
2. Type in a column's filter field or the global search box. Click a header to sort.
3. Open SQL to query a loaded table, for example `SELECT * FROM sales LIMIT 100`.
4. Use the column menu to inspect values. Choose Export to download the current view.
5. Stop the server with Ctrl+C when finished.

SQL results become a new “Query N” source with the same filters and sorting. Export
includes all rows of the filtered/sorted view, not only the visible page. Hiding a column
changes its display; it does not remove that column from export.

## Data and operating limits

The database is in memory. Ordinary viewing does not modify the input files, and tables
and query results disappear when the server stops. Uploaded files and exports use
operating-system temporary files that are deleted after the request. Browser downloads
remain wherever the browser saves them.

The browser stores preferences, filters, SQL drafts, and SQL history locally for the
server's address and port. These may contain sensitive values; clear the site's browser
data when needed. No analytics, CDN, or external web fonts are used by the UI.

This is a local, single-user tool with no login or access control. Keep the default
loopback host. Binding to a network address exposes the data and SQL API to other machines.
SQL runs with DuckDB's normal capabilities, including file access and potentially network
access; only run SQL you trust. It is not a sandbox for untrusted SQL or a shared office server.

Large files and materialized filter/query results consume memory. There is no fixed file
size guarantee: capacity depends on the data, queries, and available RAM. Export results
before stopping or updating. The app does not edit spreadsheet formats such as `.xlsx`.

## Filter syntax

Typed into the input under a column header. Matching of text is case-insensitive unless noted.

| Input | Meaning |
| -- | -- |
| `abc` | contains `abc` |
| `42` | on a number column: equals 42 |
| `=abc` | exactly `abc` (case-sensitive); on a number column `=42` |
| `!=abc` | not equal (includes empty cells) |
| `!abc` | does not contain (includes empty cells) |
| `>5` `>=5` `<5` `<=5` | compare; number columns compare as numbers, date and timestamp columns as dates (`>2024-01-31`), text as text |
| `5..10` | between 5 and 10, inclusive (number and date columns); `5..` and `..10` are open-ended |
| `^abc` / `abc$` | starts with / ends with |
| `/re/` | regular expression (RE2 syntax) |
| `null` / `!null` | is empty / is not empty |
| `a \| b` | either |
| `a & b` | both (`&` binds tighter than `\|`) |

`%` and `_` are ordinary characters. NaN in a number column is shown as `NaN` but counts as
empty for filters, sorting and column stats. A malformed filter (`>abc` on a number column) is reported under that column's input.

The search box matches rows where any column contains the text.

## Keyboard shortcuts

Use Ctrl on Windows/Linux wherever ⌘ appears below. Press `?` in the app for the full list.

| Keys | Action |
| -- | -- |
| `/` or ⌘K | focus global search |
| Esc | clear search; close menus and the autocomplete |
| ⌘E | show or hide the SQL panel |
| ⌘Enter | run the selected SQL, or all of it |
| Tab or Enter | accept an autocomplete suggestion |
| Arrows, PageUp, PageDown, Home, End | move the selected cell |
| ⌘C | copy the selected cell |
| ⇧⌘C | copy the selected row as TSV |
| Enter or double-click | open the row detail drawer (↑/↓ step rows) |
| Click a header | sort ascending → descending → none |
| Shift+click a header | add the column to a multi-column sort |
| Alt+click a header | open the column inspector |
| Right-click a header, or `⋯` | column menu: sort, inspect, hide, copy name |
| Double-click a header edge | fit the column width |
| `?` | show all shortcuts |


## Troubleshooting

| Symptom | Action |
| --- | --- |
| `uv` is not found | Reopen the terminal after installing uv; check its installation guide |
| `csvview` is not found | Run `uv tool update-shell`, reopen the terminal, then `uv tool list` |
| Browser did not open | Use `csvview --no-open` and open the printed URL manually |
| Port is in use | Omit `--port`, or choose another port such as `--port 9000` |
| File will not load | Check the path, quote spaces, and read the reported DuckDB parse error |
| Data looks filtered after reopening | Clear filters/search; per-table settings are stored in the browser |
| App slows down or runs out of memory | Open fewer files or smaller extracts; restart to clear cached results |
| Update cannot replace files | Stop every running csvview process before updating, especially on Windows |
| Download blocked by office policy | Ask IT to permit GitHub/Python packages or provide an approved wheel and dependencies |

Report bugs at [GitHub Issues](https://github.com/alexey-rgc/csvview/issues).
Include `csvview --version`, OS, installation method, steps, and a small synthetic CSV.
Never post real office data, secrets, or unredacted screenshots to this public repository.

## Development

Git and uv are required. From a terminal:

```sh
git clone https://github.com/alexey-rgc/csvview.git
cd csvview
uv sync --locked --extra dev
uv run csvview
```

`uv sync` installs this checkout in editable mode. Python changes take effect after
restarting `uv run csvview`; refresh the browser after editing HTML, CSS, or JavaScript.
There is no frontend compilation step. Use synthetic CSVs kept outside version control.
Read [AGENTS.md](AGENTS.md) before changing code and [OVERVIEW.md](docs/OVERVIEW.md) for
module boundaries and HTTP contracts.

### Checks and package builds

```sh
uv run ruff check .
uv run pytest -q
uv build
```

`uv build` writes a source archive (`.tar.gz`) and an installable wheel (`.whl`) to `dist/`.
It builds the wheel from the source archive so missing source-distribution files are
caught. Test the current release wheel in isolation:

```sh
uv run --isolated --no-project --with ./dist/csvview-0.1.0-py3-none-any.whl --with pytest pytest -q
uv run --isolated --no-project --with ./dist/csvview-0.1.0-py3-none-any.whl csvview --version
```

Update the filename when the version changes. These tests load the installed package,
including its browser assets, rather than the editable checkout. GitHub Actions runs
lint, tests, builds, and installed-wheel checks on Windows, macOS, and Linux.

Runtime dependency declarations live in `pyproject.toml`; `uv.lock` pins development
and CI resolution. After intentional dependency edits run `uv lock`, then the checks.
End-user installations resolve compatible dependencies from package metadata.

## Pull requests

A pull request (PR) proposes a branch's changes for review before merging into `main`.

1. Create a branch from the latest main:

   ```sh
   git switch main
   git pull --ff-only
   git switch -c fix/csv-loading
   ```

2. Make one focused change, add regression tests for behavior changes, and update the docs.
   Run the checks above. For UI changes, test loading, filtering, SQL, and export in a browser.
3. Review and commit the intended files:

   ```sh
   git diff
   git status --short
   git add src tests docs README.md
   git commit -m "Fix CSV loading error reporting"
   git push -u origin fix/csv-loading
   ```

4. Open the repository on GitHub and choose **Compare & pull request**, targeting `main`.
   Fill in the PR template with the problem, resulting behavior, and actual checks run.
   If using [GitHub CLI](https://cli.github.com/), `gh pr create --base main --web` opens
   the form in your browser.
5. Address review comments and wait for all Checks jobs to pass before merging. Merging
   into `main` immediately makes the change available through the user update command.

Without repository write access, fork the repository first, clone your fork, and open a
PR from your fork to `alexey-rgc/csvview:main`. Never commit private CSVs, credentials,
virtual environments, or build output. `.gitignore` excludes common local data files;
review staged files even when exclusions exist.

For a maintainer working directly on main, committing and `git push origin main` publishes
that code for updates. Local edits alone are not uploaded. Prefer reviewed PRs because
main-branch updates become available immediately, before a new CI run can finish.

## Releases

[GitHub Releases](https://github.com/alexey-rgc/csvview/releases) provide fixed-version
packages. Publishing to PyPI is not configured. No separate hosting service is needed.
The MIT [license](LICENSE) permits use and redistribution, subject to its terms.

1. Change `__version__` in `src/csvview/__init__.py`, the single source for package versions.
   Update [VERSIONS.md](docs/VERSIONS.md), [CHANGES.md](docs/CHANGES.md), and versioned
   installation/build examples in this README.
2. Run `uv lock`, all checks, and the installed-wheel test. Merge the release changes to main.
3. From the matching main commit, create and push the release tag. For the first release:

   ```sh
   git tag -a v0.1.0 -m "Release csvview 0.1.0"
   git push origin v0.1.0
   ```

4. Wait for the Release workflow. It runs the complete OS/Python test matrix, checks that
   the tag matches the package version, builds the packages, and publishes a GitHub release
   with wheel, source archive, and `SHA256SUMS` file checksums.
5. Verify the release download installs before distributing the fixed-version link.
   Do not move a published tag; ship a new patch version for a correction.

If checks fail, inspect the Actions logs and correct the source before releasing another
tag. If only publication fails after checks pass, rerun the failed job after fixing the
GitHub permission or service problem. A tag must name the exact code being released.
