/** File intake: window-wide drag-and-drop overlay, the Open CSV picker, and uploads with a progress toast. */

import { api } from './api.js';
import { toast } from './dom.js';
import { formatBytes } from './format.js';

const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

export class FileIntake {
  constructor({ overlay, input, onLoaded }) {
    this.overlay = overlay;
    this.input = input;
    this.onLoaded = onLoaded;
    this.depth = 0;
    this.busy = false;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.depth += 1;
      this.overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      this.depth = Math.max(0, this.depth - 1);
      if (!this.depth) this.overlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.depth = 0;
      this.overlay.hidden = true;
      this.upload([...e.dataTransfer.files]);
    });
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      this.upload(files);
    });
  }

  pick() {
    this.input.click();
  }

  async upload(files) {
    if (!files.length) return;
    if (this.busy) {
      toast('An upload is already running. Drop again when it finishes.', { kind: 'error' });
      return;
    }
    this.busy = true;
    let last = null;
    try {
      for (const file of files) {
        const label = `${file.name} (${formatBytes(file.size)})`;
        const note = toast(`Uploading ${label}`, { timeout: 0 });
        try {
          const res = await api.load(file, (p) => {
            note.update(p < 1 ? `Uploading ${label}: ${Math.round(p * 100)}%` : `Loading ${file.name} into DuckDB…`);
          });
          last = res.table;
          note.update(`Opened ${file.name}`, { timeout: 1800 });
        } catch (err) {
          note.update(`Could not open ${file.name}: ${err.message}`, { kind: 'error', timeout: 6000 });
        }
      }
    } finally {
      this.busy = false;
    }
    if (last) this.onLoaded(last);
  }
}
