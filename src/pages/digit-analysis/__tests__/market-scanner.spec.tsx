import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MarketScanner from '../market-scanner';

jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
const connect = generateDerivApiInstance as jest.Mock;
const markets = [
    { symbol: 'R_100', display_name: 'Volatility 100', submarket: 'random_index', exchange_is_open: 1 },
    { symbol: '1HZ10V', display_name: 'Volatility 10 (1s)', exchange_is_open: 1 },
    { symbol: 'CRASH500', display_name: 'Crash 500', exchange_is_open: 1 },
    { symbol: 'R_50', display_name: 'Suspended', exchange_is_open: 1, is_trading_suspended: 1 },
];
const history = (counts: number[]) => ({
    pip_size: 2,
    history: { prices: counts.flatMap((n, digit) => Array<number>(n).fill(100 + digit / 100)) },
});
const over = history([9, 9, 9, 8, 10, 10, 11, 11, 11, 12]);
const under = history([12, 11, 11, 11, 10, 10, 8, 9, 9, 9]);
const neutral = history(Array(10).fill(10));
const createApi = () => ({
    send: jest
        .fn()
        .mockImplementation(async request =>
            request.active_symbols ? { active_symbols: markets } : request.ticks_history === 'R_100' ? over : under
        ),
    disconnect: jest.fn(),
});
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());
it('automatically scans, shows circles and suggests Over Punisher without starting trades', async () => {
    const api = createApi();
    connect.mockResolvedValue(api);
    const select = jest.fn(),
        load = jest.fn().mockReturnValue(true);
    render(<MarketScanner sampleSize={100} onSelect={select} onLoad={load} />);
    await screen.findByText('Suggested bot:', { exact: false });
    expect(screen.getByText('Over Punisher')).toBeTruthy();
    expect(screen.getByLabelText('Scanner digit percentages').children).toHaveLength(10);
    expect(screen.queryByRole('button', { name: 'SCAN' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View digits' }));
    expect(select).toHaveBeenCalledWith('R_100');
    fireEvent.click(screen.getByRole('button', { name: 'Load Bot' }));
    expect(load).toHaveBeenCalledWith('over', 'R_100', 'random_index', [9, 9, 9, 8, 10, 10, 11, 11, 11, 12]);
    expect(screen.getByRole('button', { name: 'PAUSE' })).toBeTruthy();
    expect(api.send.mock.calls.every(([request]) => request.active_symbols || request.ticks_history)).toBe(true);
});
it('finds Over and Under in the same pass without a selector and loads the right bot', async () => {
    const api = createApi();
    connect.mockResolvedValue(api);
    const load = jest.fn().mockReturnValue(true);
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={load} />);
    await waitFor(() => expect(screen.queryByText('Under Punisher')).not.toBeNull(), { timeout: 3000 });
    expect(screen.getByText('Over Punisher')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    const underCard = screen.getByText('Under Punisher').closest('article')!;
    fireEvent.click(within(underCard).getByRole('button', { name: 'Load Bot' }));
    expect(load).toHaveBeenCalledWith('under', '1HZ10V', 'random_index', [12, 11, 11, 11, 10, 10, 8, 9, 9, 9]);
    expect(
        api.send.mock.calls.some(
            ([request]) => request.ticks_history === 'CRASH500' || request.ticks_history === 'R_50'
        )
    ).toBe(false);
    expect(api.send.mock.calls.filter(([request]) => request.ticks_history).length).toBe(2);
});
it('keeps rescanning and removes a market when conditions no longer match', async () => {
    jest.useFakeTimers();
    let matches = true;
    const api = {
        send: jest
            .fn()
            .mockImplementation(async request =>
                request.active_symbols ? { active_symbols: markets.slice(0, 1) } : matches ? over : neutral
            ),
        disconnect: jest.fn(),
    };
    connect.mockResolvedValue(api);
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={jest.fn()} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Load Bot' })).toBeTruthy();
    matches = false;
    await act(async () => {
        await jest.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByRole('button', { name: 'Load Bot' })).toBeNull();
    expect(api.send.mock.calls.filter(([request]) => request.ticks_history).length).toBe(2);
});
it('pauses inactive tabs and ignores late responses', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(value => {
        resolve = value;
    });
    const api = { send: jest.fn().mockReturnValue(pending), disconnect: jest.fn() };
    connect.mockResolvedValue(api);
    const props = { sampleSize: 100, onSelect: jest.fn(), onLoad: jest.fn() };
    const { rerender } = render(<MarketScanner {...props} active />);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    rerender(<MarketScanner {...props} active={false} />);
    await act(async () => {
        resolve({ active_symbols: markets });
    });
    expect(screen.queryByRole('button', { name: 'Load Bot' })).toBeNull();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.disconnect).toHaveBeenCalled();
});
it('shows login or running-bot errors from the loader without navigating or stopping scans', async () => {
    connect.mockResolvedValue(createApi());
    const load = jest.fn(() => {
        throw new Error('Log in with Deriv to load a NetoAcademy bot.');
    });
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={load} />);
    await screen.findByRole('button', { name: 'Load Bot' });
    fireEvent.click(screen.getByRole('button', { name: 'Load Bot' }));
    expect(screen.getByRole('alert').textContent).toContain('Log in with Deriv');
    expect(screen.getByRole('button', { name: 'PAUSE' })).toBeTruthy();
});
it('resets matches when sample size changes and reconnects automatically', async () => {
    connect.mockResolvedValue(createApi());
    const props = { onSelect: jest.fn(), onLoad: jest.fn() };
    const { rerender } = render(<MarketScanner {...props} sampleSize={100} />);
    await screen.findByRole('button', { name: 'Load Bot' });
    rerender(<MarketScanner {...props} sampleSize={500} />);
    expect(screen.queryByRole('button', { name: 'Load Bot' })).toBeNull();
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
});
it('reconnects automatically after a market service error', async () => {
    jest.useFakeTimers();
    const offline = { send: jest.fn().mockRejectedValue(new Error('offline')), disconnect: jest.fn() };
    connect.mockResolvedValueOnce(offline).mockResolvedValue(createApi());
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={jest.fn()} />);
    await act(async () => {});
    expect(screen.getByText(/Retrying in 5 seconds/)).toBeTruthy();
    await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('button', { name: 'Load Bot' })).toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(offline.disconnect).toHaveBeenCalled();
});
it('replaces an Over match with Under when the same market changes direction', async () => {
    jest.useFakeTimers();
    let nextHistory = over;
    const api = {
        send: jest
            .fn()
            .mockImplementation(async request =>
                request.active_symbols ? { active_symbols: markets.slice(0, 1) } : nextHistory
            ),
        disconnect: jest.fn(),
    };
    connect.mockResolvedValue(api);
    const load = jest.fn().mockReturnValue(true);
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={load} />);
    await act(async () => {});
    expect(screen.getByText('Over Punisher')).toBeTruthy();
    nextHistory = under;
    await act(async () => {
        await jest.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByText('Over Punisher')).toBeNull();
    expect(screen.getByText('Under Punisher')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Load Bot' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load Bot' }));
    expect(load).toHaveBeenCalledWith('under', 'R_100', 'random_index', [12, 11, 11, 11, 10, 10, 8, 9, 9, 9]);
});

