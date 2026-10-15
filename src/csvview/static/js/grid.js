/** Virtualized data grid: scaled vertical scroll, recycled row nodes, column windowing, cell selection. */

import { el } from './dom.js';
import { BlockCache } from './blocks.js';
import { Header, HEAD_HEIGHT } from './header.js';
import { formatValue, formatInt, highlight } from './format.js';
import { buildLayout, columnWindow, describeColumns, measureColumn, clampWidth } from './columns.js';

const ROW_HEIGHT = 28;
export const BLOCK_SIZE = 500;
const OVERSCAN = 10;
/** Browsers cap element heights near 16-33M px; past this the scroll space is scaled. */
const MAX_SCROLL_PX = 8_000_000;
/* Past MAX_SCROLL_PX the row layer is sticky at the viewport top and rows sit at small offsets from it,
   so no element ever carries a multi-million-pixel transform. */

function paintCell(cell, v, col, search, selected) {
  const base = selected ? `c k-${col.kind} is-sel` : `c k-${col.kind}`;
  if (v === null || v === undefined) {
    cell.className = `${base} is-null`;
    cell.textContent = 'null';
    return;
  }
  if (col.kind === 'bool' && typeof v === 'boolean') {
    cell.className = `${base} ${v ? 'is-true' : 'is-false'}`;
    cell.textContent = v ? '✓' : '✗';
    return;
  }
  const text = formatValue(v, col.kind);
  const html = search ? highlight(text, search) : null;
  cell.className = base;
  if (html) cell.innerHTML = html;
  else cell.textContent = text;
}

export class Grid {
  constructor(root, handlers) {
    this.h = handlers;
    this.root = root;
    root.classList.add('grid');
    root.tabIndex = 0;
    root.setAttribute('role', 'grid');
    this.header = new Header(root, {
      onSort: handlers.onSort,
      onFilter: handlers.onFilter,
      onFilterCommit: handlers.onFilterCommit,
      onFilterLeave: () => this.focus(),
      onFilterTab: (col, dir) => this.tabFilter(col, dir),
      onMenu: handlers.onHeaderMenu,
      onInspect: handlers.onInspect,
      onResize: (col, w, done) => handlers.onResize(col, Math.round(w), done),
      onAutoFit: (col) => handlers.onResize(col, this.fitWidth(col), true),
    });
    this.layer = el('div.grid-rows');
    this.body = el('div.grid-body', null, this.layer);
    root.append(this.body);
    this.cache = new BlockCache({
      size: BLOCK_SIZE,
      capacity: 60,
      fetch: handlers.fetchRows,
      onLoad: () => this.onBlock(),
      onMissing: handlers.onViewMissing,
      onError: handlers.onError,
    });
    this.columns = [];
    this.hidden = new Set();
    this.widths = {};
    this.auto = new Map();
    this.sourceKey = null;
    this.layout = null;
    this.total = 0;
    this.pool = [];
    this.ver = 0;
    this.colKey = '';
    this.c0 = 0;
    this.c1 = -1;
    this.sel = null;
    this.search = '';
    this.lastTop = 0;
    this.dir = 1;
    this.pin = null;
    this.scaled = false;
    this.frame = 0;
    this.metrics = { first: 0, last: -1, realTop: 0, viewH: 0, scaled: false, realMax: 0, virtMax: 0 };
    root.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(root);
    root.addEventListener('mousedown', (e) => this.onMouseDown(e));
    root.addEventListener('dblclick', (e) => {
      if (this.cellAt(e.target)) this.h.onOpenRow(this.sel.row);
    });
    root.addEventListener('keydown', (e) => this.h.onGridKey(e));
  }

  fonts() {
    const family = getComputedStyle(this.root).fontFamily;
    return { cell: `13px ${family}`, head: `600 12px ${family}`, badge: '500 10px ui-monospace, Menlo, monospace' };
  }

