import { observeVolatilityMarkets } from '../live-volatility-markets';
const now = 1700000000;
function fixture() {
    let callback: (event: { data: any }) => void = () => {};
    const unsubscribe = jest.fn(() => {
        callback = () => {};
    });
    const api = {
        connection: new EventTarget(),
        onMessage: () => ({
            subscribe: (next: typeof callback) => {
                callback = next;
                return { unsubscribe };
            },
        }),
        send: jest.fn(async (body: Record<string, unknown>): Promise<any> => {
            if (body.active_symbols)
                return { active_symbols: ['R_10', '1HZ50V', 'R_100'].map(symbol => ({ symbol, exchange_is_open: 1 })) };
            return { pip_size: 2, history: { prices: Array(100).fill(100.01), times: [Date.now() / 1000 - 1] } };
        }),
        tick: (symbol: string, digit: number, epoch = Date.now() / 1000) =>
            callback({ data: { tick: { symbol, quote: 100 + digit / 100, pip_size: 2, epoch } } }),
        unsubscribe,
    };
    return api;
}
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now * 1000);
});
afterEach(() => jest.useRealTimers());
it('keeps every market subscribed and evaluates interleaved ticks without polling', async () => {
    const api = fixture(),
        controller = new AbortController(),
        sample = jest.fn();
    const pending = observeVolatilityMarkets(api, 100, controller.signal, sample, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(sample).toHaveBeenCalledTimes(3);
    expect(api.send.mock.calls.filter(([body]) => body.ticks_history)).toHaveLength(3);
    expect(api.send.mock.calls.filter(([body]) => body.ticks_history).every(([body]) => body.subscribe === 1)).toBe(
        true
    );
    api.tick('1HZ50V', 4);
    api.tick('R_10', 7);
    api.tick('R_100', 2);
    expect(sample.mock.calls.slice(-3).map(([s]) => [s.market.symbol, s.digits.at(-1), s.live])).toEqual([
        ['1HZ50V', 4, true],
        ['R_10', 7, true],
        ['R_100', 2, true],
    ]);
    controller.abort();
    await pending;
    api.tick('R_10', 9, now + 1);
    expect(sample).toHaveBeenCalledTimes(6);
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});
it('a slow first market does not block the other live feeds', async () => {
    const api = fixture(),
        send = api.send,
        controller = new AbortController(),
        sample = jest.fn();
    api.send = jest.fn(body => (body.ticks_history === 'R_10' ? new Promise(() => {}) : send(body)));
    const pending = observeVolatilityMarkets(api, 100, controller.signal, sample, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(sample.mock.calls.map(([s]) => s.market.symbol)).toEqual(['1HZ50V', 'R_100']);
    api.tick('R_100', 2);
    expect(sample.mock.calls[sample.mock.calls.length - 1]?.[0]).toMatchObject({
        live: true,
        market: { symbol: 'R_100' },
    });
    controller.abort();
    await pending;
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
});
it('removes stale feeds while healthy markets keep updating, and fails when all feeds stall', async () => {
    const api = fixture(),
        controller = new AbortController(),
        stale = jest.fn();
    const pending = observeVolatilityMarkets(api, 100, controller.signal, jest.fn(), jest.fn(), { stale });
    const result = expect(pending).rejects.toThrow('became stale');
    await jest.advanceTimersByTimeAsync(5000);
    api.tick('R_10', 4);
    await jest.advanceTimersByTimeAsync(2000);
    expect(stale.mock.calls.map(([symbol]) => symbol)).toEqual(['1HZ50V', 'R_100']);
    await jest.advanceTimersByTimeAsync(5000);
    await result;
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
});
it('rejects a closed connection and cancels pending initialization', async () => {
    const api = fixture();
    api.send = jest.fn((_body: Record<string, unknown>) => new Promise(() => {}));
    const pending = observeVolatilityMarkets(api, 100, new AbortController().signal, jest.fn(), jest.fn());
    const result = expect(pending).rejects.toThrow('connection unavailable');
    api.connection.dispatchEvent(new Event('close'));
    await result;
    expect(jest.getTimerCount()).toBe(0);
});
it('refills one stalled feed without disconnecting the other live markets', async () => {
    const api = fixture(),
        send = api.send,
        controller = new AbortController(),
        sample = jest.fn();
    api.send = jest.fn(async body => {
        if (body.forget) return {};
        const response = await send(body);
        return body.ticks_history ? { ...response, subscription: { id: String(body.ticks_history) } } : response;
    });
    const pending = observeVolatilityMarkets(api, 100, controller.signal, sample, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 13; i++) {
        await jest.advanceTimersByTimeAsync(1000);
        api.tick('R_10', 1);
        api.tick('R_100', 1);
    }
    expect(api.send).toHaveBeenCalledWith({ forget: '1HZ50V' });
    expect(api.send.mock.calls.filter(([body]) => body.ticks_history === '1HZ50V')).toHaveLength(2);
    expect(api.send.mock.calls.filter(([body]) => body.ticks_history === 'R_10')).toHaveLength(1);
    controller.abort();
    await pending;
    expect(jest.getTimerCount()).toBe(0);
});

it('does not wait for a discovery timeout if the socket already closed before observation started', async () => {
    const api = fixture();
    Object.assign(api.connection, { readyState: 3 });
    await expect(
        observeVolatilityMarkets(api, 100, new AbortController().signal, jest.fn(), jest.fn())
    ).rejects.toThrow('connection unavailable');
    expect(api.send).not.toHaveBeenCalled();
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

it('preserves provider error codes instead of reporting rejected discovery as an empty market list', async () => {
    const api = fixture();
    api.send = jest.fn(async (_body: Record<string, unknown>) => ({
        error: { code: 'RateLimit', message: 'provider detail' },
    }));
    await expect(
        observeVolatilityMarkets(api, 100, new AbortController().signal, jest.fn(), jest.fn())
    ).rejects.toMatchObject({ code: 'RateLimit' });
    expect(jest.getTimerCount()).toBe(0);
});

it('preserves the failed history reason when no market can be initialized', async () => {
    const api = fixture(),
        send = api.send;
    api.send = jest.fn(async body =>
        body.active_symbols
            ? send(body)
            : {
                  pip_size: 2,
                  history: { prices: Array(100).fill(100.01), times: [now - 30] },
              }
    );
    await expect(
        observeVolatilityMarkets(api, 100, new AbortController().signal, jest.fn(), jest.fn())
    ).rejects.toMatchObject({
        message: 'No fresh live Volatility feeds.',
        cause: expect.objectContaining({ message: 'Market history timestamps are delayed. Check your device clock.' }),
    });
    expect(jest.getTimerCount()).toBe(0);
});

it('records a socket close code without including the remote close reason', async () => {
    const api = fixture(),
        controller = new AbortController();
    const pending = observeVolatilityMarkets(api, 100, controller.signal, jest.fn(), jest.fn());
    const result = expect(pending).rejects.toMatchObject({ code: 'Socket1006' });
    api.connection.dispatchEvent(new CloseEvent('close', { code: 1006, reason: 'private remote detail' }));
    await result;
    expect(jest.getTimerCount()).toBe(0);
});
