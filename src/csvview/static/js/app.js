/** csvview app: source and view state, view lifecycle, and wiring between grid, panels and top/status bars. */

import { api, isAbort } from './api.js';
import { el, store, debounce, toast, copyText } from './dom.js';
import { Grid, BLOCK_SIZE } from './grid.js';
import { SqlEditor } from './editor.js';
import { Inspector } from './inspector.js';
import { RowDrawer } from './drawer.js';
import { StatusBar } from './statusbar.js';
import { SourceStates, activeFilters } from './sources.js';
import { SourceTabs } from './tabs.js';
import { FileIntake } from './intake.js';
import { ShortcutsOverlay } from './shortcuts.js';
import { bindKeys } from './keys.js';
import { viewControls } from './controls.js';
import { exactFilter, formatMs, rawText, formatInt } from './format.js';

const FILTER_DEBOUNCE_MS = 120;
const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.tables = [];
    this.queries = [];
    this.active = null;
    this.states = new SourceStates();
    this.view = null;
    this.viewSeq = 0;
    this.viewCtrl = null;
    this.lastErrorAt = 0;
    this.scheduleView = debounce(() => this.loadView(), FILTER_DEBOUNCE_MS);

    this.grid = new Grid($('grid'), {
      fetchRows: (view, offset, limit, signal) => api.rows(view, offset, limit, signal).then((r) => r.rows),
      onViewMissing: () => this.recreateView(),
      onError: (err) => this.reportError(err),
      onSort: (col, multi) => this.toggleSort(col, multi),
      onFilter: (col, value) => this.setFilter(col, value, true),
      onFilterCommit: () => this.scheduleView.flush(),
      onHeaderMenu: (col, x, y) => this.columnMenu(col, x, y),
      onInspect: (col) => this.inspect(col),
      onResize: (col, w, done) => this.resizeColumn(col, w, done),
      onSelect: (sel) => this.status.setSelection(sel),
      onOpenRow: (row) => this.drawer.open(row),
      onRowsLoaded: () => {
        this.drawer.refresh();
        this.status.setSelection(this.grid.selection());
      },
      onGridKey: (e) => this.keys.grid(e),
    });
    this.editor = new SqlEditor($('sql-panel'), { onRun: (sql) => this.runQuery(sql), onClose: () => this.toggleSql(false) });
    this.inspector = new Inspector($('inspector'), {
      onPick: (col, value) => this.setFilter(col, exactFilter(value), false),
      onClose: () => this.inspector.close(),
      total: () => (this.view ? this.view.total : 0),
    });
    this.drawer = new RowDrawer($('drawer'), {
      getRow: (i) => this.grid.getRow(i),
      requestRow: (i) => this.grid.requestRow(i),
      columns: () => this.grid.allColumns(),
      hidden: () => new Set(this.state().hidden),
      total: () => (this.view ? this.view.total : 0),
      onStep: (d) => this.stepDrawer(d),
      onClose: () => {
        this.drawer.close();
        this.grid.focus();
      },
    });
    this.status = new StatusBar($('statusbar'), {
      onRemoveFilter: (col) => this.setFilter(col, '', false),
      onClearSearch: () => this.setSearch('', false),
      onClearAll: () => this.clearAll(),
      onHiddenChip: (anchor) => this.hiddenMenu(anchor),
      onOpenSql: () => this.openInSql(),
    });
    this.tabs = new SourceTabs($('tabs'), { onSelect: (s) => this.setActive(s), onClose: (s) => this.closeQuery(s) });
    this.intake = new FileIntake({ overlay: $('drop-overlay'), input: $('file-input'), onLoaded: (t) => this.onTableLoaded(t) });
    this.shortcuts = new ShortcutsOverlay($('shortcuts'));
    this.searchInput = $('search');
    this.keys = bindKeys(this);
    this.bindTopBar();
  }

  bindTopBar() {
    this.searchInput.addEventListener('input', () => this.setSearch(this.searchInput.value, true));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.scheduleView.flush();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.grid.focus();
      }
    });
    $('open-btn').addEventListener('click', () => this.intake.pick());
    $('empty-open').addEventListener('click', () => this.intake.pick());
    $('no-rows-clear').addEventListener('click', () => this.clearAll());
    $('sql-btn').addEventListener('click', () => this.toggleSql());
    $('export-btn').addEventListener('click', () => this.exportView());
    $('theme-btn').addEventListener('click', () => this.toggleTheme());
    $('help-btn').addEventListener('click', () => this.shortcuts.toggle());
  }

  async start() {
    await this.refreshTables();
    const saved = store.get('active', null);
    const first = this.tables.find((t) => t.name === saved) || this.tables[0];
    if (first) this.setActive(first.name);
    else this.showEmpty(true);
  }

  async refreshTables() {
    try {
      const res = await api.tables();
      this.tables = res.tables || [];
    } catch (err) {
      this.reportError(err);
    }
    this.renderTabs();
    this.editor.setSchema(this.schema());
  }

  schema() {
    const tables = this.tables.map((t) => ({ name: t.name, columns: t.columns }));
    for (const q of this.queries) tables.push({ name: q.source, label: q.label, columns: q.columns });
    return { tables, active: this.active };
  }

  renderTabs() {
    this.tabs.render(this.tables, this.queries, this.active);
  }

  sourceInfo(source) {
    return this.tables.find((t) => t.name === source) || this.queries.find((q) => q.source === source) || null;
  }

  state() {
    return this.states.get(this.active || '');
  }

  showEmpty(on) {
    $('empty').hidden = !on;
    if (on) $('no-rows').hidden = true;
    $('grid').hidden = on;
    if (on) {
      this.status.clear('No data loaded');
      this.inspector.close();
      this.drawer.close();
    }
  }

  setActive(source) {
    if (!this.sourceInfo(source)) return;
    this.active = source;
    if (!source.startsWith('_cv.')) store.set('active', source);
    const table = this.tables.find((t) => t.name === source);
    if (table) this.states.sanitize(source, table.columns);
    const st = this.state();
    this.searchInput.value = st.search;
    this.grid.header.setSort(st.sort);
    this.grid.header.setFilters(st.filters);
    this.grid.header.setError(null);
    this.drawer.close();
    this.showEmpty(false);
    this.renderTabs();
    this.editor.setSchema(this.schema());
    this.loadView({ resetScroll: true });
  }

  viewSpec() {
    const st = this.state();
    return { source: this.active, filters: activeFilters(st.filters), search: st.search.trim(), sort: st.sort, limit: BLOCK_SIZE };
  }

  async loadView({ resetScroll = true } = {}) {
    this.scheduleView.cancel();
    if (!this.active) return;
    const spec = this.viewSpec();
    if (this.viewCtrl) this.viewCtrl.abort();
    const ctrl = (this.viewCtrl = new AbortController());
    const seq = ++this.viewSeq;
    this.grid.setLoading(true);
    this.status.setLoading(true);
    try {
      const res = await api.view(spec, ctrl.signal);
      if (seq !== this.viewSeq) return;
      this.applyView(res, spec, resetScroll);
    } catch (err) {
      if (isAbort(err) || seq !== this.viewSeq) return;
      if (err.column) this.showFilterError(spec, err);
      else this.reportError(err);
    } finally {
      if (seq === this.viewSeq) {
        this.grid.setLoading(false);
        this.status.setLoading(false);
      }
    }
  }

  /** A rejected filter keeps the last good rows; on a fresh source the header is still shown so it can be fixed. */
  showFilterError(spec, err) {
    if (this.grid.sourceKey !== spec.source) {
      const info = this.sourceInfo(spec.source);
      const st = this.state();
      this.view = null;
      this.grid.setView({ view: null, total: 0, columns: (info && info.columns) || [], rows: [] },
        { sourceKey: spec.source, hidden: st.hidden, widths: st.widths, resetScroll: true });
      this.status.clear(`No rows: the filter on ${err.column} is not valid`);
      $('no-rows').hidden = true;
    }
    this.grid.header.setError(err.column, err.message);
  }

  applyView(res, spec, resetScroll) {
    const sourceChanged = !this.view || this.view.spec.source !== spec.source;
    this.view = { ...res, spec };
    const st = this.state();
    const query = this.queries.find((q) => q.source === spec.source);
    if (query) {
      query.columns = res.columns;
      if (query.rows == null && !Object.keys(spec.filters).length && !spec.search) query.rows = res.total;
      this.renderTabs();
      this.editor.setSchema(this.schema());
    }
    this.grid.header.setError(null);
    this.grid.search = spec.search;
    this.grid.setView(res, { sourceKey: spec.source, hidden: st.hidden, widths: st.widths, resetScroll: resetScroll || sourceChanged });
    $('no-rows').hidden = res.total > 0;
    this.updateStatus();
    this.inspector.viewChanged(res.view, res.columns);
    if (!resetScroll) this.drawer.refresh();
    else this.drawer.close();
    this.status.setSelection(this.grid.selection());
  }

  updateStatus() {
    if (!this.view) return;
    const info = this.sourceInfo(this.view.spec.source);
    this.status.update({
      shown: this.view.total,
      total: info ? info.rows : null,
      ms: this.view.ms,
      filters: this.view.spec.filters,
      search: this.view.spec.search,
      hidden: this.state().hidden,
    });
  }

  async recreateView() {
    if (!this.view) return;
    const { spec, total } = this.view;
    const seq = this.viewSeq;
    try {
      const res = await api.view(spec);
      if (seq !== this.viewSeq || !this.view || this.view.spec !== spec) return;
      if (res.total === total) {
        this.view = { ...res, spec };
        this.grid.rebind(res.view);
      } else {
        this.applyView(res, spec, true);
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  reportError(err) {
    if (isAbort(err)) return;
    const now = Date.now();
    if (now - this.lastErrorAt < 1500) return;
    this.lastErrorAt = now;
    toast(err.message || String(err), { kind: 'error', timeout: 5000 });
  }

  inspect(name) {
    const col = this.grid.allColumns().find((c) => c.name === name);
    if (!col || !this.view) return;
    this.inspector.open(this.view.view, col);
  }

  stepDrawer(delta) {
    const next = this.drawer.row + delta;
    if (next < 0 || !this.view || next >= this.view.total) return;
    const sel = this.grid.sel;
    this.grid.select(next, sel ? sel.col : 0);
    this.drawer.show(next);
  }

  toggleSql(force) {
    const open = force === undefined ? !this.editor.isOpen : force;
    if (open) this.editor.open();
    else {
      this.editor.close();
      this.grid.focus();
    }
    $('sql-btn').setAttribute('aria-pressed', String(open));
  }

  openInSql() {
    if (!this.view) return;
    this.toggleSql(true);
    this.editor.setText(this.view.sql);
  }

  async runQuery(sql) {
    this.editor.setBusy(true);
    this.editor.setError(null);
    this.editor.setStatus('Running…');
    try {
      const res = await api.query(sql);
      if (res.kind === 'result') {
        this.queries.push({ source: res.source, label: res.label, sql, rows: null, columns: [] });
        this.editor.setStatus(`${res.label} · ${formatMs(res.ms)}`);
        this.setActive(res.source);
      } else {
        this.editor.setStatus(`${res.message || 'OK'} · ${formatMs(res.ms)}`);
        await this.refreshTables();
        if (this.active && !this.sourceInfo(this.active)) {
          const next = this.tables[0] || this.queries[0];
          if (next) this.setActive(next.name || next.source);
          else this.showEmpty(true);
        } else if (this.active) {
          this.loadView({ resetScroll: false });
        } else if (this.tables[0]) {
          this.setActive(this.tables[0].name);
        }
      }
    } catch (err) {
      this.editor.setStatus('');
      this.editor.setError(err.message);
    } finally {
      this.editor.setBusy(false);
    }
  }

  closeQuery(source) {
    this.queries = this.queries.filter((q) => q.source !== source);
    this.states.drop(source);
    if (this.active === source) {
      const next = this.queries[this.queries.length - 1] || this.tables[0];
      if (next) this.setActive(next.source || next.name);
      else {
        this.active = null;
        this.view = null;
        this.showEmpty(true);
      }
    }
    this.renderTabs();
    this.editor.setSchema(this.schema());
  }

  async onTableLoaded(table) {
    await this.refreshTables();
    this.setActive(table.name);
  }

  exportView() {
    if (!this.view) return;
    const a = el('a', { href: api.exportUrl(this.view.view), download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  toggleTheme() {
    const root = document.documentElement;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : systemDark;
    const next = isDark ? 'light' : 'dark';
    if ((next === 'dark') === systemDark) {
      delete root.dataset.theme;
      store.remove('theme');
    } else {
      root.dataset.theme = next;
      store.set('theme', next);
    }
  }

  copySelection(asRow) {
    const sel = this.grid.selection();
    if (!sel || !sel.loaded) return;
    let text;
    if (asRow) {
      const row = this.grid.getRow(sel.row);
      text = this.grid.layout.cols.map((c) => rawText(row[c.idx]).replace(/[\t\r\n]+/g, ' ')).join('\t');
    } else {
      text = rawText(sel.value);
    }
    copyText(text).then((ok) => ok && toast(asRow ? `Copied row ${formatInt(sel.row + 1)}` : 'Copied cell', { timeout: 1200 }));
  }
}

Object.assign(App.prototype, viewControls);

const app = new App();
app.start();
