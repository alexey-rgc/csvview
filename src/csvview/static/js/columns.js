/** Column layout for the grid: visible column list, pixel offsets, windowing and auto-width measurement. */

import { kindOf, formatValue, BADGE } from './format.js';

const MIN_WIDTH = 60;
const MAX_WIDTH = 360;
export const MIN_DRAG_WIDTH = 40;
export const MAX_DRAG_WIDTH = 1600;
const CELL_PAD = 24;
const HEADER_CHROME = 60;
const COL_OVERSCAN = 2;
const SAMPLE_ROWS = 300;

let ctx = null;
let ctxFont = '';

function textWidth(text, font) {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d');
  if (ctxFont !== font) {
    ctx.font = font;
    ctxFont = font;
  }
  return ctx.measureText(text).width;
}

export const clampWidth = (w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));

/** Width that fits the header and ~95% of sampled values, clamped to 60–360 px. */
export function measureColumn(col, rows, fonts) {
  const header = textWidth(col.name, fonts.head) + textWidth(BADGE[col.kind], fonts.badge) + HEADER_CHROME;
  const widths = [];
  const n = Math.min(rows.length, SAMPLE_ROWS);
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (!row) continue;
    const v = row[col.idx];
    widths.push(v == null ? 30 : textWidth(formatValue(v, col.kind), fonts.cell));
  }
  widths.sort((a, b) => a - b);
  const body = widths.length ? widths[Math.floor((widths.length - 1) * 0.95)] + CELL_PAD : 0;
  return clampWidth(Math.max(header, body));
}

export function describeColumns(columns) {
  return columns.map((c, idx) => ({ name: c.name, type: c.type, kind: kindOf(c.type), idx }));
}

function gutterWidth(total) {
  const digits = String(Math.max(1, total)).length;
  return Math.max(44, Math.ceil(digits * 7.4 + Math.floor((digits - 1) / 3) * 3 + 22));
}

export function buildLayout(allColumns, hidden, widthOf, total) {
  const cols = allColumns.filter((c) => !hidden.has(c.name));
  const lefts = new Array(cols.length);
  const widths = new Array(cols.length);
  const index = new Map();
  let x = 0;
  cols.forEach((c, k) => {
    lefts[k] = x;
    widths[k] = widthOf(c);
    index.set(c.name, k);
    x += widths[k];
  });
  const gutter = gutterWidth(total);
  return { cols, lefts, widths, index, gutter, dataWidth: x, totalWidth: gutter + x };
}

/** Inclusive [first, last] column indexes intersecting the horizontal viewport, plus overscan. */
export function columnWindow(layout, scrollLeft, viewWidth) {
  const { lefts, widths, cols } = layout;
  if (!cols.length) return [0, -1];
  const x0 = Math.max(0, scrollLeft);
  const x1 = scrollLeft + Math.max(0, viewWidth - layout.gutter);
  let lo = 0;
  let hi = cols.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lefts[mid] + widths[mid] <= x0) lo = mid + 1;
    else hi = mid;
  }
  let last = lo;
  while (last < cols.length - 1 && lefts[last + 1] < x1) last += 1;
  return [Math.max(0, lo - COL_OVERSCAN), Math.min(cols.length - 1, last + COL_OVERSCAN)];
}
