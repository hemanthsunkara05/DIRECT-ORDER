/**
 * Typed fetch wrapper for the Direct-Order API (docs/04-api-specification.md
 * §8.1). `credentials: 'include'` on every call is load-bearing — the
 * session lives in HttpOnly cookies the API sets (Phase 3), not in a
 * token this client reads or stores itself; without it, the browser
 * would never send those cookies to a different origin.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export interface ApiErrorDetail {
  field?: string;
  message?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: ApiErrorDetail[];
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });

  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const body = (json as { error?: ApiErrorBody } | null)?.error ?? {
      code: 'UNKNOWN_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId: '',
    };
    throw new ApiError(res.status, body);
  }

  return (json as { data: T }).data;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

/** Mirrors AuthController's toPublicUser() field allowlist — see apps/api's auth.controller.ts. */
export interface CurrentUser {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  status: 'ACTIVE' | 'DISABLED';
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
}

export type VerificationPurpose = 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION';

export const authApi = {
  register: (input: { email: string; fullName: string; password: string }) =>
    post<{ message: string }>('/auth/register', input),

  login: (input: { email: string; password: string }) => post<CurrentUser>('/auth/login', input),

  logout: () => post<{ status: string }>('/auth/logout', {}),

  refresh: () => post<{ status: string }>('/auth/refresh', {}),

  forgotPassword: (email: string) => post<{ message: string }>('/auth/password/forgot', { email }),

  resetPassword: (input: { token: string; newPassword: string }) =>
    post<{ status: string }>('/auth/password/reset', input),

  requestOtp: (input: { identifier: string; purpose: VerificationPurpose }) =>
    post<{ message: string }>('/auth/otp/request', input),

  verifyOtp: (input: { identifier: string; purpose: VerificationPurpose; code: string }) =>
    post<{ status: string }>('/auth/otp/verify', input),

  me: () => get<CurrentUser>('/auth/me'),
};
