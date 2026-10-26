import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import UsageTracker from '..';
beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
it.each(['/admin', '/callback?code=private'])('does not track the private page %s', path => {
    render(
        <MemoryRouter initialEntries={[path]}>
            <UsageTracker />
        </MemoryRouter>
    );
    expect(fetch).not.toHaveBeenCalled();
});
it('sends only a whitelisted page, never URL secrets or identity fields', () => {
    render(
        <MemoryRouter initialEntries={['/free-bots?token=private#bot_builder']}>
            <UsageTracker />
        </MemoryRouter>
    );
    const [url, options] = (fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/analytics/pulse');
    expect(JSON.parse(options.body)).toEqual({ tool: 'free_bots' });
    expect(options.credentials).toBe('same-origin');
    expect(options.body).not.toContain('private');
});
