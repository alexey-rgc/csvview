/** View-state edits mixed into App: filters, search, sort, column widths and visibility, column menus. */

import { copyText, toast } from './dom.js';
import { openMenu } from './menu.js';
import { formatInt } from './format.js';

export const viewControls = {
  setFilter(col, value, debounced) {
    const st = this.state();
    if (String(value).trim()) st.filters[col] = value;
    else delete st.filters[col];
    this.states.save(this.active);
    if (!debounced) this.grid.header.setFilters(st.filters);
    if (this.grid.header.error && this.grid.header.error.col === col) this.grid.header.setError(null);
    if (debounced) this.scheduleView();
    else this.loadView();
  },

  setSearch(q, debounced) {
    this.state().search = q;
    if (this.searchInput.value !== q) this.searchInput.value = q;
    if (debounced) this.scheduleView();
    else this.loadView();
  },

  clearAll() {
    const st = this.state();
    st.filters = {};
    this.states.save(this.active);
    this.grid.header.setFilters({});
    this.setSearch('', false);
  },

  toggleSort(col, multi) {
    const st = this.state();
    const i = st.sort.findIndex((s) => s.col === col);
    const cur = i >= 0 ? st.sort[i].dir : null;
    const next = cur === null ? 'asc' : cur === 'asc' ? 'desc' : null;
    if (multi) {
      if (next === null) st.sort.splice(i, 1);
      else if (i >= 0) st.sort[i] = { col, dir: next };
      else st.sort.push({ col, dir: next });
    } else {
      st.sort = next === null ? [] : [{ col, dir: next }];
    }
    this.applySort();
  },

  setSort(col, dir) {
    const st = this.state();
    st.sort = dir ? [{ col, dir }] : st.sort.filter((s) => s.col !== col);
    this.applySort();
  },

  applySort() {
    this.states.save(this.active);
    this.grid.header.setSort(this.state().sort);
    this.loadView();
  },

  resizeColumn(col, width, done) {
    const st = this.state();
    st.widths[col] = width;
    this.grid.setWidths(st.widths);
    if (done) this.states.save(this.active);
  },

  setHidden(names) {
    const st = this.state();
    st.hidden = names;
    this.states.save(this.active);
    this.grid.setHidden(names);
    this.updateStatus();
  },

  columnMenu(col, x, y) {
    const st = this.state();
    const sorted = st.sort.some((s) => s.col === col);
    const visible = this.grid.layout ? this.grid.layout.cols.length : 0;
    const items = [
      { label: 'Sort ascending', action: () => this.setSort(col, 'asc') },
      { label: 'Sort descending', action: () => this.setSort(col, 'desc') },
      { label: 'Clear sort', disabled: !sorted, action: () => this.setSort(col, null) },
      'sep',
      { label: 'Filter…', hint: 'F', action: () => this.grid.focusFilter(col) },
      { label: 'Inspect column', hint: 'Alt-click', action: () => this.inspect(col) },
      { label: 'Fit width', action: () => this.resizeColumn(col, this.grid.fitWidth(col), true) },
      { label: 'Hide column', disabled: visible <= 1, action: () => this.setHidden([...st.hidden, col]) },
      'sep',
      { label: 'Copy name', action: () => copyText(col).then(() => toast(`Copied ${col}`, { timeout: 1400 })) },
    ];
    if (st.hidden.length) items.push({ label: `Show ${formatInt(st.hidden.length)} hidden`, action: () => this.setHidden([]) });
    openMenu(x, y, items);
  },

  hiddenMenu(anchor) {
    const st = this.state();
    const r = anchor.getBoundingClientRect();
    const items = st.hidden.map((name) => ({ label: name, hint: 'Show', action: () => this.setHidden(st.hidden.filter((h) => h !== name)) }));
    items.push('sep', { label: 'Show all columns', action: () => this.setHidden([]) });
    openMenu(r.left, r.top, items);
  },
};
