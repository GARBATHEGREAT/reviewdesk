export type Role = 'admin' | 'reviewer' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<User | null> | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Ask the server for a new access token using the httpOnly refresh cookie. */
export function refreshSession(): Promise<User | null> {
  // Several requests can fail at once; share one refresh call between them.
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const data = (await res.json()) as { accessToken: string; user: User };
      accessToken = data.accessToken;
      return data.user;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  let res = await send(path, method, options.body);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await send(path, method, options.body);
  }
  return parse<T>(res);
}

/** Download a file (for example the CSV export) with the signed-in user's token. */
export async function download(path: string, filename: string): Promise<void> {
  let res = await send(path, 'GET');
  if (res.status === 401 && (await refreshSession())) res = await send(path, 'GET');
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Could not download the file');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- response types ----
export interface Project {
  id: string;
  name: string;
  description: string;
  rubric: string;
  requiredReviews: number;
  archived: boolean;
  taskCount?: number;
  doneCount?: number;
}

export interface Task {
  id: string;
  projectId: string;
  prompt: string;
  response: string;
  status: 'open' | 'in_review' | 'done';
  assigneeId: string | null;
  reviewCount?: number;
  reviewedByMe?: boolean;
}

export interface Stats {
  tasks: { open: number; inReview: number; done: number; total: number };
  reviews: { total: number; averageRating: number | null; verdicts: { pass: number; fail: number; unsure: number } };
  reviewers: { reviewerId: string; name: string; reviews: number; averageRating: number }[];
  agreement: {
    averageKappa: number | null;
    interpretation: string;
    pairs: { reviewerA: string; reviewerB: string; sharedTasks: number; percentAgreement: number; kappa: number | null }[];
  };
}
