/** SQL panel: textarea with highlight overlay, autocomplete, Cmd+Enter run, history, inline errors, resizable height. */

import { el, store, debounce, isMod, MOD } from './dom.js';
import { openMenu } from './menu.js';
import { highlightSql, completions, schemaNames } from './sql.js';

const HISTORY_MAX = 50;
const MIN_HEIGHT = 120;
const WORD_BEFORE_CARET = /[A-Za-z_][A-Za-z0-9_.]*$/;

export class SqlEditor {
  constructor(host, { onRun, onClose }) {
    this.host = host;
    this.onRun = onRun;
    this.schema = { tables: [], active: null };
    this.names = new Set();
    this.items = [];
    this.active = 0;
    this.busy = false;

    this.runBtn = el('button.btn.btn-primary.run-btn', { type: 'button', title: `Run (${MOD}Enter)`, onclick: () => this.run() },
      el('span.run-label', { text: 'Run' }), el('kbd', { text: `${MOD}↵` }));
    this.historyBtn = el('button.btn', { type: 'button', text: 'History', 'aria-haspopup': 'menu', onclick: () => this.showHistory() });
    this.status = el('span.sql-status', { 'aria-live': 'polite' });
    this.code = el('code');
    this.pre = el('pre.sql-hl', { 'aria-hidden': 'true' }, this.code);
    this.input = el('textarea.sql-input', {
      spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off',
      'aria-label': 'SQL query', placeholder: 'Write SQL here. Each table is named after its file.',
    });
    this.ac = el('ul.ac', { role: 'listbox', hidden: true });
    this.error = el('div.callout.is-error.sql-error', { role: 'alert', hidden: true });
    const grip = el('div.sql-grip', { title: 'Drag to resize', 'aria-hidden': 'true' });
    host.append(
      el('div.sql-toolbar', null, this.runBtn, this.historyBtn, this.status, el('span.spacer'),
        el('button.icon-btn', { type: 'button', 'aria-label': 'Close SQL panel', title: `Close (${MOD}E)`, text: '×', onclick: onClose })),
      el('div.sql-wrap', null, this.pre, this.input, this.ac),
      this.error,
      grip,
    );
    host.style.height = `${store.get('sqlHeight', 220)}px`;
    this.input.value = store.get('sqlDraft', '');
    this.saveDraft = debounce(() => store.set('sqlDraft', this.input.value), 400);
    this.bind(grip);
    this.paint();
  }

