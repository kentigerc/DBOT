import { render, screen } from '@testing-library/react';
import Status from '..';
import { higherLowerBuilder } from '@/utils/higher-lower-builder';
import { getDerivAccount } from '@/utils/deriv-session';
jest.mock('@/components/shared', () => ({
    getCardLabels: () => ({ TICK: 'Tick' }),
    isEmptyObject: (value: object) => !value || !Object.keys(value).length,
}));
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
it('shows only the existing tick progress display for each paired leg', () => {
    snapshot.mockReturnValue({
        accountId: 'DOT_TEST',
        message: 'Running',
        running: true,
        pnl: 20,
        pairs: 1,
        pending: {
            symbol: 'R_100',
            legs: [
                { type: 'HIGHER', status: 'open', id: 101, currentTick: 2, tickCount: 5 },
                { type: 'LOWER', status: 'open', id: 102, currentTick: 1, tickCount: 5 },
            ],
        },
    });
    render(<Status />);
    expect(screen.getByText('Tick 2')).toBeTruthy();
    expect(screen.getByText('Tick 1')).toBeTruthy();
    expect(document.querySelectorAll('.dc-progress-slider__ticks-step')).toHaveLength(10);
    expect(screen.queryByText(/Contract|Paid|Returned|P.L|Pairs|Running|R_100/)).toBeNull();
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
