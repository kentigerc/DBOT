import { observeVolatilityMarkets, type LiveVolatilitySample } from '../live-volatility-markets';
import {
    watchManualMarkets,
    manualEntryReady,
    rankManualMarkets,
    manualConnectionReason,
    type ManualMarket,
} from '../manual-trader-markets';
jest.mock('../live-volatility-markets', () => ({ observeVolatilityMarkets: jest.fn() }));
it('uses Momentum’s live rising share and 20 live ticks and two-digit formation, clearing only that formation after settlement', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(2000000);
    const controller = new AbortController();
    const api = { disconnect: jest.fn() } as any;
    let update!: (sample: LiveVolatilitySample) => void;
    let invalidate!: (symbol: string) => void;
    (observeVolatilityMarkets as jest.Mock).mockImplementation((_api, _size, signal, sample, _status, options) => {
        update = sample;
        invalidate = options.stale;
        options.clock.synchronize(Math.floor(Date.now() / 1000), performance.now(), performance.now());
        return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    });
    const readings: ManualMarket[] = [];
    let after = 0;
    const watching = watchManualMarkets(
        async () => api,
        controller.signal,
        value => readings.push(value),
        jest.fn(),
        jest.fn(),
        undefined,
        () => after
    );
    await Promise.resolve();
    let digits = [...Array(180).fill(0), ...Array(600).fill(3), ...Array(220).fill(9)];
    let epoch = Date.now() / 1000;
    const emit = (live: boolean) =>
        update({ market: { symbol: 'R_100', display_name: 'Volatility 100' }, digits, epoch, live });
    try {
        emit(false);
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(false);
        for (let i = 0; i < 19; i++) {
            jest.advanceTimersByTime(1000);
            epoch++;
            digits = [...digits.slice(1), 3];
            emit(true);
        }
        expect(readings[readings.length - 1].trend).toEqual({ samples: 19, over: null, under: null });
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(false);
        jest.advanceTimersByTime(1000);
        epoch++;
        digits = [...digits.slice(1), 3];
        emit(true);
        expect(readings[readings.length - 1].trend).toEqual({ samples: 20, over: 2, under: 0 });
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(true);
        const count = readings.length;
        emit(true); // Duplicate epochs cannot count towards momentum or freshness.
        expect(readings).toHaveLength(count);
        expect(manualEntryReady(readings[readings.length - 1], 'under')).toBe(false); // Opposite side has no rising momentum.
        after = Date.now();
        jest.advanceTimersByTime(1000);
        epoch++;
        digits = [...digits.slice(1), 3];
        emit(true);
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(false);
        for (let i = 0; i < 2; i++) {
            jest.advanceTimersByTime(1000);
            epoch++;
            digits = [...digits.slice(1), 3];
            emit(true);
        }
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(true);
        expect(readings[readings.length - 1].trend.samples).toBe(20);
        invalidate('R_100');
        emit(false); // A reconnect/refill must build a new live window.
        expect(readings[readings.length - 1].trend).toEqual({ samples: 0, over: null, under: null });
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(false);
    } finally {
        controller.abort();
        await watching;
        jest.useRealTimers();
    }
    expect(api.disconnect).toHaveBeenCalled();
});