  bind(grip) {
    this.input.addEventListener('input', (e) => {
      this.paint();
      this.saveDraft();
      if (e.inputType && e.inputType.startsWith('insert') && e.inputType !== 'insertLineBreak') this.suggest();
      else this.closeAc();
    });
    this.input.addEventListener('scroll', () => {
      this.pre.scrollTop = this.input.scrollTop;
      this.pre.scrollLeft = this.input.scrollLeft;
      this.closeAc();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.closeAc(), 100));
    this.input.addEventListener('click', () => this.closeAc());
    this.ac.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      e.preventDefault();
      this.accept(Number(li.dataset.i));
    });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = this.host.offsetHeight;
      document.body.classList.add('is-resizing-v');
      const move = (ev) => {
        const max = Math.round(window.innerHeight * 0.7);
        this.host.style.height = `${Math.max(MIN_HEIGHT, Math.min(max, startH + ev.clientY - startY))}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        document.body.classList.remove('is-resizing-v');
        store.set('sqlHeight', this.host.offsetHeight);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }

  onKey(e) {
    const acOpen = !this.ac.hidden;
    if (acOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      this.highlightItem(this.active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (acOpen && (e.key === 'Enter' || e.key === 'Tab') && !isMod(e)) {
      e.preventDefault();
      this.accept(this.active);
    } else if (acOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeAc();
    } else if (e.key === 'Enter' && isMod(e)) {
      e.preventDefault();
      this.run();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      this.insert('  ');
    } else if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      this.suggest(true);
    }
  }

  insert(text) {
    if (!document.execCommand('insertText', false, text)) {
      this.input.setRangeText(text, this.input.selectionStart, this.input.selectionEnd, 'end');
      this.paint();
    }
  }

  paint() {
    this.code.innerHTML = highlightSql(this.input.value, this.names);
  }

  setSchema(schema) {
    this.schema = schema;
    this.names = schemaNames(schema);
    this.paint();
  }

  suggest(force = false) {
    const caret = this.input.selectionStart;
    if (caret !== this.input.selectionEnd) return this.closeAc();
    const before = this.input.value.slice(0, caret);
    const m = WORD_BEFORE_CARET.exec(before);
    const prefix = m ? m[0] : '';
    if (!prefix || (/^\d/.test(prefix) && !force)) return this.closeAc();
    this.items = completions(prefix, this.schema);
    this.prefix = prefix;
    if (!this.items.length) return this.closeAc();
    this.ac.replaceChildren(...this.items.map((it, i) =>
      el('li', { role: 'option', 'data-i': String(i), class: `ac-${it.kind}` },
        el('span.ac-label', { text: it.label }), el('span.ac-detail', { text: it.detail || it.kind }))));
    this.ac.hidden = false;
    this.highlightItem(0);
    this.placeAc(before);
  }

  placeAc(before) {
    const cs = getComputedStyle(this.input);
    const lineH = parseFloat(cs.lineHeight) || 20;
    const lines = before.split('\n');
    const col = lines[lines.length - 1].length - this.prefix.length;
    const charW = this.charWidth(cs.font);
    const x = parseFloat(cs.paddingLeft) + col * charW - this.input.scrollLeft;
    const y = parseFloat(cs.paddingTop) + lines.length * lineH - this.input.scrollTop + 2;
    const maxX = this.input.clientWidth - this.ac.offsetWidth - 4;
    this.ac.style.transform = `translate(${Math.max(4, Math.min(x, maxX))}px, ${y}px)`;
  }

  charWidth(font) {
    if (this.charW && this.charFont === font) return this.charW;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = font;
    this.charFont = font;
    this.charW = ctx.measureText('0000000000').width / 10;
    return this.charW;
  }

  highlightItem(i) {
    const n = this.items.length;
    this.active = ((i % n) + n) % n;
    [...this.ac.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === this.active)));
    const li = this.ac.children[this.active];
    if (li) li.scrollIntoView({ block: 'nearest' });
  }

  accept(i) {
    const item = this.items[i];
    if (!item) return;
    const end = this.input.selectionStart;
    this.input.setSelectionRange(end - this.prefix.length, end);
    this.insert(item.text);
    this.closeAc();
  }

  closeAc() {
    if (!this.ac.hidden) this.ac.hidden = true;
  }

  run() {
    if (this.busy) return;
    const { value, selectionStart: a, selectionEnd: b } = this.input;
    const sql = (a !== b ? value.slice(a, b) : value).trim();
    if (!sql) return;
    this.closeAc();
    this.remember(sql);
    this.onRun(sql);
  }

  remember(sql) {
    const history = store.get('history', []).filter((h) => h.sql !== sql);
    history.unshift({ sql, at: Date.now() });
    store.set('history', history.slice(0, HISTORY_MAX));
  }

  showHistory() {
    const history = store.get('history', []);
    const r = this.historyBtn.getBoundingClientRect();
    const items = history.length
      ? history.map((h) => ({
        label: h.sql.replace(/\s+/g, ' ').slice(0, 90),
        title: h.sql,
        mono: true,
        action: () => this.setText(h.sql),
      }))
      : [{ label: 'No queries run yet', disabled: true, action: () => {} }];
    if (history.length) items.push('sep', { label: 'Clear history', danger: true, action: () => store.remove('history') });
    openMenu(r.left, r.bottom + 4, items, { minWidth: 360, className: 'menu-history' });
  }

  setText(sql) {
    this.input.focus();
    this.input.select();
    this.insert(sql);
    this.closeAc();
    this.input.setSelectionRange(sql.length, sql.length);
    this.input.scrollTop = 0;
    this.paint();
    this.saveDraft();
  }

  setBusy(on) {
    this.busy = on;
    this.runBtn.classList.toggle('is-busy', on);
    this.runBtn.disabled = on;
    this.input.setAttribute('aria-busy', String(on));
  }

  setError(message) {
    this.error.textContent = message || '';
    this.error.hidden = !message;
  }

  setStatus(text) {
    this.status.textContent = text || '';
  }

  get isOpen() {
    return !this.host.hidden;
  }

  open() {
    this.host.hidden = false;
    this.input.focus();
  }

  close() {
    this.closeAc();
    this.host.hidden = true;
  }

  focus() {
    this.input.focus();
  }
}
