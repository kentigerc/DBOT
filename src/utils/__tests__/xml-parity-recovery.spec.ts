import { refreshXmlParityRecovery, scanXmlParityRecovery, type RecoveryTick } from '../xml-parity-recovery';
const counts = [12, 8, 12, 8, 12, 8, 12, 8, 12, 8];
const now = 1700000000;
const data = (values = counts) => ({
    pip_size: 2,
    history: {
        prices: values
            .flatMap((n, d) => Array(n).fill(d))
            .sort((a, b) => {
                const even = values.reduce((sum, n, d) => sum + (d % 2 === 0 ? n : 0), 0);
                const selected = even >= values.reduce((sum, n) => sum + n, 0) / 2 ? 0 : 1;
                return Number(a % 2 === selected) - Number(b % 2 === selected);
            })
            .map(d => 100 + d / 100),
        times: [Date.now() / 1000 - 3],
    },
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
                response.history.prices.splice(-3, 3, ...(options.odd ? [3, 5, 7] : [2, 4, 6]).map(d => 100 + d / 100));
            if (options.stale && body.ticks_history === 'R_10') response.history.times = [Date.now() / 1000 - 30];
            if (body.subscribe && !options.manual)
                queueMicrotask(() => {
                    const epoch = Date.now() / 1000;
                    const pattern = options.odd ? [3, 5, 7] : [2, 4, 6];
                    pattern.forEach((digit, i) => emit(digit, epoch - 2 + i, String(body.ticks_history)));
                });
            return response;
        }),
    };
    return api;
}
const qualify = (api: ReturnType<typeof createApi>, symbol = 'R_10', odd = false) => {
    const epoch = Date.now() / 1000;
    (odd ? [3, 5, 7] : [2, 4, 6]).forEach((digit, i) => api.emit(digit, epoch - 2 + i, symbol));
};
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now * 1000);
});
afterEach(() => jest.useRealTimers());
it('selects a live rising parity market after three matching digits', async () => {
    const api = createApi({ neutralFirst: true });
    const pending = scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn());
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ symbol: '1HZ50V', direction: 'DIGITEVEN' });
    expect(api.disconnect).toHaveBeenCalled();
    expect(api.send.mock.calls.some(([body]) => body.buy)).toBe(false);
});
it('can choose Odd from rising percentages and three odd digits', async () => {
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
it('checks only a fresh quote on the locked market without repeating parity analysis or a formation', async () => {
    const api = createApi({ odd: true });
    const plan = { symbol: '1HZ50V', direction: 'DIGITEVEN' as const, epoch: now - 10 };
    expect(await refreshXmlParityRecovery(api, plan, new AbortController().signal)).toMatchObject({
        symbol: '1HZ50V',
        direction: 'DIGITEVEN',
        epoch: now - 3,
    });
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledWith({ ticks_history: '1HZ50V', style: 'ticks', end: 'latest', count: 1 });
});
it('rejects stale data on a locked market rather than switching markets or buying blindly', async () => {
    const api = createApi({ stale: true });
    await expect(
        refreshXmlParityRecovery(
            api,
            { symbol: 'R_10', direction: 'DIGITEVEN', epoch: now },
            new AbortController().signal
        )
    ).rejects.toThrow('data is unavailable');
});
it('STOP cancels a quote check for an already locked recovery market', async () => {
    const controller = new AbortController();
    const api = { send: jest.fn(() => new Promise<never>(() => {})) };
    const pending = refreshXmlParityRecovery(
        api,
        { symbol: 'R_10', direction: 'DIGITEVEN', epoch: now },
        controller.signal
    );
    controller.abort();
    expect(await pending).toBeUndefined();
});
it('reports and stops after three consecutive data failures rather than retrying forever', async () => {
    const create = jest.fn().mockRejectedValue(new Error('Connection unavailable'));
    const status = jest.fn();
    const pending = scanXmlParityRecovery(create, 100, new AbortController().signal, status);
    const rejected = expect(pending).rejects.toThrow('after three attempts');
    await jest.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(create).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenCalledWith(expect.stringContaining('Attempt 2/3'));
});
it('continues healthy scans without forcing an entry when no market qualifies', async () => {
    const api = createApi();
    const controller = new AbortController();
    const status = jest.fn();
    api.send.mockImplementation(async body =>
        body.active_symbols ? markets : body.contracts_for ? contracts() : data(Array(10).fill(10))
    );
    const create = jest.fn().mockResolvedValue(api);
    const pending = scanXmlParityRecovery(create, 100, controller.signal, status);
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 8; i++) {
        await jest.advanceTimersByTimeAsync(1000);
        api.emit(i % 2, now + i, 'R_10');
        api.emit(i % 2, now + i, '1HZ50V');
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(expect.stringContaining('2/2 Volatility markets live'));
    controller.abort();
    expect(await pending).toBeUndefined();
});
it('selects a supported market only after its fresh rising formation qualifies', async () => {
    const api = createApi({ manual: true });
    api.send.mockImplementation(async body =>
        body.active_symbols
            ? markets
            : body.contracts_for
              ? contracts()
              : data(body.ticks_history === 'R_10' ? [11, 9, 11, 9, 11, 9, 11, 9, 11, 9] : counts)
    );
    const pending = scanXmlParityRecovery(async () => api, 100, new AbortController().signal, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    qualify(api, '1HZ50V');
    expect(await pending).toMatchObject({ symbol: '1HZ50V', direction: 'DIGITEVEN' });
    expect(api.disconnect).toHaveBeenCalled();
});
it('retains all live feeds between independent loss episodes but requires a fresh formation', async () => {
    const api = createApi({ manual: true });
    const create = jest.fn().mockResolvedValue(api);
    let active = true;
    let changed!: () => void;
    const unsubscribe = jest.fn();
    const scope = {
        key: 700,
        valid: () => active,
        subscribe: (listener: () => void) => {
            changed = listener;
            return unsubscribe;
        },
    };
    const first = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn(), scope);
    await jest.advanceTimersByTimeAsync(0);
    qualify(api);
    expect(await first).toMatchObject({ symbol: 'R_10', direction: 'DIGITEVEN' });
    expect(api.disconnect).not.toHaveBeenCalled();
    const requests = api.send.mock.calls.length;
    const next = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn(), scope);
    await jest.advanceTimersByTimeAsync(3000);
    qualify(api, '1HZ50V');
    expect(await next).toMatchObject({ symbol: '1HZ50V', direction: 'DIGITEVEN' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls.length).toBe(requests);
    active = false;
    changed();
    expect(api.disconnect).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
});
it('cancels a pending selection without destroying the session feeds, then releases them on session STOP', async () => {
    const api = createApi({ manual: true });
    api.send.mockImplementation(async body =>
        body.active_symbols ? markets : body.contracts_for ? contracts() : data(Array(10).fill(10))
    );
    const create = jest.fn().mockResolvedValue(api);
    let active = true;
    let changed!: () => void;
    const scope = {
        key: 701,
        valid: () => active,
        subscribe: (listener: () => void) => {
            changed = listener;
            return jest.fn();
        },
    };
    const attempt = new AbortController();
    const pending = scanXmlParityRecovery(create, 100, attempt.signal, jest.fn(), scope);
    await jest.advanceTimersByTimeAsync(0);
    attempt.abort();
    expect(await pending).toBeUndefined();
    expect(api.disconnect).not.toHaveBeenCalled();
    const waiting = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn(), scope);
    active = false;
    changed();
    expect(await waiting).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.disconnect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
});
it('discards cached candidates immediately on disconnect before reconnecting all feeds', async () => {
    const firstApi = createApi({ manual: true }),
        replacement = createApi({ manual: true });
    const create = jest.fn().mockResolvedValueOnce(firstApi).mockResolvedValue(replacement);
    let active = true;
    let changed!: () => void;
    const scope = {
        key: 702,
        valid: () => active,
        subscribe: (listener: () => void) => {
            changed = listener;
            return () => {};
        },
    };
    const first = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn(), scope);
    await jest.advanceTimersByTimeAsync(0);
    qualify(firstApi);
    expect(await first).toBeDefined();
    firstApi.connection.dispatchEvent(new Event('close'));
    let resolved = false;
    const next = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn(), scope).then(plan => {
        resolved = true;
        return plan;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    qualify(replacement);
    expect(await next).toMatchObject({ symbol: 'R_10' });
    expect(create).toHaveBeenCalledTimes(2);
    active = false;
    changed();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
});
it('retries fresh connections for a new recovery after the idle cache exhausted its retry budget', async () => {
    const api = createApi({ manual: true }),
        restored = createApi({ manual: true });
    const create = jest
        .fn()
        .mockResolvedValueOnce(api)
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(restored);
    let active = true,
        changed!: () => void;
    const scope = {
        key: 703,
        valid: () => active,
        subscribe: (listener: () => void) => {
            changed = listener;
            return () => {};
        },
    };
    const first = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn(), scope);
    await jest.advanceTimersByTimeAsync(0);
    qualify(api);
    expect(await first).toBeDefined();
    // No recovery order is waiting when the feed closes and its idle retries fail.
    api.connection.dispatchEvent(new Event('close'));
    await jest.advanceTimersByTimeAsync(3000);
    expect(create).toHaveBeenCalledTimes(3);
    const next = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn(), scope);
    await jest.advanceTimersByTimeAsync(0);
    qualify(restored);
    expect(await next).toMatchObject({ symbol: 'R_10' });
    expect(create).toHaveBeenCalledTimes(4);
    active = false;
    changed();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
});
it('reports a safe provider error code without exposing raw provider messages', async () => {
    const create = jest.fn().mockRejectedValue({ error: { code: 'RateLimit', message: 'private-detail' } });
    const pending = scanXmlParityRecovery(create, 100, new AbortController().signal, jest.fn());
    const rejected = expect(pending).rejects.toThrow('provider RateLimit');
    await jest.advanceTimersByTimeAsync(3000);
    await rejected;
});
