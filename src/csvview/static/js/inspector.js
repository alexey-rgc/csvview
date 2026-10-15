/** Column inspector side panel: summary statistics and clickable top values for one column of the current view. */

import { api, isAbort } from './api.js';
import { el } from './dom.js';
import { BADGE, kindOf, formatInt, formatValue } from './format.js';

const meanFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const pct = (part, whole) => (whole > 0 ? (100 * part) / whole : 0);
const pctText = (p) => (p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`);

export class Inspector {
  constructor(host, { onPick, onClose, total }) {
    this.host = host;
    this.onPick = onPick;
    this.total = total;
    this.col = null;
    this.viewId = null;
    this.ctrl = null;
    this.badge = el('span.hbadge');
    this.name = el('h2.insp-name');
    this.body = el('div.insp-body');
    host.append(
      el('div.insp-head', null, this.badge, this.name,
        el('button.icon-btn', { type: 'button', 'aria-label': 'Close inspector', title: 'Close', text: '×', onclick: onClose })),
      this.body,
    );
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    });
  }

  get isOpen() {
    return !this.host.hidden;
  }

  get column() {
    return this.col;
  }

  open(viewId, col) {
    this.host.hidden = false;
    this.col = col;
    this.viewId = viewId;
    this.load();
  }

  close() {
    this.host.hidden = true;
    if (this.ctrl) this.ctrl.abort();
    this.col = null;
  }

  viewChanged(viewId, columns) {
    this.viewId = viewId;
    if (!this.isOpen) return;
    if (!columns.some((c) => c.name === this.col.name)) {
      this.close();
      return;
    }
    this.load();
  }

  async load() {
    if (this.ctrl) this.ctrl.abort();
    const ctrl = (this.ctrl = new AbortController());
    const col = this.col;
    const kind = kindOf(col.type);
    this.badge.textContent = BADGE[kind];
    this.badge.dataset.kind = kind;
    this.name.textContent = col.name;
    this.name.title = `${col.name} · ${col.type}`;
    this.host.classList.add('is-loading');
    if (!this.body.childElementCount) this.body.append(this.skeleton());
    try {
      const stats = await api.column(this.viewId, col.name, ctrl.signal);
      if (ctrl !== this.ctrl) return;
      this.body.replaceChildren(...this.renderStats(stats, kindOf(stats.type || col.type)));
    } catch (err) {
      if (isAbort(err) || ctrl !== this.ctrl) return;
      this.body.replaceChildren(el('p.callout.is-error', { text: err.message }));
    } finally {
      if (ctrl === this.ctrl) this.host.classList.remove('is-loading');
    }
  }

  skeleton() {
    return el('div.insp-skeleton', null, ...Array.from({ length: 8 }, () => el('span.ph-bar')));
  }

  renderStats(s, kind) {
    const total = this.total();
    const fmt = (v) => (v === null || v === undefined ? '—' : formatValue(v, kind === 'bool' ? 'text' : kind));
    const nullPct = pct(s.nulls, total);
    const stat = (label, value, extra) =>
      el('div.stat', null, el('dt', { text: label }), el('dd', { title: String(value) }, value, extra || null));
    const stats = el('dl.stats', null,
      el('div.stat.stat-type', null, el('dt', { text: 'Type' }), el('dd.mono', { text: s.type || this.col.type })),
      stat('Count', formatInt(s.count)),
      stat('Distinct', formatInt(s.distinct)),
      stat('Nulls', `${formatInt(s.nulls)} · ${pctText(nullPct)}`,
        el('span.meter', { 'aria-hidden': 'true' }, el('span', { style: { width: `${Math.min(100, nullPct)}%` } }))),
      stat('Min', fmt(s.min)),
      stat('Max', fmt(s.max)),
      s.mean === null || s.mean === undefined ? null : stat('Mean', typeof s.mean === 'number' ? meanFmt.format(s.mean) : String(s.mean)),
    );
    const top = s.top || [];
    const max = top.reduce((m, t) => Math.max(m, t.count), 0);
    const list = el('ol.topvals', { 'aria-label': 'Most common values' });
    for (const t of top) {
      const isNull = t.value === null || t.value === undefined;
      list.append(el('li', null, el('button.topval', {
        type: 'button',
        title: isNull ? 'Filter to null' : `Filter to = ${t.value}`,
        onclick: () => this.onPick(this.col.name, t.value),
      },
      el('span.topval-bar', { style: { width: `${pct(t.count, max)}%` } }),
      el('span.topval-label', { class: isNull ? 'is-null' : null, text: isNull ? 'null' : formatValue(t.value, kind === 'bool' ? 'text' : kind) || '(empty)' }),
      el('span.topval-count', { text: formatInt(t.count), title: `${pctText(pct(t.count, total))} of rows` }))));
    }
    return [
      stats,
      el('h3.insp-section', null, 'Top values', el('span.insp-section-note', { text: top.length ? `${top.length} shown, click to filter` : '' })),
      top.length ? list : el('p.insp-empty', { text: 'No values in this view.' }),
    ];
  }
}