it('loads exactly one matched XML automatically only after the user enables Auto', async () => {
    const { xmlScannerCycle } = require('@/utils/xml-scanner-cycle');
    const session = require('@/utils/deriv-session');
    const locks = require('@/utils/trading-lock');
    const account = jest.spyOn(session, 'getDerivAccount').mockReturnValue({
        account_id: 'TEST-DEMO',
        status: 'active',
        account_type: 'demo',
        currency: 'USD',
        balance: 10000,
    });
    const check = jest.spyOn(locks, 'checkServerAnalysis').mockResolvedValue(false);
    connect.mockResolvedValue(createApi());
    const load = jest.fn().mockReturnValue(true);
    const start = (settings: { stake: number; stopLoss: number; takeProfit: number; multiplier: number }) =>
        xmlScannerCycle.start('TEST-DEMO', 100, jest.fn(), undefined, settings);
    const { rerender } = render(
        <MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={load} onAutoStart={start} />
    );
    await screen.findByRole('button', { name: 'Load Bot' });
    expect(load).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Stake ($)'), { target: { value: '0.75' } });
    fireEvent.change(screen.getByLabelText('Session stop loss ($)'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Session take profit ($)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Martingale (×)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'START XML AUTO' }));
    await waitFor(() => expect(xmlScannerCycle.getSnapshot().enabled).toBe(true));
    expect(xmlScannerCycle.getSnapshot().settings).toEqual({ stake: 0.75, stopLoss: 25, takeProfit: 5, multiplier: 3 });
    expect(screen.getByLabelText('Stake ($)')).toBeDisabled();
    // A fresh pass continues even while the Builder section is in front.
    rerender(<MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={load} onAutoStart={start} active={false} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1), { timeout: 4500 });
    expect(load.mock.calls[0][0]).toMatch(/over|under/);
    expect(load.mock.calls[0][3]).toHaveLength(10);
    expect(Number.isSafeInteger(load.mock.calls[0][4])).toBe(true);
    expect(xmlScannerCycle.getSnapshot().phase).toBe('loading');
    expect(screen.getByText('XML Auto active · Follow the session status above.')).toBeInTheDocument();
    expect(screen.queryByText('Scanner paused. Displayed percentages are snapshots.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'STOP XML AUTO' }));
    expect(xmlScannerCycle.getSnapshot().enabled).toBe(false);
    account.mockRestore();
    check.mockRestore();
});

it('STOP cancels the asynchronous session check before XML Auto can start', async () => {
    const session = require('@/utils/deriv-session');
    const locks = require('@/utils/trading-lock');
    const account = jest.spyOn(session, 'getDerivAccount').mockReturnValue({
        account_id: 'TEST-DEMO',
        status: 'active',
        account_type: 'demo',
        currency: 'USD',
        balance: 10000,
    });
    let release!: (busy: boolean) => void;
    const check = jest.spyOn(locks, 'checkServerAnalysis').mockImplementation(
        () =>
            new Promise(resolve => {
                release = resolve;
            })
    );
    connect.mockResolvedValue(createApi());
    const start = jest.fn();
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} onLoad={jest.fn()} onAutoStart={start} />);
    fireEvent.click(screen.getByRole('button', { name: 'START XML AUTO' }));
    fireEvent.click(screen.getByRole('button', { name: 'STOP XML AUTO' }));
    await act(async () => {
        release(false);
    });
    expect(start).not.toHaveBeenCalled();
    account.mockRestore();
    check.mockRestore();
});