  setView({ view, total, columns, rows }, { sourceKey, hidden, widths, resetScroll }) {
    if (sourceKey !== this.sourceKey) {
      this.sourceKey = sourceKey;
      this.auto.clear();
      this.header.reset();
      this.sel = null;
      this.root.scrollLeft = 0;
    }
    this.total = total;
    this.columns = describeColumns(columns);
    this.hidden = new Set(hidden);
    this.widths = { ...widths };
    const fonts = this.fonts();
    const sampled = !!(rows && rows.length);
    for (const col of this.columns) {
      const known = this.auto.get(col.name);
      if (!known || (!known.sampled && sampled)) {
        this.auto.set(col.name, { width: measureColumn(col, rows || [], fonts), sampled });
      }
    }
    this.cache.reset(view, total, rows);
    if (resetScroll) {
      this.root.scrollTop = 0;
      this.lastTop = 0;
    }
    if (this.sel && this.sel.row >= total) this.sel = total ? { ...this.sel, row: total - 1 } : null;
    this.relayout();
  }

  rebind(viewId) {
    this.cache.rebind(viewId);
    this.ver += 1;
    this.schedule();
  }

  setHidden(hidden) {
    this.hidden = new Set(hidden);
    this.relayout();
  }

  setWidths(widths) {
    this.widths = { ...widths };
    this.relayout();
  }

  setSearch(q) {
    this.search = q;
    this.ver += 1;
    this.schedule();
  }

  setLoading(on) {
    this.root.classList.toggle('is-loading', on);
  }

  relayout() {
    const widthOf = (c) => (this.widths[c.name] != null ? this.widths[c.name] : (this.auto.get(c.name) || { width: 120 }).width);
    this.layout = buildLayout(this.columns, this.hidden, widthOf, this.total);
    const realH = this.total * ROW_HEIGHT;
    this.body.style.height = `${Math.min(realH, MAX_SCROLL_PX)}px`;
    this.body.style.width = `${this.layout.totalWidth}px`;
    this.root.style.setProperty('--gutter', `${this.layout.gutter}px`);
    this.c1 = -2;
    this.ver += 1;
    this.render();
  }

  schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  computeMetrics() {
    const viewH = Math.max(0, this.root.clientHeight - HEAD_HEIGHT);
    const st = this.root.scrollTop;
    const realH = this.total * ROW_HEIGHT;
    const virtH = Math.min(realH, MAX_SCROLL_PX);
    const scaled = realH > virtH;
    const realMax = Math.max(0, realH - viewH);
    const virtMax = Math.max(0, virtH - viewH);
    let realTop = st;
    if (scaled) {
      realTop = this.pin && this.pin.st === st ? this.pin.realTop : virtMax > 0 ? (st * realMax) / virtMax : 0;
    }
    realTop = Math.min(realTop, realMax);
    const first = Math.max(0, Math.floor(realTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.total - 1, Math.ceil((realTop + viewH) / ROW_HEIGHT) + OVERSCAN);
    return { st, viewH, scaled, realTop, realMax, virtMax, first, last };
  }

  render() {
    this.frame = 0;
    if (!this.layout) return;
    const m = this.computeMetrics();
    this.metrics = m;
    if (m.realTop !== this.lastTop) this.dir = m.realTop > this.lastTop ? 1 : -1;
    this.lastTop = m.realTop;
    this.cache.ensure(m.first, m.last, this.dir);

    const [c0, c1] = columnWindow(this.layout, this.root.scrollLeft, this.root.clientWidth);
    if (c0 !== this.c0 || c1 !== this.c1) {
      this.c0 = c0;
      this.c1 = c1;
      this.colKey = `${c0}:${c1}:${this.ver}`;
      this.header.render(this.layout, c0, c1);
    }

    if (m.scaled !== this.scaled) {
      this.scaled = m.scaled;
      this.layer.classList.toggle('is-scaled', m.scaled);
    }
    const shift = m.scaled ? m.realTop : 0;
    const count = m.last - m.first + 1;
    if (count > this.pool.length) this.growPool(count);
    const n = this.pool.length;
    for (let s = 0; s < n; s++) {
      const node = this.pool[s];
      const i = m.first + ((((s - m.first) % n) + n) % n);
      if (i > m.last || count <= 0) {
        if (node.row !== -1) {
          node.el.style.display = 'none';
          node.row = -1;
        }
        continue;
      }
      if (node.row === -1) node.el.style.display = '';
      const y = Math.round(i * ROW_HEIGHT - shift);
      if (node.y !== y) {
        node.el.style.transform = `translateY(${y}px)`;
        node.y = y;
      }
      if (node.row !== i || node.ver !== this.ver || node.colKey !== this.colKey) this.fillRow(node, i);
    }
  }

  growPool(count) {
    while (this.pool.length < count) {
      const num = el('div.gutter');
      const row = el('div.row', { role: 'row' }, num);
      const node = { el: row, num, cells: [], row: -1, y: null, ver: -1, colKey: '' };
      row._node = node;
      row.style.display = 'none';
      this.layer.append(row);
      this.pool.push(node);
    }
    for (const node of this.pool) {
      node.row = -1;
      node.el.style.display = 'none';
    }
  }

  layoutCells(node) {
    const need = Math.max(0, this.c1 - this.c0 + 1);
    while (node.cells.length < need) node.cells.push(node.el.appendChild(document.createElement('div')));
    while (node.cells.length > need) node.cells.pop().remove();
    const { gutter, lefts, widths, totalWidth } = this.layout;
    for (let j = 0; j < need; j++) {
      const k = this.c0 + j;
      const style = node.cells[j].style;
      style.left = `${gutter + lefts[k]}px`;
      style.width = `${widths[k]}px`;
    }
    node.el.style.width = `${totalWidth}px`;
    node.colKey = this.colKey;
  }

  fillRow(node, i) {
    if (node.colKey !== this.colKey) this.layoutCells(node);
    const row = this.cache.getRow(i);
    const selRow = this.sel && this.sel.row === i;
    node.row = i;
    node.ver = this.ver;
    node.el.className = `row${i & 1 ? ' odd' : ''}${row ? '' : ' ph'}${selRow ? ' is-sel' : ''}`;
    node.num.textContent = formatInt(i + 1);
    const cols = this.layout.cols;
    for (let j = 0, k = this.c0; k <= this.c1; j++, k++) {
      const cell = node.cells[j];
      const selected = selRow && this.sel.col === k;
      if (!row) {
        cell.className = selected ? 'c is-sel' : 'c';
        cell.textContent = '';
      } else {
        paintCell(cell, row[cols[k].idx], cols[k], this.search, selected);
      }
    }
  }

  onBlock() {
    this.ver += 1;
    this.schedule();
    if (this.h.onRowsLoaded) this.h.onRowsLoaded();
  }

  cellAt(target) {
    const rowEl = target.closest && target.closest('.row');
    if (!rowEl || !rowEl._node || rowEl._node.row < 0) return null;
    const node = rowEl._node;
    const j = node.cells.indexOf(target.closest('.c'));
    const col = j >= 0 ? this.c0 + j : this.sel ? this.sel.col : this.firstVisibleColumn();
    return { row: node.row, col };
  }

  onMouseDown(e) {
    if (e.button !== 0) return;
    const hit = this.cellAt(e.target);
    if (!hit) return;
    this.select(hit.row, hit.col, false);
    if (document.activeElement !== this.root) this.root.focus({ preventScroll: true });
  }

  select(row, col, scroll = true) {
    if (!this.layout || !this.total || !this.layout.cols.length) return;
    row = Math.max(0, Math.min(this.total - 1, row));
    col = Math.max(0, Math.min(this.layout.cols.length - 1, col));
    this.sel = { row, col, name: this.layout.cols[col].name };
    if (scroll) this.ensureVisible(row, col);
    this.paintSelection();
    this.h.onSelect(this.selection());
  }

  moveBy(dRow, dCol) {
    if (this.sel) this.select(this.sel.row + dRow, this.sel.col + dCol);
    else this.select(Math.ceil(this.metrics.realTop / ROW_HEIGHT), this.firstVisibleColumn());
  }

  firstVisibleColumn() {
    const [c0] = columnWindow(this.layout, this.root.scrollLeft, 0);
    const { lefts } = this.layout;
    let k = c0;
    while (k < this.layout.cols.length - 1 && lefts[k] < this.root.scrollLeft) k += 1;
    return k;
  }

  pageRows() {
    return Math.max(1, Math.floor(this.metrics.viewH / ROW_HEIGHT) - 1);
  }

  paintSelection() {
    const sel = this.sel;
    for (const node of this.pool) {
      if (node.row < 0) continue;
      const isRow = !!sel && node.row === sel.row;
      node.el.classList.toggle('is-sel', isRow);
      for (let j = 0; j < node.cells.length; j++) {
        node.cells[j].classList.toggle('is-sel', isRow && this.c0 + j === sel.col);
      }
    }
  }

  ensureVisible(row, col) {
    const m = this.computeMetrics();
    const top = row * ROW_HEIGHT;
    let target = null;
    if (top < m.realTop) target = top;
    else if (top + ROW_HEIGHT > m.realTop + m.viewH) target = top + ROW_HEIGHT - m.viewH;
    if (target != null) {
      if (m.scaled) {
        this.root.scrollTop = m.realMax > 0 ? (target * m.virtMax) / m.realMax : 0;
        this.pin = { st: this.root.scrollTop, realTop: target };
      } else {
        this.root.scrollTop = target;
      }
    }
    const { lefts, widths, gutter } = this.layout;
    const viewW = this.root.clientWidth - gutter;
    const sl = this.root.scrollLeft;
    if (lefts[col] < sl) this.root.scrollLeft = lefts[col];
    else if (lefts[col] + widths[col] > sl + viewW) this.root.scrollLeft = Math.min(lefts[col], lefts[col] + widths[col] - viewW);
    this.render();
  }

  selection() {
    if (!this.sel || !this.layout) return null;
    const col = this.layout.cols[this.sel.col];
    const row = this.cache.getRow(this.sel.row);
    return { row: this.sel.row, col, value: row ? row[col.idx] : undefined, loaded: !!row };
  }

  getRow(i) {
    return this.cache.getRow(i);
  }

  requestRow(i) {
    this.cache.ensure(i, i, 1);
  }

  allColumns() {
    return this.columns;
  }

  focus() {
    this.root.focus({ preventScroll: true });
  }

  scrollToColumn(name) {
    const k = this.layout && this.layout.index.get(name);
    if (k === undefined) return;
    const { lefts, widths, gutter } = this.layout;
    const viewW = this.root.clientWidth - gutter;
    const sl = this.root.scrollLeft;
    if (lefts[k] < sl || lefts[k] + widths[k] > sl + viewW) this.root.scrollLeft = Math.max(0, lefts[k] - 24);
    this.render();
  }

  focusFilter(name) {
    this.scrollToColumn(name);
    this.header.focusInput(name);
  }

  tabFilter(name, dir) {
    const k = this.layout.index.get(name);
    const next = this.layout.cols[k + dir];
    if (next) this.focusFilter(next.name);
  }

  fitWidth(name) {
    const col = this.columns.find((c) => c.name === name);
    if (!col) return 120;
    const rows = [];
    for (let i = this.metrics.first; i <= this.metrics.last; i++) {
      const r = this.cache.getRow(i);
      if (r) rows.push(r);
    }
    return clampWidth(measureColumn(col, rows, this.fonts()));
  }
}
