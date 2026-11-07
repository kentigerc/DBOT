import { render, screen, waitFor } from '@testing-library/react';
import Operations from '../operations';
afterEach(() => jest.restoreAllMocks());
it('shows private check results and unresolved-purchase warnings without claiming external monitoring', async () => {
    global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
            status: 'warning',
            checkedAt: Date.now(),
            checks: [
                { code: 'pending_purchases', status: 'warning', message: 'Review unresolved purchases in Reports.' },
            ],
            alerts: [
                {
                    id: 1,
                    code: 'pending_purchases',
                    status: 'warning',
                    message: 'Review unresolved purchases in Reports.',
                    at: Date.now(),
                },
            ],
            activeServerBots: 0,
            protectedAccounts: 1,
            pendingPurchases: 1,
            connectionDrops: 2,
            scope: 'Checks apply to this instance.',
        }),
    })) as jest.Mock;
    render(<Operations />);
    await waitFor(() => expect(screen.getByText('Review')).toBeTruthy());
    expect(screen.getByText(/External email\/SMS notifications are not configured/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
        '/api/admin/health',
        expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' })
    );
});
it('does not retain private results when the server denies access', async () => {
    global.fetch = jest.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Owner access required.' }),
    })) as jest.Mock;
    render(<Operations />);
    expect(await screen.findByRole('status')).toHaveTextContent('Owner access required');
    expect(screen.queryByText(/Protected accounts:/)).toBeNull();
});
