/** Per-source view state (filters, sort, hidden columns, widths, search): in memory; all but search persisted for tables. */

import { store } from './dom.js';

const blank = () => ({ filters: {}, sort: [], hidden: [], widths: {}, search: '' });

const isQuerySource = (source) => source.startsWith('_cv.');

function revive(saved) {
  const s = blank();
  if (!saved || typeof saved !== 'object') return s;
  if (saved.filters && typeof saved.filters === 'object') s.filters = { ...saved.filters };
  if (Array.isArray(saved.sort)) s.sort = saved.sort.filter((x) => x && x.col && (x.dir === 'asc' || x.dir === 'desc'));
  if (Array.isArray(saved.hidden)) s.hidden = saved.hidden.filter((x) => typeof x === 'string');
  if (saved.widths && typeof saved.widths === 'object') s.widths = { ...saved.widths };
  return s;
}

export class SourceStates {
  constructor() {
    this.states = new Map();
  }

  get(source) {
    let s = this.states.get(source);
    if (!s) {
      s = isQuerySource(source) ? blank() : revive(store.get(`src.${source}`, null));
      this.states.set(source, s);
    }
    return s;
  }

  save(source) {
    if (isQuerySource(source)) return;
    const { filters, sort, hidden, widths } = this.get(source);
    store.set(`src.${source}`, { filters, sort, hidden, widths });
  }

  /** Drop references to columns the source no longer has (the CSV changed since last time). */
  sanitize(source, columns) {
    const names = new Set(columns.map((c) => c.name));
    const s = this.get(source);
    for (const k of Object.keys(s.filters)) if (!names.has(k) || !String(s.filters[k]).trim()) delete s.filters[k];
    for (const k of Object.keys(s.widths)) if (!names.has(k)) delete s.widths[k];
    s.sort = s.sort.filter((x) => names.has(x.col));
    s.hidden = s.hidden.filter((x) => names.has(x));
    this.save(source);
  }

  drop(source) {
    this.states.delete(source);
  }
}

export const activeFilters = (filters) =>
  Object.fromEntries(Object.entries(filters).filter(([, v]) => String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
