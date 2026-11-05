import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { empty } from '@/services/digit-strategy/engine';
import { DEFAULT_SETTINGS } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import Momentum from '..';
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
const client = digitStrategyEngine as unknown as { getSnapshot: jest.Mock; start: jest.Mock; stop: jest.Mock };
beforeEach(() => {
    jest.clearAllMocks();
    client.getSnapshot.mockReturnValue(empty());
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'TEST-DEMO' });
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: true, accounts: [] });
});
it('starts the distinct strategy with same-contract recovery and editable risk settings', async () => {
    render(<Momentum />);
    expect(screen.getByRole('heading', { name: 'Momentum 70' })).toBeTruthy();
    expect(screen.getAllByRole('meter')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Starting stake (USD)'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'RUN MOMENTUM' }));
    await waitFor(() =>
        expect(client.start).toHaveBeenCalledWith(
            expect.objectContaining({
                strategy: 'momentum-70',
                recoveryMode: 'same_contract',
                stake: 0.5,
                multiplier: 2,
                duration: 1,
            }),
            undefined
        )
    );
    expect(screen.queryByLabelText('Recovery method')).toBeNull();
});
it('blocks RUN for guests and accounts already trading with another tool', () => {
    client.getSnapshot.mockReturnValue({ ...empty(), active: true });
    render(<Momentum />);
    expect((screen.getByRole('button', { name: 'RUN MOMENTUM' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'STOP' }) as HTMLButtonElement).disabled).toBe(true);
});
it('keeps risk settings locked and allows STOP for its own running session', async () => {
    client.getSnapshot.mockReturnValue({
        ...empty(),
        active: true,
        settings: { ...DEFAULT_SETTINGS, strategy: 'momentum-70', recoveryMode: 'same_contract' },
    });
    render(<Momentum />);
    expect((screen.getByLabelText('Starting stake (USD)') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'STOP' }));
    await waitFor(() => expect(client.stop).toHaveBeenCalledTimes(1));
});
it('does not start a trade session for a logged-out visitor', () => {
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: false, accounts: [] });
    render(<Momentum />);
    expect((screen.getByRole('button', { name: 'RUN MOMENTUM' }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.start).not.toHaveBeenCalled();
});
it('shows the actual recovery barrier in the journal and indicates the locked recovery market', () => {
    client.getSnapshot.mockReturnValue({
        ...empty(),
        settings: { ...DEFAULT_SETTINGS, strategy: 'momentum-70', recoveryMode: 'same_contract' },
        recovery: { streak: 0, deficit: 15, lockedSymbol: 'R_50', lockedDirection: 'DIGITOVER', recoveryLocked: true },
        trades: [
            {
                id: 'test',
                contractId: 123,
                market: 'R_50',
                direction: 'DIGITOVER',
                barrier: '4',
                recovery: true,
                at: 1700000000000,
                stake: 35,
                profit: 20,
                status: 'Won',
            },
        ],
    });
    render(<Momentum />);
    expect(screen.getByText('OVER 4')).toBeTruthy();
    expect(screen.getByText('UNDER 5')).toBeTruthy();
    expect(screen.getByText('Over 4 · Recovery')).toBeTruthy();
    expect(screen.getByText('Locked recovery market')).toBeTruthy();
});

it('rotates the preview across live markets during the recovery search rather than appearing locked', () => {
    jest.useFakeTimers();
    try {
        const m = (symbol: string, name: string) => ({
            symbol,
            name,
            ready: true,
            status: 'Live',
            momentum: {},
            recoveryMomentum: {},
        });
        client.getSnapshot.mockReturnValue({
            ...empty(),
            settings: { ...DEFAULT_SETTINGS, strategy: 'momentum-70', recoveryMode: 'same_contract' },
            recovery: { streak: 1, deficit: 35, countAfter: 0, pauseUntil: 0 },
            markets: [m('R_10', 'Volatility 10 Index'), m('R_50', 'Volatility 50 Index')],
        });
        render(<Momentum />);
        expect(screen.getByText(/Scanning all markets · 2\/2 live/)).toBeTruthy();
        expect(screen.getByRole('heading', { name: /Volatility 10 Index/ })).toBeTruthy();
        act(() => jest.advanceTimersByTime(2000));
        expect(screen.getByRole('heading', { name: /Volatility 50 Index/ })).toBeTruthy();
        expect(screen.queryByText('Locked recovery market')).toBeNull();
    } finally {
        jest.useRealTimers();
    }
});