const candidate = (
    symbol: string,
    percentage: number,
    momentum: number,
    side: 'over' | 'under' = 'over'
): ManualMarket => {
    const reading = { percentage, change: 0.1, armed: true, run: 2, epoch: 2000 };
    const opposite = { ...reading, percentage: 80, change: 0 };
    return {
        symbol,
        name: symbol,
        submarket: 'random_index',
        epoch: 2000,
        checkedAt: 2000000,
        ready: true,
        count: 1000,
        ticks: [],
        digits: [],
        over: side === 'over' ? reading : opposite,
        under: side === 'under' ? reading : opposite,
        trend: { samples: 20, over: side === 'over' ? momentum : 0, under: side === 'under' ? momentum : 0 },
    };
};
it('balances share and momentum ranks across both directions with deterministic ordering', () => {
    const slow = candidate('R_10', 84, 0.1);
    const balanced = candidate('R_50', 83, 0.9, 'under');
    const third = candidate('R_100', 82, 0.6);
    const ranked = rankManualMarkets([third, slow, balanced], 2000000);
    expect(ranked.map(value => value.market.symbol)).toEqual(['R_50', 'R_10', 'R_100']);
    expect(ranked[0]).toMatchObject({ side: 'under', shareRank: 2, momentumRank: 1, score: 3, lead: 3 });
    const best = candidate('BEST', 85, 1);
    expect(rankManualMarkets([slow, best, balanced, third], 2000000)[0].market.symbol).toBe('BEST');
    const a = candidate('A', 84, 1),
        b = candidate('B', 84, 1);
    expect(rankManualMarkets([b, a], 2000000).map(value => value.market.symbol)).toEqual(['A', 'B']);
});
it.each(['over', 'under'] as const)(
    'requires a sufficient lead, sustained rise, fresh data and formation for %s',
    side => {
        const make = () => candidate('R_100', 82, 1, side);
        expect(manualEntryReady(make(), side, 2000000)).toBe(true); // Exact 2 pp lead.
        expect(manualEntryReady(make(), side, 2000000, 2.1)).toBe(false);
        expect(manualEntryReady(make(), side, 2000000, 1)).toBe(true);
        for (const invalid of [0, -1, NaN, Infinity, 101])
            expect(manualEntryReady(make(), side, 2000000, invalid)).toBe(false);
        const checks: ((market: ManualMarket) => void)[] = [
            m => {
                m[side].percentage = 81.9;
            },
            m => {
                m[side].percentage = 69.9;
                m[side === 'over' ? 'under' : 'over'].percentage = 60;
            },
            m => {
                m.trend[side] = 0;
            },
            m => {
                m.trend[side] = -0.1;
            },
            m => {
                m.trend.samples = 19;
            },
            m => {
                m[side].change = 0;
            },
            m => {
                m[side].run = 1;
            },
            m => {
                m[side].armed = false;
            },
            m => {
                m.checkedAt -= 3501;
            },
            m => {
                m.epoch -= 7;
            },
            m => {
                m.epoch += 3;
            },
            m => {
                m.ready = false;
            },
            m => {
                m.count = 999;
            },
        ];
        checks.forEach(change => {
            const m = make();
            change(m);
            expect(manualEntryReady(m, side, 2000000)).toBe(false);
        });
    }
);

it('explains failed history and provider codes without exposing arbitrary error text', () => {
    expect(
        manualConnectionReason(
            Object.assign(new Error('No fresh live Volatility feeds.'), {
                cause: new Error('Market history is incomplete.'),
            })
        )
    ).toBe('Market history is incomplete.');
    expect(manualConnectionReason({ error: { code: 'RateLimit', message: 'private provider detail' } })).toBe(
        'Market data error (RateLimit).'
    );
    expect(manualConnectionReason(new Error('wss://private.example/?token=secret'))).toBe(
        'Live market data could not be loaded.'
    );
    expect(manualConnectionReason({ code: 'bad secret token', message: 'private detail' })).toBe(
        'Live market data could not be loaded.'
    );
});

it('compares entry epochs with Deriv time while still enforcing recent arrivals', () => {
    const market = candidate('R_100', 82, 1);
    const deviceNow = 2000000 + 3600000;
    market.checkedAt = deviceNow;
    market.marketNow = () => 2000000;
    expect(manualEntryReady(market, 'over', deviceNow)).toBe(true);
    expect(manualEntryReady(market, 'over', deviceNow + 3501)).toBe(false);
    market.epoch -= 7;
    expect(manualEntryReady(market, 'over', deviceNow)).toBe(false);
    market.epoch += 7;
    market.marketNow = () => NaN;
    expect(manualEntryReady(market, 'over', deviceNow)).toBe(false);
});

it('backs off repeated initialization failures and cancels retry when stopped', async () => {
    jest.useFakeTimers();
    const controller = new AbortController(),
        status = jest.fn(),
        disconnect = jest.fn();
    const create = jest.fn(async () => ({ disconnect }) as any);
    (observeVolatilityMarkets as jest.Mock).mockRejectedValue({ code: 'RateLimit' });
    const watching = watchManualMarkets(create, controller.signal, jest.fn(), status, jest.fn());
    try {
        await jest.advanceTimersByTimeAsync(0);
        expect(status).toHaveBeenLastCalledWith(
            'Market connection interrupted. Market data error (RateLimit). Reconnecting in 2s…'
        );
        await jest.advanceTimersByTimeAsync(2000);
        expect(create).toHaveBeenCalledTimes(2);
        expect(status).toHaveBeenLastCalledWith(
            'Market connection interrupted. Market data error (RateLimit). Reconnecting in 4s…'
        );
        await jest.advanceTimersByTimeAsync(4000);
        expect(create).toHaveBeenCalledTimes(3);
        expect(status).toHaveBeenLastCalledWith(
            'Market connection interrupted. Market data error (RateLimit). Reconnecting in 8s…'
        );
        expect(disconnect).toHaveBeenCalledTimes(3);
    } finally {
        controller.abort();
        await watching;
        expect(jest.getTimerCount()).toBe(0);
        jest.useRealTimers();
    }
});
