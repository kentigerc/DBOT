import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
            pendingPurchases: 2,
            unresolvedPurchaseCount: 2,
            unresolvedPurchases: [
                { source: 'analysis', contractId: '1234567890123456789', leaseExpiredAt: new Date().toISOString() },
                { source: 'higher_lower_xml', contractId: null, leaseExpiredAt: new Date().toISOString() },
            ],
            connectionDrops: 2,
            scope: 'Checks apply to this instance.',
        }),
    })) as jest.Mock;
    render(<Operations />);
    await waitFor(() => expect(screen.getByText('Review')).toBeTruthy());
    expect(screen.getByText(/External email\/SMS notifications are not configured/)).toBeTruthy();
    expect(screen.getByText(/analysis · Contract ID 1234567890123456789/)).toBeTruthy();
    expect(screen.getByText(/higher_lower_xml · Contract ID not recorded/)).toBeTruthy();
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

it('requires confirmation and sends only the selected demo record for release', async () => {
    const confirmation = jest.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const recordId = 'af000000-0000-4000-8000-000000000002';
    global.fetch = jest.fn(async (_url, options) => ({
        ok: true,
        json: async () =>
            options?.method === 'POST'
                ? { released: true }
                : {
                      checks: [],
                      alerts: [],
                      unresolvedPurchaseCount: 2,
                      pendingPurchases: 2,
                      unresolvedPurchases: [
                          {
                              source: 'builder',
                              contractId: null,
                              leaseExpiredAt: new Date().toISOString(),
                              releaseRecordId: recordId,
                              sessionAccount: { id: 'DOT100', type: 'demo' },
                          },
                          {
                              source: 'builder',
                              contractId: null,
                              leaseExpiredAt: new Date().toISOString(),
                              sessionAccount: null,
                          },
                      ],
                  },
    })) as jest.Mock;
    render(<Operations />);
    const button = await screen.findByRole('button', { name: 'Release record' });
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    expect(await screen.findByText('Purchase record released.')).toBeTruthy();
    expect(confirmation).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
        '/api/admin/health/release-purchase',
        expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ accountId: 'DOT100', recordId, confirmed: true }),
        })
    );
});
