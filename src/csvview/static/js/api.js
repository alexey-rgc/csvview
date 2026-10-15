/** HTTP client for the csvview server: JSON fetch wrappers, typed errors, upload with progress. */

export class ApiError extends Error {
  constructor(message, status, column = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.column = column;
  }
}

export const isAbort = (err) => err && err.name === 'AbortError';

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body && body.error) || `${res.status} ${res.statusText}`.trim();
    throw new ApiError(message, res.status, (body && body.column) || null);
  }
  return body;
}

function postJson(url, payload, signal) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

const qs = (params) => new URLSearchParams(params).toString();

/** Header values must be Latin-1; the server normalises table names anyway. */
const headerSafe = (name) => name.replace(/[^\x20-\x7e]/g, '_');

export const api = {
  tables: () => request('/api/tables'),

  view: (spec, signal) => postJson('/api/view', spec, signal),

  rows: (view, offset, limit, signal) =>
    request(`/api/rows?${qs({ view, offset, limit })}`, { signal }),

  query: (sql, signal) => postJson('/api/query', { sql }, signal),

  column: (view, col, signal) => request(`/api/column?${qs({ view, col })}`, { signal }),

  exportUrl: (view) => `/api/export?${qs({ view })}`,

  load(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/load');
      xhr.setRequestHeader('X-Filename', headerSafe(file.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
        else reject(new ApiError((body && body.error) || `Upload failed (${xhr.status})`, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError('Upload failed: the server did not respond', 0));
      xhr.send(file);
    });
  },
};
