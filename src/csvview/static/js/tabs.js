/** Source tabs in the top bar: one chip per table with its row count, plus closable query-result chips. */

import { el } from './dom.js';
import { formatInt } from './format.js';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export class SourceTabs {
  constructor(host, { onSelect, onClose }) {
    this.host = host;
    this.onSelect = onSelect;
    this.onClose = onClose;
    host.setAttribute('role', 'tablist');
    host.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-source]');
      if (!tab) return;
      if (e.target.closest('.tab-x')) this.onClose(tab.dataset.source);
      else this.onSelect(tab.dataset.source);
    });
    host.addEventListener('keydown', (e) => {
      const tab = e.target.closest('[data-source]');
      if (tab && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.onSelect(tab.dataset.source);
      }
    });
    host.addEventListener('auxclick', (e) => {
      const tab = e.target.closest('.tab.is-query');
      if (tab && e.button === 1) this.onClose(tab.dataset.source);
    });
  }

  render(tables, queries, active) {
    const tab = (source, label, rows, isQuery, title) =>
      el('div.tab', {
        class: [isQuery ? 'is-query' : '', source === active ? 'is-active' : ''].join(' '),
        role: 'tab', 'aria-selected': String(source === active), 'data-source': source, title, tabindex: '0',
      },
      el('span.tab-name', { text: label }),
      rows == null ? null : el('span.tab-count', { text: compact.format(rows) }),
      isQuery ? el('button.tab-x', { type: 'button', 'aria-label': `Close ${label}`, tabindex: '-1', text: '×' }) : null);
    this.host.replaceChildren(
      ...tables.map((t) => tab(t.name, t.name, t.rows, false, `${t.name}: ${formatInt(t.rows)} rows, ${t.columns.length} columns${t.file ? `\n${t.file}` : ''}`)),
      ...queries.map((q) => tab(q.source, q.label, q.rows, true, q.sql)),
    );
    const current = this.host.querySelector('.is-active');
    if (current) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
