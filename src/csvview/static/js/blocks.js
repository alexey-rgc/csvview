/** Row block cache for one view: fixed-size blocks, LRU eviction, directional prefetch, request dedupe. */

import { isAbort } from './api.js';

export class BlockCache {
  constructor({ size = 500, capacity = 60, fetch, onLoad, onMissing, onError }) {
    this.size = size;
    this.capacity = capacity;
    this.fetch = fetch;
    this.onLoad = onLoad;
    this.onMissing = onMissing;
    this.onError = onError;
    this.blocks = new Map();
    this.pending = new Map();
    this.viewId = null;
    this.total = 0;
    this.gen = 0;
    this.missingReported = false;
  }

  reset(viewId, total, firstRows) {
    this.abortAll();
    this.gen += 1;
    this.viewId = viewId;
    this.total = total;
    this.blocks = new Map();
    this.missingReported = false;
    if (firstRows && firstRows.length >= Math.min(this.size, total)) {
      this.blocks.set(0, firstRows.slice(0, this.size));
    }
  }

  /** Point at a re-created view with identical contents: cached blocks stay valid. */
  rebind(viewId) {
    this.abortAll();
    this.gen += 1;
    this.viewId = viewId;
    this.missingReported = false;
  }

  getRow(i) {
    const block = this.blocks.get(Math.floor(i / this.size));
    return block ? block[i % this.size] : undefined;
  }

  has(i) {
    return this.blocks.has(Math.floor(i / this.size));
  }

  ensure(first, last, direction) {
    if (this.viewId == null || this.total === 0 || last < first) return;
    const b0 = Math.floor(first / this.size);
    const b1 = Math.floor(last / this.size);
    for (const [b, ctrl] of this.pending) {
      if (b < b0 - 1 || b > b1 + 1) {
        ctrl.abort();
        this.pending.delete(b);
      }
    }
    for (let b = b0; b <= b1; b++) {
      const block = this.blocks.get(b);
      if (block) {
        this.blocks.delete(b);
        this.blocks.set(b, block);
      } else {
        this.request(b);
      }
    }
    this.request(direction < 0 ? b0 - 1 : b1 + 1);
  }

  request(b) {
    if (b < 0 || b * this.size >= this.total) return;
    if (this.blocks.has(b) || this.pending.has(b)) return;
    const ctrl = new AbortController();
    const gen = this.gen;
    const offset = b * this.size;
    const limit = Math.min(this.size, this.total - offset);
    this.pending.set(b, ctrl);
    this.fetch(this.viewId, offset, limit, ctrl.signal).then(
      (rows) => {
        if (gen !== this.gen) return;
        this.pending.delete(b);
        this.blocks.set(b, rows);
        this.evict();
        this.onLoad(b);
      },
      (err) => {
        if (gen !== this.gen || isAbort(err)) return;
        this.pending.delete(b);
        if (err && err.status === 404) {
          if (!this.missingReported) {
            this.missingReported = true;
            this.onMissing();
          }
        } else {
          this.onError(err);
        }
      },
    );
  }

  evict() {
    while (this.blocks.size > this.capacity) {
      this.blocks.delete(this.blocks.keys().next().value);
    }
  }

  abortAll() {
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
  }
}
