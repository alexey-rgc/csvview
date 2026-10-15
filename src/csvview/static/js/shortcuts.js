/** Keyboard shortcuts overlay (opened with ?). */

import { el, MOD } from './dom.js';

const GROUPS = [
  ['General', [
    ['/', 'Focus search'],
    [`${MOD}K`, 'Focus search'],
    ['Esc', 'Clear search, close panel'],
    [`${MOD}E`, 'Toggle SQL panel'],
    [`${MOD}O`, 'Open a CSV file'],
    ['?', 'Show this list'],
  ]],
  ['Grid', [
    ['↑ ↓ ← →', 'Move the selected cell'],
    ['PgUp PgDn', 'Move by a page'],
    ['Home End', 'First or last row'],
    [`${MOD}← ${MOD}→`, 'First or last column'],
    ['Enter', 'Open row details'],
    [`${MOD}C`, 'Copy cell'],
    [`⇧${MOD}C`, 'Copy row as TSV'],
    ['F', 'Filter the selected column'],
    ['I', 'Inspect the selected column'],
  ]],
  ['Columns', [
    ['Click', 'Sort: ascending, descending, off'],
    ['⇧ Click', 'Add to multi-column sort'],
    ['Alt Click', 'Inspect column'],
    ['Right-click', 'Column menu'],
    ['Double-click edge', 'Fit width to content'],
  ]],
  ['SQL', [
    [`${MOD}Enter`, 'Run selection, or everything'],
    ['Tab Enter', 'Accept a completion'],
    ['Ctrl Space', 'Show completions'],
  ]],
];

const SYNTAX = [
  ['abc', 'contains'], ['=abc', 'equals'], ['!abc', 'does not contain'], ['>5  <=5', 'compare'],
  ['5..10', 'range'], ['^abc  abc$', 'starts / ends with'], ['/re/', 'regex'], ['null  !null', 'empty or not'],
  ['a | b', 'either'], ['a & b', 'both'],
];

export class ShortcutsOverlay {
  constructor(host) {
    this.host = host;
    const keys = (combo) => combo.split(' ').map((k) => el('kbd', { text: k }));
    const card = el('div.modal-card', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcuts-title', tabindex: '-1' },
      el('div.modal-head', null,
        el('h2', { id: 'shortcuts-title', text: 'Keyboard shortcuts' }),
        el('button.icon-btn', { type: 'button', 'aria-label': 'Close', text: '×', onclick: () => this.close() })),
      el('div.shortcut-grid', null,
        ...GROUPS.map(([title, rows]) => el('section.shortcut-group', null,
          el('h3', { text: title }),
          el('dl', null, ...rows.flatMap(([combo, what]) => [el('dt', null, ...keys(combo)), el('dd', { text: what })])))),
        el('section.shortcut-group', null,
          el('h3', { text: 'Filter syntax' }),
          el('dl', null, ...SYNTAX.flatMap(([ex, what]) => [el('dt', null, el('code', { text: ex })), el('dd', { text: what })])))));
    host.append(card);
    this.card = card;
    host.addEventListener('mousedown', (e) => {
      if (e.target === host) this.close();
    });
  }

  get isOpen() {
    return !this.host.hidden;
  }

  open() {
    this.restore = document.activeElement;
    this.host.hidden = false;
    this.card.focus();
  }

  close() {
    this.host.hidden = true;
    if (this.restore && document.contains(this.restore)) this.restore.focus({ preventScroll: true });
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}
