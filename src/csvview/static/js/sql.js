/** SQL language support for the editor: tokenizer, highlight HTML and completion candidates. */

import { escapeHtml } from './format.js';

export const KEYWORDS = `select from where group by order having limit offset as and or not in is null like ilike
between case when then else end join left right inner outer full cross on using distinct union all
except intersect with insert into values update set delete create table view drop alter add column
replace if exists asc desc nulls first last true false cast over partition window qualify pivot
unpivot describe summarize show tables explain copy to temp temporary returning filter within
recursive materialized any some exclude rename sample glob similar natural lateral positional asof`.split(/\s+/);

export const FUNCTIONS = `count sum avg min max median mode quantile_cont quantile_disc stddev variance
count_distinct approx_count_distinct first last list string_agg array_agg arg_min arg_max bool_and
bool_or histogram coalesce nullif ifnull greatest least abs round floor ceil sqrt pow ln log log10 exp
lower upper length trim ltrim rtrim substr substring replace concat concat_ws split_part starts_with
ends_with contains strpos lpad rpad left right reverse regexp_matches regexp_replace regexp_extract
regexp_split_to_array strftime strptime date_trunc date_part date_diff date_add datediff extract year
month day hour minute second epoch now current_date current_timestamp make_date to_timestamp
try_cast typeof row_number rank dense_rank percent_rank ntile lag lead first_value last_value
unnest generate_series range read_csv read_csv_auto read_parquet read_json hash md5 uuid random
format printf list_value struct_pack len`.split(/\s+/);

const KEYWORD_SET = new Set(KEYWORDS);
const FUNCTION_SET = new Set(FUNCTIONS);

const TOKEN = /(--[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_$]*)|(\s+)|([\s\S])/gy;

/** Highlight HTML for the overlay `<pre>`; `names` is a lowercase Set of table and column names. */
export function highlightSql(text, names) {
  let out = '';
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text)) !== null) {
    const tok = m[0];
    const esc = escapeHtml(tok);
    if (m[1] || m[2]) out += `<span class="t-com">${esc}</span>`;
    else if (m[3]) out += `<span class="t-str">${esc}</span>`;
    else if (m[4]) out += `<span class="t-id">${esc}</span>`;
    else if (m[5]) out += `<span class="t-num">${esc}</span>`;
    else if (m[6]) {
      const lower = tok.toLowerCase();
      const next = text.slice(TOKEN.lastIndex).match(/^\s*\(/);
      if (KEYWORD_SET.has(lower) && !next) out += `<span class="t-kw">${esc}</span>`;
      else if (next && FUNCTION_SET.has(lower)) out += `<span class="t-fn">${esc}</span>`;
      else if (names.has(lower)) out += `<span class="t-id">${esc}</span>`;
      else if (KEYWORD_SET.has(lower)) out += `<span class="t-kw">${esc}</span>`;
      else out += esc;
    } else out += esc;
    if (TOKEN.lastIndex >= text.length) break;
  }
  return text.endsWith('\n') || text === '' ? `${out} ` : out;
}

export const quoteIdent = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORD_SET.has(name.toLowerCase()) ? name : `"${name.replace(/"/g, '""')}"`);

/**
 * Ranked completions for `prefix`. Each: { text, label, kind }.
 * schema: { tables: [{ name, columns: [{name,type}] }], active: name|null }
 */
export function completions(prefix, schema, limit = 10) {
  const p = prefix.toLowerCase();
  if (!p) return [];
  const seen = new Set();
  const out = [];
  const push = (label, kind, text = label, detail = '') => {
    const key = `${kind}:${label}`;
    if (seen.has(key) || !label.toLowerCase().startsWith(p) || label.toLowerCase() === p) return;
    seen.add(key);
    out.push({ label, kind, text, detail });
  };
  const tables = schema.tables || [];
  const active = tables.find((t) => t.name === schema.active);
  if (active) for (const c of active.columns) push(c.name, 'column', quoteIdent(c.name), c.type);
  for (const t of tables) push(t.name, 'table', t.name.includes('.') ? t.name : quoteIdent(t.name), t.label || '');
  for (const t of tables) if (t !== active) for (const c of t.columns) push(c.name, 'column', quoteIdent(c.name), t.label || t.name);
  for (const k of KEYWORDS) push(k, 'keyword', k.toUpperCase());
  for (const f of FUNCTIONS) push(f, 'function', `${f}(`);
  return out.slice(0, limit);
}

/** Lowercase names used to colour identifiers in the overlay. */
export function schemaNames(schema) {
  const names = new Set();
  for (const t of schema.tables || []) {
    names.add(t.name.toLowerCase());
    for (const c of t.columns) names.add(c.name.toLowerCase());
  }
  return names;
}
