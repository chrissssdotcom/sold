'use client';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Call the admin API. Same-origin cookies authenticate; the browser adds the Origin header the server checks. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!res.ok) {
    if (res.status === 401 && !path.includes('/auth/')) window.location.href = '/admin/login';
    const issues = (data.error?.details as { issues?: { path: string; message: string }[] })
      ?.issues;
    const message = issues?.length
      ? issues.map((i) => `${i.path || 'value'}: ${i.message}`).join('; ')
      : (data.error?.message ?? `Request failed (${res.status})`);
    throw new ApiError(message, res.status, data.error?.code ?? 'error', data.error?.details);
  }
  return data as T;
}
