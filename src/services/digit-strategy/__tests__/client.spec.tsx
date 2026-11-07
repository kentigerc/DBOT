import { act, fireEvent, render, screen, within } from '@testing-library/react';
import AnalysisTool from '@/pages/analysis-tool';
import DigitCycle from '@/pages/digit-analysis/digit-cycle';
import Momentum from '@/pages/digit-analysis/momentum';
import { getDerivAccount, getDerivSession, refreshDerivSession, sessionRequest } from '@/utils/deriv-session';
import { digitStrategyEngine } from '../client';
import { empty, type Snapshot } from '../engine';
import { DEFAULT_SETTINGS, type Settings } from '../strategy';

jest.mock('@/external/bot-skeleton', () => ({ api_base: { is_running: false } }));
jest.mock('@/utils/trading-lock', () => ({ setAnalysisTrading: jest.fn() }));
jest.mock('@/utils/deriv-session', () => ({
    getDerivAccount: jest.fn(),
    getDerivSession: jest.fn(),
    refreshDerivSession: jest.fn(),
    sessionRequest: jest.fn(),
    startDerivLogin: jest.fn(),
}));
const request = sessionRequest as jest.Mock;
const account = { account_id: 'STOP-TEST', account_type: 'demo', currency: 'USD', status: 'active', balance: 1000 };
beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    localStorage.clear();
    (getDerivAccount as jest.Mock).mockReturnValue(account);
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: true, accounts: [account] });
    (refreshDerivSession as jest.Mock).mockResolvedValue({ authenticated: true, accounts: [account] });
});
afterEach(async () => {
    digitStrategyEngine.selectAccount(undefined);
    await Promise.resolve();
    jest.clearAllTimers();
    jest.useRealTimers();
});

it.each([undefined, 'over2-under7', 'even-odd', 'momentum-70'] as const)(
    'keeps %s mounted after STOP receives a persisted snapshot without market previews, then resumes',
    async (strategy: Settings['strategy']) => {
        let state: Snapshot = {
            ...empty(),
            accountId: account.account_id,
            active: true,
            wantsRun: true,
            phase: 'Trading',
            settings: { ...DEFAULT_SETTINGS, strategy },
            pnl: 12,
            wins: 1,
            stake: 35,
            trades: [
                {
                    id: 'settled-1',
                    contractId: 101,
                    market: 'R_100',
                    direction: 'DIGITEVEN',
                    recovery: false,
                    stake: 35,
                    payout: 47,
                    profit: 12,
                    status: 'Won',
                    at: Date.now(),
                },
            ],
        };
        request.mockImplementation(async (_path, body) => {
            if (body?.action === 'stop') {
                state = { ...state, active: false, wantsRun: false, phase: 'Stopped' };
                // The journal intentionally excludes ephemeral market readings.
                const { markets: _markets, ...saved } = state;
                return saved;
            }
            if (body?.action === 'start') state = { ...state, active: true, wantsRun: true, phase: 'Trading' };
            return state;
        });
        // All Digit Analysis tools remain mounted together in the workspace.
        const { container } = render(
            <>
                <DigitCycle />
                <DigitCycle parity />
                <Momentum />
                {strategy === undefined && <AnalysisTool />}
            </>
        );
        await act(async () => {});
        const selector =
            strategy === undefined
                ? '.analysis-tool'
                : strategy === 'momentum-70'
                  ? '.momentum'
                  : strategy === 'even-odd'
                    ? '.digit-cycle--parity'
                    : '.digit-cycle--hit-run';
        const panel = container.querySelector(selector) as HTMLElement;
        const stop = within(panel).getByRole('button', { name: 'STOP' });
        expect(stop).toBeEnabled();
        await act(async () => {
            fireEvent.click(stop);
        });
        expect(digitStrategyEngine.getSnapshot()).toMatchObject({ active: false, pnl: 12, wins: 1, markets: [] });
        expect(digitStrategyEngine.getSnapshot().trades).toHaveLength(1);
        expect(container.querySelector(selector)).toBe(panel);
        expect(screen.queryByText('Sorry for the interruption')).toBeNull();
        const run = within(panel).getByRole('button', { name: strategy === 'momentum-70' ? 'RUN MOMENTUM' : 'RUN' });
        expect(run).toBeEnabled();
        await act(async () => {
            fireEvent.click(run);
        });
        expect(digitStrategyEngine.getSnapshot()).toMatchObject({ active: true, pnl: 12, wins: 1 });
        expect(request).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ action: 'start', settings: expect.objectContaining({ strategy }) })
        );
        expect(request.mock.calls.some(([, body]) => body?.action === 'reset')).toBe(false);
    }
);
