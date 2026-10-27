import { scanXmlParityRecovery, waitForXmlParityFormation, type RecoveryTick } from '../xml-parity-recovery';
const counts = [12, 8, 12, 8, 12, 8, 12, 8, 12, 8];
const now = 1700000000;
const data = (values = counts) => ({
    pip_size: 2,
    history: { prices: values.flatMap((n, d) => Array(n).fill(100 + d / 100)), times: [Date.now() / 1000 - 3] },
    subscription: { id: 'feed' },
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
function createApi(
    options: { odd?: boolean; neutralFirst?: boolean; unsupported?: boolean; stale?: boolean; manual?: boolean } = {}
) {
    let listener: ((message: { data: { tick: RecoveryTick } }) => void) | undefined;
    const emit = (digit: number, epoch: number, symbol = 'R_10') =>
        listener?.({ data: { tick: { symbol, quote: 100 + digit / 100, pip_size: 2, epoch } } });
    const api = {
        connection: new EventTarget(),
        disconnect: jest.fn(),
        emit,
        onMessage: () => ({
            subscribe: (callback: typeof listener) => {
                listener = callback;
                return {
                    unsubscribe: () => {
                        listener = undefined;
                    },
                };
            },
        }),
        send: jest.fn(async (body: Record<string, unknown>) => {
            if (body.active_symbols) return markets;
            if (body.contracts_for)
                return options.unsupported && body.contracts_for === 'R_10'
                    ? { contracts_for: { available: [] } }
                    : contracts(options.odd ? 'DIGITODD' : 'DIGITEVEN');
            const response = data(
                options.neutralFirst && body.ticks_history === 'R_10'
                    ? Array(10).fill(10)
                    : options.odd
                      ? [...counts].reverse()
                      : counts
            );
            if (options.manual)
                response.history.prices.splice(-3, 3, ...(options.odd ? [3, 5, 2] : [2, 4, 1]).map(d => 100 + d / 100));
            if (options.stale && body.ticks_history === 'R_10') response.history.times = [Date.now() / 1000 - 30];
            if (body.subscribe && !options.manual)
                queueMicrotask(() => {
                    const epoch = Date.now() / 1000;
                    const pattern = options.odd ? [3, 5, 2] : [2, 4, 1];
                    pattern.forEach((digit, i) => emit(digit, epoch - 2 + i, String(body.ticks_history)));
                });
            return response;
        }),
    };
    return api;
}
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now * 1000);
});
afterEach(() => jest.useRealTimers());
it('scans regular and 1-second markets and buys eligibility only after a fresh parity formation', async () => {
    const api = createApi({ neutralFirst: true });
    const pending = scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn());
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ symbol: '1HZ50V', direction: 'DIGITEVEN' });
    expect(api.disconnect).toHaveBeenCalled();
    expect(api.send.mock.calls.some(([body]) => body.buy)).toBe(false);
});
it('can choose Odd after Odd–Odd–Even', async () => {
    const api = createApi({ odd: true });
    const pending = scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ direction: 'DIGITODD', symbol: 'R_10' });
});
it('STOP cancels an unanswered market request and disconnects the recovery socket', async () => {
    const controller = new AbortController();
    const api = { ...createApi(), send: jest.fn(() => new Promise<never>(() => {})) };
    const pending = scanXmlParityRecovery(async () => api, 100, controller.signal, jest.fn());
    await Promise.resolve();
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(api.disconnect).toHaveBeenCalled();
});
it.each(['unsupported', 'stale'] as const)('skips a %s candidate and continues scanning', async mode => {
    const api = createApi({ [mode]: true });
    const pending = scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn());
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ symbol: '1HZ50V', direction: 'DIGITEVEN' });
});
it.each([false, true])('waits for three new consecutive ticks instead of using history (Odd=%s)', async odd => {
    const api = createApi({ manual: true, odd });
    const controller = new AbortController();
    let finished = false;
    const pending = waitForXmlParityFormation(
        api,
        body => api.send(body),
        'R_10',
        odd ? 'DIGITODD' : 'DIGITEVEN',
        100,
        controller.signal,
        jest.fn()
    ).then(plan => {
        finished = true;
        return plan;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    api.emit(odd ? 3 : 2, now - 2);
    api.emit(odd ? 5 : 4, now - 1);
    await jest.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    api.emit(odd ? 2 : 1, now);
    expect(await pending).toMatchObject({ direction: odd ? 'DIGITODD' : 'DIGITEVEN', epoch: now });
});
it('STOP during formation cancels the entry without completing it', async () => {
    const api = createApi({ manual: true });
    const controller = new AbortController();
    const pending = waitForXmlParityFormation(
        api,
        body => api.send(body),
        'R_10',
        'DIGITEVEN',
        100,
        controller.signal,
        jest.fn()
    );
    await jest.advanceTimersByTimeAsync(0);
    api.emit(2, now - 2);
    api.emit(4, now - 1);
    controller.abort();
    api.emit(1, now);
    expect(await pending).toBeUndefined();
});
it('a stalled formation feed cannot authorize an entry', async () => {
    const api = createApi({ manual: true });
    const pending = waitForXmlParityFormation(
        api,
        body => api.send(body),
        'R_10',
        'DIGITEVEN',
        100,
        new AbortController().signal,
        jest.fn()
    );
    const rejected = expect(pending).rejects.toThrow('live feed unavailable');
    await jest.advanceTimersByTimeAsync(7000);
    await rejected;
});

it('a broken sequence does not enter until a new consecutive EEO is observed', async () => {
    const api = createApi({ manual: true });
    const response = data();
    response.history.times = [now - 5];
    api.send.mockResolvedValue(response);
    let entered = false;
    const pending = waitForXmlParityFormation(
        api,
        body => api.send(body),
        'R_10',
        'DIGITEVEN',
        100,
        new AbortController().signal,
        jest.fn()
    ).then(plan => {
        entered = true;
        return plan;
    });
    await jest.advanceTimersByTimeAsync(0);
    [2, 1, 4, 6, 8].forEach((digit, i) => api.emit(digit, now - 4 + i));
    await jest.advanceTimersByTimeAsync(0);
    expect(entered).toBe(false);
    api.emit(3, now + 1);
    expect(await pending).toMatchObject({ direction: 'DIGITEVEN' });
});
it('abandons an entry if parity percentages cease to qualify during observation', async () => {
    const api = createApi({ manual: true });
    api.send.mockResolvedValue(data([11, 9, 11, 9, 11, 9, 11, 9, 10, 10]));
    const pending = waitForXmlParityFormation(
        api,
        body => api.send(body),
        'R_10',
        'DIGITEVEN',
        100,
        new AbortController().signal,
        jest.fn()
    );
    await jest.advanceTimersByTimeAsync(0);
    api.emit(1, now - 2);
    expect(await pending).toBeUndefined();
});
