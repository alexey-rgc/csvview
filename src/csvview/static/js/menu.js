/** Popover menu: one open at a time, keyboard navigable, closes on outside click, Esc, blur or resize. */

import { el } from './dom.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  const { node, cleanup, restoreFocus } = current;
  current = null;
  cleanup();
  node.remove();
  if (restoreFocus && document.contains(restoreFocus)) restoreFocus.focus({ preventScroll: true });
}

export const isMenuOpen = () => !!current;

/**
 * items: [{ label, hint?, action, danger?, disabled?, mono? } | 'sep' | { heading }]
 */
export function openMenu(x, y, items, { minWidth = 180, className = '' } = {}) {
  closeMenu();
  const buttons = [];
  const node = el('div.menu', { role: 'menu', class: className, style: { minWidth: `${minWidth}px` } });
  for (const item of items) {
    if (item === 'sep') {
      node.append(el('div.menu-sep', { role: 'separator' }));
    } else if (item.heading) {
      node.append(el('div.menu-heading', { text: item.heading }));
    } else {
      const btn = el('button.menu-item', {
        type: 'button', role: 'menuitem', disabled: item.disabled,
        class: [item.danger ? 'is-danger' : '', item.mono ? 'is-mono' : ''].join(' '),
        title: item.title,
      },
      el('span.menu-label', { text: item.label }),
      item.hint ? el('span.menu-hint', { text: item.hint }) : null);
      btn.addEventListener('click', () => {
        closeMenu();
        item.action();
      });
      node.append(btn);
      buttons.push(btn);
    }
  }
  document.body.append(node);
  const r = node.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  node.style.top = `${Math.max(8, y + r.height > window.innerHeight - 8 ? y - r.height - 8 : y)}px`;

  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = buttons[(i + step + buttons.length) % buttons.length] || buttons[0];
      if (next) next.focus();
    }
  };
  const onDown = (e) => {
    if (!node.contains(e.target)) closeMenu();
  };
  const onBlur = () => closeMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  current = {
    node,
    restoreFocus: document.activeElement,
    cleanup() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    },
  };
  const first = buttons.find((b) => !b.disabled);
  if (first) first.focus({ preventScroll: true });
}
