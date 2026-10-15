/** Grid header: column names, type badges, sort marks, filter inputs, resize handles, filter error tip. */

import { el } from './dom.js';
import { BADGE } from './format.js';
import { MIN_DRAG_WIDTH, MAX_DRAG_WIDTH } from './columns.js';

export const HEAD_HEIGHT = 62;

export class Header {
  constructor(host, handlers) {
    this.h = handlers;
    this.nodes = new Map();
    this.sort = [];
    this.filters = {};
    this.error = null;
    this.layout = null;
    this.corner = el('div.head-corner', { title: 'Row number' }, el('span', { text: '#' }));
    this.layer = el('div.head-cells');
    this.tip = el('div.filter-tip', { role: 'alert', hidden: true });
    this.root = el('div.head', null, this.corner, this.layer, this.tip);
    host.append(this.root);
    this.bind();
  }

  bind() {
    const colOf = (e) => e.target.closest('.hcell')?.dataset.col;
    this.root.addEventListener('mousedown', (e) => {
      if (e.target.closest('.hname') && e.shiftKey) e.preventDefault();
    });
    this.root.addEventListener('click', (e) => {
      const col = colOf(e);
      if (col == null || e.target.closest('.hresize, .hfilter')) return;
      if (e.target.closest('.hmenu')) {
        const r = e.target.closest('.hmenu').getBoundingClientRect();
        this.h.onMenu(col, r.left, r.bottom + 4);
      } else if (e.altKey) {
        this.h.onInspect(col);
      } else {
        this.h.onSort(col, e.shiftKey);
      }
    });
    this.root.addEventListener('contextmenu', (e) => {
      const col = colOf(e);
      if (col == null || e.target.closest('.hfilter')) return;
      e.preventDefault();
      this.h.onMenu(col, e.clientX, e.clientY);
    });
    this.root.addEventListener('dblclick', (e) => {
      const col = colOf(e);
      if (col != null && e.target.closest('.hresize')) this.h.onAutoFit(col);
    });
    this.root.addEventListener('pointerdown', (e) => this.startResize(e));
    this.root.addEventListener('input', (e) => {
      const col = colOf(e);
      if (col == null) return;
      this.filters[col] = e.target.value;
      e.target.closest('.hcell').classList.toggle('is-filtered', !!e.target.value.trim());
      this.h.onFilter(col, e.target.value);
    });
    this.root.addEventListener('keydown', (e) => this.onInputKey(e));
  }

  onInputKey(e) {
    const col = e.target.closest('.hcell')?.dataset.col;
    if (col == null || !e.target.matches('input')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.h.onFilterCommit(col);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.value) {
        e.target.value = '';
        e.target.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        this.h.onFilterLeave();
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.h.onFilterTab(col, e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.h.onFilterLeave();
    }
  }

  startResize(e) {
    const handle = e.target.closest('.hresize');
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    const col = handle.closest('.hcell').dataset.col;
    const k = this.layout.index.get(col);
    const startX = e.clientX;
    const startW = this.layout.widths[k];
    let width = startW;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing');
    const move = (ev) => {
      width = Math.max(MIN_DRAG_WIDTH, Math.min(MAX_DRAG_WIDTH, startW + ev.clientX - startX));
      this.h.onResize(col, width, false);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing');
      if (width !== startW) this.h.onResize(col, width, true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  reset() {
    for (const node of this.nodes.values()) node.cell.remove();
    this.nodes.clear();
    this.error = null;
    this.tip.hidden = true;
  }

  nodeFor(col) {
    let node = this.nodes.get(col.name);
    if (!node) {
      const badge = el('span.hbadge');
      const sort = el('span.hsort');
      const input = el('input.finput', {
        type: 'text', placeholder: 'filter…', spellcheck: 'false', autocomplete: 'off',
        'aria-label': `Filter ${col.name}`,
      });
      const cell = el('div.hcell', { 'data-col': col.name },
        el('div.hname', null, badge, el('span.hlabel', { text: col.name }), sort,
          el('button.hmenu', { type: 'button', tabindex: '-1', 'aria-label': `${col.name} menu`, text: '⋯' })),
        el('div.hfilter', null, input),
        el('div.hresize', { title: 'Drag to resize, double-click to fit' }));
      node = { cell, badge, sort, input, type: null, x: null, w: null };
      input.value = this.filters[col.name] || '';
      this.nodes.set(col.name, node);
    }
    if (node.type !== col.type) {
      node.type = col.type;
      node.badge.textContent = BADGE[col.kind];
      node.badge.dataset.kind = col.kind;
      node.cell.querySelector('.hname').title = `${col.name}  ·  ${col.type}\nClick to sort, Shift+click to add, Alt+click to inspect`;
      node.cell.classList.toggle('is-num', col.kind === 'int' || col.kind === 'float');
    }
    this.paintNode(col.name, node);
    return node;
  }

  render(layout, c0, c1) {
    this.layout = layout;
    this.root.style.width = `${layout.totalWidth}px`;
    this.corner.style.width = `${layout.gutter}px`;
    const keep = new Set();
    for (let k = c0; k <= c1; k++) keep.add(layout.cols[k].name);
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.hcell');
    if (focused && layout.index.has(focused.dataset.col)) keep.add(focused.dataset.col);
    for (const [name, node] of this.nodes) {
      if (!keep.has(name) && node.cell.isConnected) node.cell.remove();
    }
    for (const name of keep) {
      const k = layout.index.get(name);
      const node = this.nodeFor(layout.cols[k]);
      const x = layout.gutter + layout.lefts[k];
      const w = layout.widths[k];
      if (node.x !== x) node.cell.style.transform = `translateX(${x}px)`;
      if (node.w !== w) node.cell.style.width = `${w}px`;
      node.x = x;
      node.w = w;
      if (!node.cell.isConnected) this.layer.append(node.cell);
    }
    this.placeTip();
  }

  paintNode(name, node) {
    const i = this.sort.findIndex((s) => s.col === name);
    node.cell.classList.toggle('is-sorted', i >= 0);
    node.sort.textContent = i < 0 ? '' : (this.sort[i].dir === 'asc' ? '↑' : '↓') + (this.sort.length > 1 ? String(i + 1) : '');
    node.cell.classList.toggle('is-filtered', !!(this.filters[name] || '').trim());
    node.cell.classList.toggle('has-error', !!this.error && this.error.col === name);
  }

  setSort(sort) {
    this.sort = sort;
    for (const [name, node] of this.nodes) this.paintNode(name, node);
  }

  setFilters(filters) {
    this.filters = { ...filters };
    for (const [name, node] of this.nodes) {
      const value = this.filters[name] || '';
      if (node.input.value !== value) node.input.value = value;
      this.paintNode(name, node);
    }
  }

  setError(col, message) {
    this.error = col ? { col, message } : null;
    for (const [name, node] of this.nodes) this.paintNode(name, node);
    this.placeTip();
  }

  placeTip() {
    const err = this.error;
    const k = err && this.layout ? this.layout.index.get(err.col) : undefined;
    if (k === undefined) {
      this.tip.hidden = true;
      return;
    }
    this.tip.textContent = err.message;
    this.tip.style.transform = `translateX(${this.layout.gutter + this.layout.lefts[k]}px)`;
    this.tip.hidden = false;
  }

  focusInput(name) {
    const node = this.nodes.get(name);
    if (!node) return;
    node.input.focus({ preventScroll: true });
    node.input.select();
  }
}
