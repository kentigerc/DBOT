import { render, screen } from '@testing-library/react';
import Status from '..';
import { higherLowerBuilder } from '@/utils/higher-lower-builder';
import { getDerivAccount } from '@/utils/deriv-session';
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: jest.fn() }));
jest.mock('@/utils/higher-lower-builder', () => ({
    PAIR_BLOCK: 'neto_higher_lower_pair',
    higherLowerBuilder: { subscribe: () => () => {}, getSnapshot: jest.fn() },
}));
const snapshot = higherLowerBuilder.getSnapshot as jest.Mock;
beforeEach(() => {
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'DOT_TEST' });
});
it('leaves the ordinary Summary untouched without a paired session', () => {
    snapshot.mockReturnValue({ accountId: '', message: '', running: false });
    render(
        <Status>
            <p>Normal summary</p>
        </Status>
    );
    expect(screen.getByText('Normal summary')).toBeTruthy();
    expect(screen.queryByRole('region')).toBeNull();
});
it('shows actual contract IDs, paid amounts and separate outcomes in the existing Summary', () => {
    snapshot.mockReturnValue({
        accountId: 'DOT_TEST',
        message: 'Session running',
        running: true,
        pnl: 20,
        pairs: 1,
        history: [
            {
                symbol: 'R_100',
                at: 1,
                profit: 20,
                legs: [
                    { type: 'HIGHER', status: 'settled', id: 101, buyPrice: 35, payout: 90, profit: 55 },
                    { type: 'LOWER', status: 'settled', id: 102, buyPrice: 35, payout: 0, profit: -35 },
                ],
            },
        ],
    });
    render(<Status />);
    expect(screen.getByText(/One won \/ one lost/)).toBeTruthy();
    expect(screen.getByText(/Higher \+1 · Won · Contract 101/)).toHaveTextContent(
        'Paid $0.35 · Returned $0.90 · P/L $0.55'
    );
    expect(screen.getByText(/Lower −1 · Lost · Contract 102/)).toHaveTextContent(
        'Paid $0.35 · Returned $0.00 · P/L $-0.35'
    );
});
it('hides another account’s paired history after switching accounts', () => {
    snapshot.mockReturnValue({ accountId: 'DOT_OTHER', message: 'Private', running: true });
    render(
        <Status>
            <p>Normal summary</p>
        </Status>
    );
    expect(screen.queryByText(/Private/)).toBeNull();
    expect(screen.getByText('Normal summary')).toBeTruthy();
});
