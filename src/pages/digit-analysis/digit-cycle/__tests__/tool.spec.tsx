import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { empty } from '@/services/digit-strategy/engine';
import { DEFAULT_SETTINGS } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DigitCycle from '..';

jest.mock('@/services/digit-strategy/client', () => ({
    digitStrategyEngine: {
        subscribe: jest.fn(() => () => {}),
        getSnapshot: jest.fn(),
        selectAccount: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        reset: jest.fn().mockResolvedValue(undefined),
    },
}));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: jest.fn(), getDerivSession: jest.fn() }));
const client = digitStrategyEngine as unknown as {
    start: jest.Mock;
    stop: jest.Mock;
    reset: jest.Mock;
    getSnapshot: jest.Mock;
};
beforeEach(() => {
    jest.clearAllMocks();
    client.getSnapshot.mockReturnValue({ ...empty(), settings: { ...DEFAULT_SETTINGS, strategy: 'over2-under7' } });
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: true, accounts: [] });
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'DEMO', account_type: 'demo', currency: 'USD' });
});
it('exposes the requested settings and starts the named strategy only on RUN', async () => {
    render(<DigitCycle />);
    expect(screen.getByRole('heading', { name: 'HIT AND RUN STRATEGY' })).toBeTruthy();
    expect(client.start).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Martingale multiplier'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'RUN' }));
    await waitFor(() =>
        expect(client.start).toHaveBeenCalledWith(
            expect.objectContaining({
                strategy: 'over2-under7',
                duration: 1,
                multiplier: 3,
                stake: 0.35,
                maxLosses: 10,
                maxStake: 100,
                stopLoss: 100,
            }),
            undefined
        )
    );
});
it('does not allow a logged-out user to start', () => {
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: false, accounts: [] });
    render(<DigitCycle />);
    expect((screen.getByRole('button', { name: 'RUN' }) as HTMLButtonElement).disabled).toBe(true);
});
it('prevents starting or controlling a different active tool', () => {
    client.getSnapshot.mockReturnValue({ ...empty(), active: true });
    render(<DigitCycle />);
    expect((screen.getByRole('button', { name: 'RUN' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'STOP' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reset stopped session' }) as HTMLButtonElement).disabled).toBe(true);
});
it('stops its active session and locks risk settings', async () => {
    const snapshot = client.getSnapshot();
    client.getSnapshot.mockReturnValue({ ...snapshot, active: true });
    render(<DigitCycle />);
    expect((screen.getByLabelText('Starting stake (USD)') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'STOP' }));
    await waitFor(() => expect(client.stop).toHaveBeenCalledTimes(1));
});
it('shows command failures without pretending trading started', async () => {
    client.start.mockRejectedValueOnce(new Error('Risk settings invalid'));
    render(<DigitCycle />);
    fireEvent.click(screen.getByRole('button', { name: 'RUN' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Risk settings invalid');
});
it('hides recovery dropdowns and unused formation count while retaining the default policy', async () => {
    render(<DigitCycle />);
    expect(screen.queryByLabelText('Recovery method')).toBeNull();
    expect(screen.queryByLabelText('Recovery policy')).toBeNull();
    expect(screen.queryByLabelText('Recovery trigger count')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'RUN' }));
    await waitFor(() =>
        expect(client.start).toHaveBeenCalledWith(
            expect.objectContaining({ hitRecovery: 'analysis', recoveryMode: 'parity_percentage', triggerCount: 3 }),
            undefined
        )
    );
});
it('labels a live recovery market with its chosen policy rather than the normal Under 7 contract', () => {
    client.getSnapshot.mockReturnValue({
        ...empty(),
        active: true,
        streak: 1,
        settings: {
            ...DEFAULT_SETTINGS,
            strategy: 'over2-under7',
            hitRecovery: 'analysis',
            recoveryMode: 'under6_filtered_once',
        },
        recovery: {
            streak: 1,
            countAfter: 0,
            pauseUntil: 0,
            lockedSymbol: 'R_50',
            lockedDirection: 'DIGITUNDER',
            batchMarket: 'R_100',
            batchDirection: 'DIGITOVER',
        },
        markets: [
            {
                symbol: 'R_50',
                name: 'Volatility 50',
                ready: true,
                latest: 8,
                status: 'Live',
                digits: Array.from({ length: 10 }, (_, digit) => ({
                    digit,
                    count: 100,
                    percentage: 10,
                    most: false,
                    least: false,
                })),
            },
        ],
    });
    render(<DigitCycle />);
    expect(screen.getByText(/Recovery · Recovery profile 03/)).toBeTruthy();
});
it('shows the full journal newest first with contract details and coloured net results', () => {
    const snapshot = client.getSnapshot();
    client.getSnapshot.mockReturnValue({
        ...snapshot,
        trades: Array.from({ length: 22 }, (_, i) => ({
            id: `trade-${i}`,
            contractId: 1000 + i,
            market: 'R_100',
            direction: 'DIGITUNDER',
            barrier: '5',
            stake: 74,
            status: i === 21 ? 'Lost' : 'Won',
            at: 1700000000000 + i * 1000,
            entry: '100.05',
            exit: '100.09',
            recovery: true,
            profit: i === 21 ? -74 : 67,
        })),
    });
    render(<DigitCycle />);
    const table = screen.getByRole('table', { name: 'Trade journal' });
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(22);
    expect(rows[0].textContent).toContain('1021');
    expect(rows[0].textContent).toContain('DIGITUNDER 5');
    expect(rows[0].textContent).toContain('Recovery');
    expect(rows[0].querySelector('.is-loss')).toHaveTextContent('$-0.74');
    expect(rows[1].querySelector('.is-profit')).toHaveTextContent('$0.67');
    expect(table.querySelectorAll('th')).toHaveLength(9);
});

it('starts the standalone Even/Odd tool with the selected tick duration', async () => {
    render(<DigitCycle parity />);
    expect(screen.getByRole('heading', { name: 'EVEN / ODD STRATEGY' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Contract duration'), { target: { value: '5' } });
    expect(screen.queryByRole('option', { name: '6 ticks' })).toBeNull();
    expect(screen.queryByText('Batch wins')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'RUN' }));
    await waitFor(() =>
        expect(client.start).toHaveBeenCalledWith(
            expect.objectContaining({
                strategy: 'even-odd',
                duration: 5,
                recoveryMode: 'parity_percentage',
                multiplier: 2,
            }),
            undefined
        )
    );
});
