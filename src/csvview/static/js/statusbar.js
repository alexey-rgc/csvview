/** Status bar: row counts and timing, active filter chips, hidden-column chip, Open in SQL, selected cell preview. */

import { el } from './dom.js';
import { formatInt, formatMs, formatValue } from './format.js';

export class StatusBar {
  constructor(host, handlers) {
    this.h = handlers;
    this.counts = el('span.status-counts', { 'aria-live': 'polite' });
    this.spinner = el('span.spinner', { hidden: true, 'aria-label': 'Loading' });
    this.chips = el('div.status-chips');
    this.openSql = el('button.link-btn', { type: 'button', text: 'Open in SQL', title: 'Put the SQL behind this view in the editor', onclick: handlers.onOpenSql });
    this.preview = el('span.status-preview');
    host.append(el('div.status-left', null, this.spinner, this.counts), this.chips, el('span.spacer'), this.preview, this.openSql);
    this.openSql.hidden = true;
  }

  setLoading(on) {
    this.spinner.hidden = !on;
  }

  clear(message) {
    this.counts.textContent = message || '';
    this.chips.replaceChildren();
    this.preview.textContent = '';
    this.openSql.hidden = true;
  }

  update({ shown, total, ms, filters, search, hidden }) {
    const counts = total != null && total !== shown
      ? [el('strong', { text: formatInt(shown) }), ` of ${formatInt(total)} rows`]
      : [el('strong', { text: formatInt(shown) }), shown === 1 ? ' row' : ' rows'];
    this.counts.replaceChildren(...counts, el('span.status-ms', { text: ` · ${formatMs(ms)}` }));

    const chips = [];
    if (search) chips.push(this.chip('Search', search, () => this.h.onClearSearch()));
    for (const [col, expr] of Object.entries(filters)) {
      chips.push(this.chip(col, expr, () => this.h.onRemoveFilter(col)));
    }
    if (chips.length) {
      chips.push(el('button.link-btn', { type: 'button', text: 'Clear all', onclick: () => this.h.onClearAll() }));
    }
    if (hidden.length) {
      chips.push(el('button.chip.chip-hidden', {
        type: 'button', text: `${formatInt(hidden.length)} hidden`, title: 'Show hidden columns',
        onclick: (e) => this.h.onHiddenChip(e.currentTarget),
      }));
    }
    this.chips.replaceChildren(...chips);
    this.openSql.hidden = false;
  }

  chip(label, value, onRemove) {
    return el('span.chip', { title: `${label}: ${value}` },
      el('span.chip-key', { text: label }),
      el('span.chip-val', { text: value }),
      el('button.chip-x', { type: 'button', 'aria-label': `Remove ${label} filter`, text: '×', onclick: onRemove }));
  }

  setSelection(sel) {
    if (!sel) {
      this.preview.textContent = '';
      return;
    }
    const { col, value, loaded } = sel;
    const text = !loaded ? '…' : value === null || value === undefined ? 'null' : formatValue(value, col.kind);
    this.preview.replaceChildren(el('span.preview-key', { text: col.name }), el('span.preview-val', { text: text.length > 140 ? `${text.slice(0, 140)}…` : text, class: value === null ? 'is-null' : null }));
    this.preview.title = text;
  }
}
