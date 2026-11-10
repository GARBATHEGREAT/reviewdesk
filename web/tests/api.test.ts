import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setAccessToken } from '../src/api';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });

describe('api client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer token', async () => {
    setAccessToken('abc');
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await api('/projects');
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer abc');
  });

  it('turns an error response into an ApiError with details', async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { error: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid', details: [{ field: 'email', message: 'Invalid email' }] } }),
    );
    const err = await api('/auth/register', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', details: [{ field: 'email' }] });
  });

  it('refreshes once and retries when the access token has expired', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new', user: { id: '1', email: 'a@b.co', name: 'A', role: 'admin' } }))
      .mockResolvedValueOnce(json(200, { items: [] }));
    const result = await api<{ items: unknown[] }>('/projects');
    expect(result.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/refresh');
    const retryHeaders = fetchMock.mock.calls[2]![1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer new');
  });

  it('gives up with a 401 when the refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'no session' } }));
    await expect(api('/projects')).rejects.toMatchObject({ status: 401 });
  });

  it('does not try to refresh for login failures', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'Incorrect email or password' } }));
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toThrow('Incorrect email or password');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for 204 responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await api('/auth/logout', { method: 'POST' })).toBeUndefined();
  });
});
