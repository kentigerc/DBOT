import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MarketScanner from '../market-scanner';

jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
const connect = generateDerivApiInstance as jest.Mock;
const markets = [
    { symbol: 'R_100', display_name: 'Volatility 100', exchange_is_open: 1 },
    { symbol: '1HZ10V', display_name: 'Volatility 10 (1s)', exchange_is_open: 1 },
    { symbol: 'CRASH500', display_name: 'Crash 500', exchange_is_open: 1 },
    { symbol: 'R_50', display_name: 'Suspended', exchange_is_open: 1, is_trading_suspended: 1 },
];
const history = (counts: number[]) => ({
    pip_size: 2,
    history: { prices: counts.flatMap((n, digit) => Array<number>(n).fill(100 + digit / 100)) },
});
const over = history([9, 9, 9, 9, 8, 11, 11, 11, 11, 12]);
const under = history([8, 11, 11, 11, 11, 12, 9, 9, 9, 9]);
under.history.prices.push(under.history.prices.shift()!);
const mute = () => fireEvent.click(screen.getByLabelText('Scanning sound'));

beforeEach(() => jest.clearAllMocks());
it('scans only available Volatility indices, shows matches and selects the correct market', async () => {
    const api = {
        send: jest
            .fn()
            .mockResolvedValueOnce({ active_symbols: markets })
            .mockResolvedValueOnce(over)
            .mockResolvedValueOnce(history(Array(10).fill(10))),
        disconnect: jest.fn(),
    };
    connect.mockResolvedValue(api);
    const select = jest.fn();
    render(<MarketScanner sampleSize={100} onSelect={select} active />);
    mute();
    fireEvent.click(screen.getByRole('button', { name: 'SCAN' }));
    await screen.findByText('Volatility 100');
    expect(screen.getByRole('status').textContent).toContain('1 matching market');
    expect(api.send).toHaveBeenCalledTimes(3);
    expect(api.send).toHaveBeenCalledWith({ ticks_history: '1HZ10V', style: 'ticks', end: 'latest', count: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'View digits' }));
    expect(select).toHaveBeenCalledWith('R_100');
    expect(api.disconnect).toHaveBeenCalled();
});
it('uses Under conditions and reports failed or incomplete histories without matching them', async () => {
    const api = {
        send: jest
            .fn()
            .mockResolvedValueOnce({ active_symbols: markets })
            .mockResolvedValueOnce(under)
            .mockRejectedValueOnce(new Error('offline')),
        disconnect: jest.fn(),
    };
    connect.mockResolvedValue(api);
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} active />);
    mute();
    fireEvent.change(screen.getByLabelText('Contract type'), { target: { value: 'under' } });
    fireEvent.click(screen.getByRole('button', { name: 'SCAN' }));
    await screen.findByText('Volatility 100');
    expect(screen.getByRole('status').textContent).toContain('1 unavailable');
    expect(screen.getByText(/Digits 6, 7, 8, 9/)).toBeTruthy();
});
it('cancels a pending scan without allowing its late response to overwrite status', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(value => {
        resolve = value;
    });
    const api = { send: jest.fn().mockReturnValue(pending), disconnect: jest.fn() };
    connect.mockResolvedValue(api);
    render(<MarketScanner sampleSize={100} onSelect={jest.fn()} active />);
    mute();
    fireEvent.click(screen.getByRole('button', { name: 'SCAN' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    await act(async () => {
        resolve({ active_symbols: markets });
    });
    expect(screen.getByRole('status').textContent).toBe('Scan cancelled.');
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.disconnect).toHaveBeenCalledTimes(1);
});
it('resets results when the tick sample changes', async () => {
    const api = {
        send: jest
            .fn()
            .mockResolvedValueOnce({ active_symbols: markets.slice(0, 1) })
            .mockResolvedValueOnce(over),
        disconnect: jest.fn(),
    };
    connect.mockResolvedValue(api);
    const { rerender } = render(<MarketScanner sampleSize={100} onSelect={jest.fn()} active />);
    mute();
    fireEvent.click(screen.getByRole('button', { name: 'SCAN' }));
    await screen.findByText('Volatility 100');
    rerender(<MarketScanner sampleSize={500} onSelect={jest.fn()} active />);
    expect(screen.queryByText('Volatility 100')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View digits' })).toBeNull();
});
