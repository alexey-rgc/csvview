/** Keyboard bindings: global shortcuts on the document and cell navigation keys on the focused grid. */

import { isMod, isTyping } from './dom.js';
import { isMenuOpen } from './menu.js';

export function bindKeys(app) {
  const focusSearch = () => {
    app.searchInput.focus();
    app.searchInput.select();
  };

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || isMenuOpen()) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const typing = isTyping(e.target);
    if (isMod(e) && !e.shiftKey && !e.altKey) {
      if (key === 'k') {
        e.preventDefault();
        focusSearch();
      } else if (key === 'e') {
        e.preventDefault();
        app.toggleSql();
      } else if (key === 'o') {
        e.preventDefault();
        app.intake.pick();
      }
      return;
    }
    if (key === 'Escape') {
      escape(e);
      return;
    }
    if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === '/') {
      e.preventDefault();
      focusSearch();
    } else if (e.key === '?') {
      e.preventDefault();
      app.shortcuts.toggle();
    }
  });

  function escape(e) {
    if (app.shortcuts.isOpen) {
      e.preventDefault();
      app.shortcuts.close();
    } else if (e.target === app.searchInput) {
      e.preventDefault();
      if (app.searchInput.value) app.setSearch('', false);
      else app.grid.focus();
    } else if (app.editor.isOpen && app.editor.host.contains(e.target)) {
      e.preventDefault();
      app.grid.focus();
    } else if (app.drawer.isOpen) {
      e.preventDefault();
      app.drawer.close();
      app.grid.focus();
    } else if (app.inspector.isOpen && !isTyping(e.target)) {
      e.preventDefault();
      app.inspector.close();
    }
  }

  function grid(e) {
    if (e.target !== app.grid.root) return;
    const g = app.grid;
    if (!g.layout || !g.total) return;
    const mod = isMod(e);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && key === 'c') {
      if (String(window.getSelection() || '')) return;
      e.preventDefault();
      app.copySelection(e.shiftKey);
      return;
    }
    if (e.altKey || (e.ctrlKey && !mod)) return;
    const sel = g.sel;
    const col = sel ? sel.col : g.firstVisibleColumn();
    const lastRow = g.total - 1;
    const lastCol = g.layout.cols.length - 1;
    switch (key) {
      case 'ArrowDown': if (mod) g.select(lastRow, col); else g.moveBy(1, 0); break;
      case 'ArrowUp': if (mod) g.select(0, col); else g.moveBy(-1, 0); break;
      case 'ArrowRight': if (mod) g.select(sel ? sel.row : 0, lastCol); else g.moveBy(0, 1); break;
      case 'ArrowLeft': if (mod) g.select(sel ? sel.row : 0, 0); else g.moveBy(0, -1); break;
      case 'PageDown': g.moveBy(g.pageRows(), 0); break;
      case 'PageUp': g.moveBy(-g.pageRows(), 0); break;
      case 'Home': g.select(0, col); break;
      case 'End': g.select(lastRow, col); break;
      case 'Enter': if (sel) app.drawer.open(sel.row); else g.moveBy(0, 0); break;
      case 'i': if (sel) app.inspect(g.layout.cols[sel.col].name); break;
      case 'f': g.focusFilter(g.layout.cols[col].name); break;
      default: return;
    }
    e.preventDefault();
  }

  return { grid };
}
