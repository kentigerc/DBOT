import { act, fireEvent, render, screen } from '@testing-library/react';
import { DBOT_TABS } from '@/constants/bot-contents';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import { watchManualMarkets, type ManualMarket } from '@/utils/manual-trader-markets';
import ManualTrader from '..';

const mockNavigate = jest.fn();
const mockDashboard = { setActiveTab: jest.fn() };
const mockRunPanel = { is_running: false, has_open_contract: false };
jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
jest.mock('@/hooks/useStore', () => ({ useStore: () => ({ dashboard: mockDashboard, run_panel: mockRunPanel }) }));
jest.mock('@/hooks/useMarketPanelHeight', () => ({ __esModule: true, default: () => ({ current: null }) }));
jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: jest.fn(), getDerivSession: jest.fn() }));
jest.mock('@/utils/xml-scanner-cycle', () => ({ xmlScannerCycle: { getSnapshot: () => ({ enabled: false }) } }));
jest.mock('@/utils/manual-trader-gate', () => {
    const snapshot = { active: false, phase: 'Ready' };
    return { manualTraderGate: { subscribe: () => () => {}, getSnapshot: () => snapshot } };
});
jest.mock('@/utils/manual-trader-markets', () => ({
    ...jest.requireActual('@/utils/manual-trader-markets'),
    watchManualMarkets: jest.fn(),
}));
let publish: (market: ManualMarket) => void;
let signal: AbortSignal;
const market = (symbol: string, side: 'over' | 'under', percentage = 75): ManualMarket => ({
    symbol,
    name: `Volatility ${symbol}`,
    submarket: 'random_index',
    epoch: Date.now() / 1000,
    checkedAt: Date.now(),
    ready: true,
    latest: 3,
    count: 1000,
    over: { percentage: side === 'over' ? percentage : 68, change: 0.1, armed: true, run: 2, epoch: Date.now() / 1000 },
    under: {
        percentage: side === 'under' ? percentage : 68,
        change: 0.1,
        armed: true,
        run: 2,
        epoch: Date.now() / 1000,
    },
    digits: Array.from({ length: 10 }, (_, digit) => ({
        digit,
        count: 100,
        percentage: 10,
        most: false,
        least: false,
    })),
});
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(2000000);
    jest.clearAllMocks();
    sessionStorage.clear();
    mockRunPanel.is_running = false;
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'TEST', currency: 'USD', status: 'active' });
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: true });
    (watchManualMarkets as jest.Mock).mockImplementation((_api, abort, update) => {
        publish = update;
        signal = abort;
        return Promise.resolve();
    });
});
afterEach(() => jest.useRealTimers());

it.each([
    ['over', 'Over Switcher', 'over-1-over-0.xml'],
    ['under', 'Under Switcher', 'under-8-under-9.xml'],
] as const)('loads the selected %s market into Builder without starting it', (side, name, fileName) => {
    render(<ManualTrader />);
    act(() => {
        publish(market('1HZ10V', side));
        jest.advanceTimersByTime(100);
    });
    expect(screen.getAllByRole('meter')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Load Bot' }));
    expect(JSON.parse(sessionStorage.getItem('neto.pendingBot')!)).toEqual({
        fileName,
        name,
        symbol: '1HZ10V',
        submarket: 'random_index',
        manualTraderSide: side,
    });
    expect(mockDashboard.setActiveTab).toHaveBeenCalledWith(DBOT_TABS.BOT_BUILDER);
    expect(mockNavigate).toHaveBeenCalledWith('/platform#bot_builder');
    expect(screen.queryByRole('button', { name: /^RUN$/ })).toBeNull();
});
it('compares both directions and picks the highest qualifying share across markets', () => {
    render(<ManualTrader />);
    act(() => {
        publish(market('R_10', 'under', 74));
        publish(market('R_50', 'over', 81));
        jest.advanceTimersByTime(100);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load Bot' }));
    expect(JSON.parse(sessionStorage.getItem('neto.pendingBot')!)).toMatchObject({
        symbol: 'R_50',
        manualTraderSide: 'over',
    });
});
it('rejects a stale match on click and cancels scanning when paused or hidden', () => {
    const view = render(<ManualTrader />);
    act(() => {
        publish(market('R_10', 'over'));
        jest.advanceTimersByTime(100);
    });
    jest.setSystemTime(Date.now() + 4000);
    fireEvent.click(screen.getByRole('button', { name: 'Load Bot' }));
    expect(screen.getByRole('alert').textContent).toMatch(/entry has changed/);
    expect(sessionStorage.getItem('neto.pendingBot')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pause scanner' }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load Bot' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume scanner' }));
    expect(signal.aborted).toBe(false);
    view.rerender(<ManualTrader active={false} />);
    expect(signal.aborted).toBe(true);
});
