/** Row detail drawer: every field of one row as a key/value list with copy buttons and row stepping. */

import { el, copyText, toast } from './dom.js';
import { BADGE, formatInt, formatValue, rawText } from './format.js';

export class RowDrawer {
  constructor(host, { getRow, requestRow, columns, hidden, total, onStep, onClose }) {
    this.host = host;
    this.deps = { getRow, requestRow, columns, hidden, total, onStep, onClose };
    this.row = -1;
    this.title = el('h2.drawer-title');
    this.prev = el('button.icon-btn', { type: 'button', 'aria-label': 'Previous row', title: 'Previous row (↑)', text: '↑', onclick: () => onStep(-1) });
    this.next = el('button.icon-btn', { type: 'button', 'aria-label': 'Next row', title: 'Next row (↓)', text: '↓', onclick: () => onStep(1) });
    this.list = el('dl.kv');
    host.append(
      el('div.drawer-head', null, this.title, el('div.drawer-nav', null, this.prev, this.next,
        el('button.icon-btn', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', text: '×', onclick: () => onClose() }))),
      this.list,
      el('div.drawer-foot', null,
        el('button.btn', { type: 'button', text: 'Copy as JSON', onclick: () => this.copyRow('json') }),
        el('button.btn', { type: 'button', text: 'Copy as TSV', onclick: () => this.copyRow('tsv') })),
    );
    host.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (e.target.closest('.kv-value')) return;
        e.preventDefault();
        onStep(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    });
  }

  get isOpen() {
    return !this.host.hidden;
  }

  open(row) {
    this.host.hidden = false;
    this.show(row);
  }

  close() {
    this.host.hidden = true;
    this.row = -1;
  }

  show(row) {
    this.row = row;
    const data = this.deps.getRow(row);
    this.loaded = !!data;
    if (!data) this.deps.requestRow(row);
    const total = this.deps.total();
    this.title.textContent = `Row ${formatInt(row + 1)}`;
    this.title.title = `of ${formatInt(total)}`;
    this.prev.disabled = row <= 0;
    this.next.disabled = row >= total - 1;
    const hidden = this.deps.hidden();
    const items = [];
    for (const col of this.deps.columns()) {
      const v = data ? data[col.idx] : undefined;
      const value = el('dd.kv-value', { tabindex: '0', class: `k-${col.kind}` });
      if (!data) value.append(el('span.ph-bar'));
      else if (v === null || v === undefined) value.append(el('span.is-null', { text: 'null' }));
      else value.textContent = col.kind === 'bool' ? String(v) : formatValue(v, col.kind);
      items.push(
        el('div.kv-row', { class: hidden.has(col.name) ? 'is-hidden' : null },
          el('dt.kv-key', null, el('span.hbadge', { 'data-kind': col.kind, text: BADGE[col.kind] }), el('span.kv-name', { text: col.name, title: `${col.name} · ${col.type}` })),
          value,
          el('button.kv-copy', {
            type: 'button', 'aria-label': `Copy ${col.name}`, title: 'Copy value', text: 'Copy', disabled: !data,
            onclick: () => this.copy(rawText(v), col.name),
          })),
      );
    }
    this.list.replaceChildren(...items);
  }

  /** Re-render after the view changed under the drawer (new rows at the same index). */
  reload() {
    if (this.isOpen && this.row >= 0) this.show(Math.min(this.row, Math.max(0, this.deps.total() - 1)));
  }

  refresh() {
    if (this.isOpen && this.row >= 0 && !this.loaded) this.show(this.row);
  }

  async copy(text, label) {
    if (await copyText(text)) toast(`Copied ${label}`, { timeout: 1400 });
  }

  copyRow(format) {
    const data = this.deps.getRow(this.row);
    if (!data) return;
    const cols = this.deps.columns();
    let text;
    if (format === 'json') {
      const obj = {};
      for (const c of cols) obj[c.name] = data[c.idx];
      text = JSON.stringify(obj, null, 2);
    } else {
      text = cols.map((c) => c.name).join('\t') + '\n' + cols.map((c) => rawText(data[c.idx]).replace(/[\t\r\n]+/g, ' ')).join('\t');
    }
    this.copy(text, `row ${formatInt(this.row + 1)}`);
  }
}
