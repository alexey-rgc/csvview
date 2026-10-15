/** Shared browser helpers: element builder, guarded localStorage, clipboard, debounce, toasts. */

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl+';

export const isMod = (e) => (isMac ? e.metaKey : e.ctrlKey);

export function el(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.classList.add(...String(value).split(' ').filter(Boolean));
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

const PREFIX = 'csvview.';

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* storage full or blocked: state stays in memory */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* blocked storage */
    }
  },
};

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function debounce(fn, ms) {
  let timer = 0;
  let lastArgs = null;
  const wrapped = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      fn(...lastArgs);
    }, ms);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };
  wrapped.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    fn(...lastArgs);
  };
  return wrapped;
}

export const isTyping = (target) =>
  !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

let toastHost = null;

export function toast(message, { kind = 'info', timeout = 2600 } = {}) {
  if (!toastHost) toastHost = document.body.appendChild(el('div.toasts', { 'aria-live': 'polite' }));
  const msg = el('span.toast-msg', { text: message });
  const node = el('div.toast', { class: kind === 'error' ? 'is-error' : null, role: kind === 'error' ? 'alert' : 'status' }, msg);
  toastHost.append(node);
  let timer = 0;
  const handle = {
    update(text, opts = {}) {
      msg.textContent = text;
      if (opts.kind) node.classList.toggle('is-error', opts.kind === 'error');
      if (opts.timeout) arm(opts.timeout);
      return handle;
    },
    close() {
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 160);
    },
  };
  const arm = (ms) => {
    clearTimeout(timer);
    if (ms > 0) timer = setTimeout(handle.close, ms);
  };
  arm(timeout);
  return handle;
}
