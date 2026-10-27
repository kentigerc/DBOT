import { scanXmlParityRecovery } from '../xml-parity-recovery';
const counts = [12, 8, 12, 8, 12, 8, 12, 8, 12, 8];
const data = (values = counts) => ({
    pip_size: 2,
    history: { prices: values.flatMap((n, d) => Array(n).fill(100 + d / 100)), times: [Date.now() / 1000] },
});
const contracts = (direction = 'DIGITEVEN') => ({
    contracts_for: {
        available: [
            {
                contract_type: direction,
                expiry_type: 'tick',
                min_contract_duration: '1t',
                max_contract_duration: '10t',
            },
        ],
    },
});
const markets = { active_symbols: ['R_10', '1HZ50V'].map(symbol => ({ symbol, exchange_is_open: 1 })) };
it('scans across regular and 1-second markets, choosing a strict parity match without waiting for an entry digit', async () => {
    jest.useFakeTimers();
    const api = {
        disconnect: jest.fn(),
        send: jest.fn(async body => {
            if (body.active_symbols) return markets;
            if (body.contracts_for) return contracts();
            return body.ticks_history === 'R_10' ? data(Array(10).fill(10)) : data();
        }),
    };
    const pending = scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn());
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ symbol: '1HZ50V', direction: 'DIGITEVEN' });
    expect(api.disconnect).toHaveBeenCalled();
    expect(api.send.mock.calls.some(([body]) => body.buy)).toBe(false);
    jest.useRealTimers();
});
it('can choose Odd, and requires tick-contract availability on that market', async () => {
    const api = {
        disconnect: jest.fn(),
        send: jest.fn(async body =>
            body.active_symbols ? markets : body.contracts_for ? contracts('DIGITODD') : data([...counts].reverse())
        ),
    };
    expect(await scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn())).toMatchObject({
        direction: 'DIGITODD',
        symbol: 'R_10',
    });
});
it('STOP cancels an unanswered market request and disconnects the recovery socket', async () => {
    const controller = new AbortController();
    const api = { disconnect: jest.fn(), send: jest.fn(() => new Promise(() => {})) };
    const pending = scanXmlParityRecovery(async () => api, 100, controller.signal, jest.fn());
    await Promise.resolve();
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(api.disconnect).toHaveBeenCalled();
});
it.each(['unsupported', 'stale'])('skips a %s recovery candidate and continues to another market', async mode => {
    jest.useFakeTimers();
    const api = {
        disconnect: jest.fn(),
        send: jest.fn(async body => {
            if (body.active_symbols) return markets;
            if (body.contracts_for)
                return mode === 'unsupported' && body.contracts_for === 'R_10'
                    ? { contracts_for: { available: [] } }
                    : contracts();
            const response = data();
            if (mode === 'stale' && body.ticks_history === 'R_10') response.history.times = [Date.now() / 1000 - 30];
            return response;
        }),
    };
    const pending = scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn());
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ symbol: '1HZ50V', direction: 'DIGITEVEN' });
    jest.useRealTimers();
});
