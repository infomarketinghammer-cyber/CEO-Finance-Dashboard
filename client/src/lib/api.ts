/**
 * API client.
 *
 * Carries the session token and the selected company on every request, so no page
 * has to remember to scope itself. Errors arrive as a typed ApiError with the
 * server's own message, which is written for the person reading it rather than for
 * a developer, and is shown verbatim.
 */

const BASE = '/api';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages from server-side validation, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path?: string; message?: string }[]) {
        if (d.path && d.message) out[d.path] = d.message;
      }
    }
    return out;
  }
}

let authToken: string | null = localStorage.getItem('dhyeya_token');
let activeCompanyId: string | null = localStorage.getItem('dhyeya_company');

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem('dhyeya_token', token);
  else localStorage.removeItem('dhyeya_token');
}

export function getAuthToken() {
  return authToken;
}

export function setActiveCompanyId(id: string | null) {
  activeCompanyId = id;
  if (id) localStorage.setItem('dhyeya_company', id);
  else localStorage.removeItem('dhyeya_company');
}

export function getActiveCompanyId() {
  return activeCompanyId;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildQuery(params: Query): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Query;
  /** Opt out of attaching the active company (used by global endpoints). */
  noCompany?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (activeCompanyId && !options.noCompany) headers['x-company-id'] = activeCompanyId;

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const url = `${BASE}${path}${options.query ? buildQuery(options.query) : ''}`;

  let res: Response;
  try {
    res = await fetch(url, { method: options.method ?? 'GET', headers, body, signal: options.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'The server could not be reached. Check that it is running and try again.');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { code: 'BAD_RESPONSE', message: 'The server returned an unexpected response.' } };
  }

  if (!res.ok) {
    const e = payload?.error ?? {};
    // An expired session should land the user on sign-in rather than on an error.
    if (res.status === 401) {
      setAuthToken(null);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'Something went wrong.', e.details);
  }

  return payload as T;
}

/** Triggers a browser download for an export endpoint. */
export async function download(path: string, query?: Query, fallbackName = 'dhyeya-export'): Promise<void> {
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (activeCompanyId) headers['x-company-id'] = activeCompanyId;

  const res = await fetch(`${BASE}${path}${query ? buildQuery(query) : ''}`, { headers });

  if (!res.ok) {
    const text = await res.text();
    let message = 'The export could not be generated.';
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {
      /* keep the default */
    }
    throw new ApiError(res.status, 'EXPORT_FAILED', message);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: Omit<RequestOptions, 'method' | 'query'>) =>
    request<T>(path, { ...opts, method: 'GET', query }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: 'PUT', body, query }),
  patch: <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: 'PATCH', body, query }),
  delete: <T>(path: string, query?: Query) => request<T>(path, { method: 'DELETE', query }),
  download,
};
