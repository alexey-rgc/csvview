/** Column type classification, type badges and display formatting of cell values. */

const INT_TYPES = /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|INT1|INT2|INT4|INT8)\b/;
const FLOAT_TYPES = /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|FLOAT4|FLOAT8)\b/;
const TEMPORAL_TYPES = /^(DATE|TIME|TIMESTAMP|INTERVAL)/;

export function kindOf(type) {
  const t = String(type || '').toUpperCase();
  if (INT_TYPES.test(t)) return 'int';
  if (FLOAT_TYPES.test(t)) return 'float';
  if (TEMPORAL_TYPES.test(t)) return 'date';
  if (t === 'BOOLEAN' || t === 'BOOL') return 'bool';
  return 'text';
}

export const BADGE = { int: '123', float: '1.5', date: 'date', bool: 't/f', text: 'abc' };

const intFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const floatFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 });
const GROUP_SEP = intFmt.format(1000).replace(/\d/g, '') || ',';

export const formatInt = (n) => intFmt.format(n);

function groupDigits(text) {
  const m = /^(-?)(\d+)$/.exec(text);
  return m ? m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEP) : text;
}

function formatFloat(v) {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e21)) return v.toExponential(4);
  return floatFmt.format(v);
}

export function formatValue(v, kind) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (kind === 'int') return typeof v === 'number' ? intFmt.format(v) : groupDigits(String(v));
  if (kind === 'float') return typeof v === 'number' ? formatFloat(v) : String(v);
  if (kind === 'date') return String(v).replace('T', ' ');
  if (kind === 'bool' && typeof v === 'boolean') return v ? '✓' : '✗';
  return String(v);
}

/** The unformatted value as copied to the clipboard or used in filters. */
export function rawText(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** HTML with each case-insensitive occurrence of `query` wrapped in <mark>, or null when absent. */
export function highlight(text, query) {
  if (!query) return null;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let at = hay.indexOf(needle);
  if (at < 0) return null;
  let out = '';
  let from = 0;
  while (at >= 0) {
    out += escapeHtml(text.slice(from, at)) + '<mark>' + escapeHtml(text.slice(at, at + needle.length)) + '</mark>';
    from = at + needle.length;
    at = hay.indexOf(needle, from);
  }
  return out + escapeHtml(text.slice(from));
}

export function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** A filter expression matching exactly this value (null maps to the `null` keyword). */
export function exactFilter(value) {
  return value === null || value === undefined ? 'null' : `=${rawText(value).replace(/[|&]/g, '\\$&')}`;
}
