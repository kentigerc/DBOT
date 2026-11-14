import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { empty, type Snapshot } from '@/services/digit-strategy/engine';
import { DEFAULT_SETTINGS, sharedRecoverySettings } from '@/services/digit-strategy/strategy';
import DigitCycle from '@/pages/digit-analysis/digit-cycle';
import Momentum from '@/pages/digit-analysis/momentum';
import AnalysisTool from '..';

let mockSnapshot: Snapshot;
const mockListeners = new Set<() => void>();
jest.mock('@/services/digit-strategy/client', () => ({
    digitStrategyEngine: {
        subscribe: (listener: () => void) => {
            mockListeners.add(listener);
            return () => mockListeners.delete(listener);
        },
        getSnapshot: () => mockSnapshot,
        selectAccount: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(async () => {
            mockSnapshot = { ...mockSnapshot, active: false, wantsRun: false, phase: 'Stopped' };
            mockListeners.forEach(fn => fn());
        }),
        reset: jest.fn(),
    },
}));
jest.mock('@/hooks/useMarketPanelHeight', () => ({ __esModule: true, default: () => ({ current: null }) }));
jest.mock('@/utils/deriv-session', () => ({
    getDerivAccount: () => ({ account_id: 'DEMO1', currency: 'USD', status: 'active', account_type: 'demo' }),
    getDerivSession: () => ({ authenticated: true, accounts: [] }),
    refreshDerivSession: () => Promise.resolve({ authenticated: true, accounts: [] }),
    startDerivLogin: jest.fn(),
}));
const client = digitStrategyEngine as unknown as { start: jest.Mock; stop: jest.Mock; reset: jest.Mock };
const tools = [
    { name: 'Analysis Tool', strategy: undefined, Component: AnalysisTool, run: 'RUN' },
    { name: 'HIT AND RUN', strategy: 'over2-under7' as const, Component: () => <DigitCycle />, run: 'RUN' },
    { name: 'Even/Odd', strategy: 'even-odd' as const, Component: () => <DigitCycle parity />, run: 'RUN' },
    { name: 'Momentum', strategy: 'momentum-70' as const, Component: Momentum, run: 'RUN MOMENTUM' },
];
beforeEach(() => {
    jest.clearAllMocks();
    mockSnapshot = {
        ...empty(),
        accountId: 'DEMO1',
        active: true,
        wantsRun: true,
        pnl: -35,
        trades: [
            {
                id: 'trade1',
                contractId: 101,
                market: 'R_100',
                direction: 'DIGITOVER',
                recovery: false,
                stake: 35,
                payout: 0,
                profit: -35,
                status: 'Lost',
                at: Date.now(),
            },
        ],
    };
});
it.each(tools)(
    '$name unlocks all settings after STOP and keeps edits through status polling',
    async ({ Component, strategy, run }) => {
        mockSnapshot.settings = sharedRecoverySettings({ ...DEFAULT_SETTINGS, strategy });
        render(<Component />);
        screen.getAllByRole('spinbutton').forEach(input => expect(input).toBeDisabled());
        fireEvent.click(screen.getByRole('button', { name: 'STOP' }));
        await waitFor(() => screen.getAllByRole('spinbutton').forEach(input => expect(input).not.toBeDisabled()));
        const stake = screen.getByLabelText('Starting stake (USD)');
        const multiplier = screen.getByLabelText('Martingale multiplier');
        fireEvent.change(stake, { target: { value: '0.5' } });
        fireEvent.change(multiplier, { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText(strategy === 'momentum-70' ? 'Duration' : 'Contract duration'), {
            target: { value: '2' },
        });
        act(() => {
            mockSnapshot = {
                ...mockSnapshot,
                settings: Object.fromEntries(Object.entries(mockSnapshot.settings).reverse()) as Snapshot['settings'],
            };
            mockListeners.forEach(fn => fn());
            window.dispatchEvent(new Event('neto-session'));
        });
        expect(stake).toHaveValue(0.5);
        expect(multiplier).toHaveValue(3);
        fireEvent.click(screen.getByRole('button', { name: run }));
        await waitFor(() =>
            expect(client.start).toHaveBeenCalledWith(
                expect.objectContaining({ stake: 0.5, multiplier: 3, duration: 2, strategy }),
                undefined
            )
        );
        expect(client.reset).not.toHaveBeenCalled();
        expect(mockSnapshot.pnl).toBe(-35);
        expect(mockSnapshot.trades).toHaveLength(1);
    }
);
it.each(tools)('$name keeps fields locked until its open contract settles', ({ Component, strategy }) => {
    mockSnapshot.settings = sharedRecoverySettings({ ...DEFAULT_SETTINGS, strategy });
    mockSnapshot.active = false;
    mockSnapshot.pending = {
        nonce: 'pending',
        contractId: 102,
        sentAt: Date.now(),
        stake: 35,
        payout: 67,
        signal: { symbol: 'R_100', direction: 'DIGITEVEN', recovery: true, formation: false, epoch: 1 },
    };
    render(<Component />);
    screen.getAllByRole('spinbutton').forEach(input => expect(input).toBeDisabled());
});

it.each(tools)('$name discards another account\'s stopped edits on account change and logout', ({ Component, strategy }) => {
    mockSnapshot.active = false;
    mockSnapshot.settings = sharedRecoverySettings({ ...DEFAULT_SETTINGS, strategy, stake: 2, multiplier: 3 });
    render(<Component />);
    const stake = screen.getByLabelText('Starting stake (USD)');
    expect(stake).toHaveValue(2);
    fireEvent.change(stake, { target: { value: '3' } });
    act(() => {
        mockSnapshot = { ...empty(), accountId: 'DEMO2' };
        mockListeners.forEach(fn => fn());
    });
    expect(stake).toHaveValue(DEFAULT_SETTINGS.stake);
    expect(screen.getByLabelText('Martingale multiplier')).toHaveValue(DEFAULT_SETTINGS.multiplier);
    fireEvent.change(stake, { target: { value: '4' } });
    act(() => {
        mockSnapshot = empty();
        mockListeners.forEach(fn => fn());
    });
    expect(stake).toHaveValue(DEFAULT_SETTINGS.stake);
});

it.each(['over2-under7', 'even-odd', 'momentum-70'] as const)(
    'Analysis Tool does not display %s settings, trades, recovery or execution logs',
    strategy => {
        mockSnapshot = {
            ...mockSnapshot,
            settings: sharedRecoverySettings({ ...DEFAULT_SETTINGS, strategy, stake: 8, multiplier: 7, duration: 2 }),
            phase: 'Foreign tool running',
            error: 'Foreign tool error',
            logs: [{ at: Date.now(), level: 'info', message: 'Foreign tool execution message' }],
            trades: [{ ...mockSnapshot.trades[0], market: 'FOREIGN_MARKET', contractId: 87654321 }],
            demoPause: { triggerContractId: 99, status: 'running', completed: 4 },
            pending: {
                nonce: 'foreign-pending', sentAt: Date.now(), stake: 800, payout: 1000,
                signal: { symbol: 'FOREIGN_MARKET', direction: 'DIGITOVER', epoch: 1, recovery: true, formation: false },
            },
        };
        render(<AnalysisTool />);
        expect(screen.getByLabelText('Starting stake (USD)')).toHaveValue(DEFAULT_SETTINGS.stake);
        expect(screen.getByLabelText('Martingale multiplier')).toHaveValue(DEFAULT_SETTINGS.multiplier);
        expect(screen.getByLabelText('Contract duration')).toHaveValue(String(DEFAULT_SETTINGS.duration));
        expect(screen.getByRole('button', { name: 'RUN' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'STOP' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'New session' })).toBeDisabled();
        expect(screen.queryByText('FOREIGN_MARKET')).toBeNull();
        expect(screen.queryByText('Foreign tool execution message')).toBeNull();
        expect(screen.queryByText('Foreign tool error')).toBeNull();
        expect(screen.queryByText('Foreign tool running')).toBeNull();
        expect(screen.queryByText('Trade journal')).toBeNull();
        expect(screen.queryByText('Unconfirmed purchase')).toBeNull();
        expect(screen.queryByText(/DEMO PAUSE/)).toBeNull();
    }
);

it('Analysis Tool keeps its own edited settings while another tool runs, and uses them once that tool is reset', async () => {
    mockSnapshot.active = false;
    mockSnapshot.settings = { ...DEFAULT_SETTINGS, stake: 0.7, duration: 2 };
    render(<AnalysisTool />);
    const stake = screen.getByLabelText('Starting stake (USD)');
    fireEvent.change(stake, { target: { value: '0.9' } });
    act(() => {
        mockSnapshot = {
            ...mockSnapshot,
            active: true,
            settings: sharedRecoverySettings({ ...DEFAULT_SETTINGS, strategy: 'momentum-70', stake: 8, multiplier: 7 }),
        };
        mockListeners.forEach(fn => fn());
    });
    expect(stake).toHaveValue(0.9);
    expect(screen.getByLabelText('Contract duration')).toHaveValue('2');
    expect(screen.getByRole('button', { name: 'RUN' })).toBeDisabled();
    expect(screen.queryByText('Session P/L')).toBeNull();
    act(() => {
        mockSnapshot = { ...mockSnapshot, active: false, trades: [], recovery: empty().recovery };
        mockListeners.forEach(fn => fn());
    });
    fireEvent.click(screen.getByRole('button', { name: 'RUN' }));
    await waitFor(() => expect(client.start).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: undefined, stake: 0.9, duration: 2, multiplier: DEFAULT_SETTINGS.multiplier }),
        undefined
    ));
    expect(client.reset).not.toHaveBeenCalled();
});
