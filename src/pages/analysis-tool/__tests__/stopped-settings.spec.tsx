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
