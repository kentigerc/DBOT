import { sessionRequest } from '../deriv-session';
const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});
it('reports a non-JSON hosting 503 with its HTTP status instead of a JSON parsing error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => {
            throw new Error('HTML error page');
        },
    });
    await expect(sessionRequest('/api/session')).rejects.toThrow('NetoAcademy returned HTTP 503');
});
it('preserves the explicit Deriv upstream error so users can identify the failing service', async () => {
    global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Deriv is temporarily unavailable (HTTP 503). Please try again shortly.' }),
    });
    await expect(sessionRequest('/api/session')).rejects.toThrow('Deriv is temporarily unavailable');
});

it('preserves 429 cooldown details and prevents focus refreshes from repeating the request', async () => {
    jest.useFakeTimers();
    const { refreshDerivSession } = await import('../deriv-session');
    global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: { get: () => '10' },
            json: async () => ({ error: 'Deriv has temporarily limited requests.', retryAfter: 10 }),
        })
        .mockResolvedValue({ ok: true, json: async () => ({ authenticated: false, accounts: [] }) });
    try {
        await expect(refreshDerivSession()).rejects.toMatchObject({ status: 429, retryAfter: 10 });
        await expect(refreshDerivSession()).rejects.toMatchObject({ status: 429, retryAfter: 10 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(10000);
        await expect(refreshDerivSession()).resolves.toMatchObject({ authenticated: false });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
        jest.useRealTimers();
    }
});
