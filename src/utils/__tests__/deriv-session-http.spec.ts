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
    global.fetch = jest
        .fn()
        .mockResolvedValue({
            ok: false,
            status: 503,
            json: async () => ({ error: 'Deriv is temporarily unavailable (HTTP 503). Please try again shortly.' }),
        });
    await expect(sessionRequest('/api/session')).rejects.toThrow('Deriv is temporarily unavailable');
});
