import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Admin from '..';
const overview = {
    visitors: 12,
    connectedAccounts: 3,
    tradingAccounts: 2,
    trades: 8,
    onlineBrowsers: 2,
    onlineAuthenticatedBrowsers: 1,
    liveDerivConnections: 2,
    liveConnectedAccounts: 1,
    activeServerBots: 1,
    storage: 'preview-file',
    healthy: true,
    pendingEvents: 0,
    generatedAt: Date.now(),
    daily: [{ date: '2026-10-26', visitors: 12, connections: 3, trades: 8 }],
    tools: [{ tool: 'digit_analysis', sessions: 5 }],
    money: [
        {
            accountType: 'real',
            currency: 'USD',
            trades: 5,
            volume: 175,
            net: -35,
            settled: 5,
            wins: 3,
            losses: 2,
            open: 0,
        },
    ],
};
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
beforeEach(() => {
    global.fetch = jest.fn(async url =>
        String(url).includes('/access') ? response({ admin: true }) : response(overview)
    ) as jest.Mock;
});
afterEach(() => jest.restoreAllMocks());
it('keeps private analytics hidden when access is denied', async () => {
    (fetch as jest.Mock).mockResolvedValue(response({ error: 'This account does not have admin access.' }, 403));
    render(<Admin />);
    expect(await screen.findByRole('alert')).toHaveTextContent('does not have admin access');
    expect(screen.queryByRole('region', { name: 'Live activity' })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
});
it('shows owner analytics, real/demo labels and a clear preview-storage notice', async () => {
    render(<Admin />);
    await screen.findByText(/Preview storage:/);
    expect(screen.getByRole('heading', { name: 'Daily activity' })).toBeTruthy();
    expect(screen.getByText('Digit Analysis')).toBeTruthy();
    expect(screen.getByText('real')).toBeTruthy();
    expect(screen.getByText('-0.35')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export daily CSV' })).toBeEnabled();
});
it('loads commission only on request and displays provider figures', async () => {
    (fetch as jest.Mock).mockImplementation(async url =>
        String(url).includes('/commission')
            ? response({
                  reported: true,
                  commissionUsd: 12.34,
                  volumeUsd: 100,
                  contracts: 8,
                  clients: 2,
                  fetchedAt: Date.now(),
                  source: 'Deriv',
                  appId: 'configured-app',
              })
            : String(url).includes('/access')
              ? response({ admin: true })
              : response(overview)
    );
    render(<Admin />);
    await screen.findByText(/Preview storage:/);
    expect((fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes('/commission'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh commission' }));
    expect(await screen.findByText('$12.34')).toBeTruthy();
    expect(screen.getByText(/Source: Deriv/)).toBeTruthy();
});
it('does not fabricate earnings when reporting authorization is missing', async () => {
    (fetch as jest.Mock).mockImplementation(async url =>
        String(url).includes('/commission')
            ? response({ error: 'Connect developer reporting.' }, 403)
            : String(url).includes('/access')
              ? response({ admin: true })
              : response(overview)
    );
    render(<Admin />);
    await screen.findByText(/Preview storage:/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh commission' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect developer reporting');
    expect(screen.queryByText('$0.00')).toBeNull();
});
it('applies selected UTC dates to the server report', async () => {
    render(<Admin />);
    await screen.findByText(/Preview storage:/);
    fireEvent.change(screen.getByLabelText('From (UTC)'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To (UTC)'), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
    await waitFor(() =>
        expect(
            (fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes('from=2026-10-01&to=2026-10-20'))
        ).toBe(true)
    );
});
it('requests real daily commission buckets only after the owner selects daily detail', async () => {
    (fetch as jest.Mock).mockImplementation(async url =>
        String(url).includes('/commission')
            ? response({
                  reported: true,
                  commissionUsd: 3.33,
                  volumeUsd: 10,
                  contracts: 2,
                  clients: 1,
                  fetchedAt: Date.now(),
                  source: 'Deriv',
                  appId: 'app',
                  points: [
                      { from: '2026-10-01', to: '2026-10-01', reported: true, commissionUsd: 1.11 },
                      { from: '2026-10-02', to: '2026-10-02', reported: true, commissionUsd: 2.22 },
                  ],
              })
            : String(url).includes('/access')
              ? response({ admin: true })
              : response(overview)
    );
    render(<Admin />);
    await screen.findByText(/Preview storage:/);
    fireEvent.change(screen.getByLabelText('Commission detail'), { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh commission' }));
    expect(await screen.findByText('$1.11')).toBeTruthy();
    expect(screen.getByText('$2.22')).toBeTruthy();
    expect((fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes('breakdown=daily'))).toBe(true);
});

it('shows individual account activity without claiming individual commission', async () => {
    (fetch as jest.Mock).mockImplementation(async url =>
        String(url).includes('/access')
            ? response({ admin: true })
            : response({
                  ...overview,
                  tradingUsers: [{ ...overview.money[0], account: 'abcdef0123456789abcdef0123456789' }],
              })
    );
    render(<Admin />);
    expect(await screen.findByText('User abcdef0123456789')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Trading by user' })).toBeTruthy();
    expect(screen.getByText(/not commission contribution/)).toBeTruthy();
});
