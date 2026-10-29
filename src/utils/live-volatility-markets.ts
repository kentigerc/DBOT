import { lastDigit } from '@/pages/digit-analysis/digits';

export type VolatilityMarket = {
    symbol: string;
    display_name?: string;
    submarket?: string;
    exchange_is_open?: number;
    is_trading_suspended?: number;
};
type Tick = { symbol?: string; underlying_symbol?: string; quote: number; pip_size: number; epoch: number };
type Response = {
    tick?: Tick;
    error?: unknown;
    active_symbols?: VolatilityMarket[];
    history?: { prices?: number[]; times?: number[] };
    pip_size?: number;
    subscription?: { id: string };
};
export type VolatilityApi = {
    connection?: EventTarget;
    onMessage: () => { subscribe: (fn: (event: { data: Response }) => void) => { unsubscribe: () => void } };
    send: (body: Record<string, unknown>) => Promise<Response>;
};
export type LiveVolatilitySample = { market: VolatilityMarket; digits: number[]; epoch: number; live: boolean };
export const freshVolatilityEpoch = (epoch: number) =>
    Number.isFinite(epoch) && epoch <= Date.now() / 1000 + 2 && Date.now() / 1000 - epoch <= 6;

// One socket, one rolling subscription per market. Discovery requests are bounded;
// once seeded, every market is evaluated on its own arriving ticks, without polling.
export async function observeVolatilityMarkets(
    api: VolatilityApi,
    sampleSize: number,
    signal: AbortSignal,
    sample: (value: LiveVolatilitySample) => void,
    status: (message: string) => void,
    options: {
        prepare?: (market: VolatilityMarket) => Promise<boolean>;
        stale?: (symbol: string) => void;
        ready?: () => void;
    } = {}
): Promise<void> {
    type Feed = {
        market: VolatilityMarket;
        digits: number[];
        epoch: number;
        arrival: number;
        ready: boolean;
        queue: Tick[];
        failed: boolean;
        busy: boolean;
        unsupported: boolean;
        retryAt: number;
        subscriptionId?: string;
    };
    const feeds = new Map<string, Feed>();
    const pending = new AbortController();
    const requestSignal = pending.signal;
    let failure: Error | undefined;
    let lastFeedFailure: unknown;
    let finished = false,
        initialized = false,
        cursor = 0;
    let resolve!: () => void, reject!: (reason: Error) => void;
    const done = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void done.catch(() => {});
    const finish = (reason?: Error) => {
        if (finished) return;
        finished = true;
        failure = reason;
        reason ? reject(reason) : resolve();
        pending.abort();
    };
    const abort = () => finish();
    const closed = () => finish(new Error('Live market connection unavailable.'));
    const invalidate = (feed: Feed) => {
        if (feed.failed) return;
        feed.failed = true;
        feed.retryAt = Date.now() + 5000;
        options.stale?.(feed.market.symbol);
    };
    const publish = (feed: Feed, live: boolean) => {
        if (finished || signal.aborted || feed.failed) return;
        sample({ market: feed.market, digits: [...feed.digits], epoch: feed.epoch, live });
    };
    const accept = (feed: Feed, tick: Tick) => {
        if (finished || signal.aborted || feed.failed || tick.epoch <= feed.epoch) return;
        const digit = lastDigit(tick.quote, tick.pip_size);
        if (digit === null || !freshVolatilityEpoch(tick.epoch) || tick.epoch - feed.epoch > 6) {
            invalidate(feed);
            return;
        }
        feed.epoch = tick.epoch;
        feed.arrival = Date.now();
        feed.digits = [...feed.digits, digit].slice(-sampleSize);
        publish(feed, true);
    };
    const request = async (body: Record<string, unknown>) => {
        if (finished || signal.aborted) throw new Error('Market observation stopped.');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
            return await Promise.race([
                api.send(body),
                new Promise<never>((_, no) => {
                    cancel = () => no(new Error('Market observation stopped.'));
                    requestSignal.addEventListener('abort', cancel, { once: true });
                    if (requestSignal.aborted) cancel();
                    timer = setTimeout(() => no(new Error('Market data request timed out.')), 15000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            requestSignal.removeEventListener('abort', cancel);
        }
    };
    signal.addEventListener('abort', abort, { once: true });
    api.connection?.addEventListener('close', closed);
    api.connection?.addEventListener('error', closed);
    const listener = api.onMessage().subscribe(({ data }) => {
        if (finished || signal.aborted || !data.tick) return;
        const feed = feeds.get(data.tick.symbol || data.tick.underlying_symbol || '');
        if (!feed || (feed.failed && !feed.busy)) return;
        if (!feed.ready) feed.queue.push(data.tick);
        else accept(feed, data.tick);
    });
    let refilling = 0;
    const seed = async (feed: Feed) => {
        if (finished || signal.aborted || feed.busy) return;
        const market = feed.market;
        feed.busy = true;
        feed.ready = false;
        feed.queue = [];
        try {
            if (options.prepare && !(await options.prepare(market))) {
                invalidate(feed);
                feed.unsupported = true;
                return;
            }
            if (feed.subscriptionId) {
                await request({ forget: feed.subscriptionId });
                feed.subscriptionId = undefined;
            }
            const h = await request({
                ticks_history: market.symbol,
                style: 'ticks',
                end: 'latest',
                count: sampleSize,
                subscribe: 1,
            });
            if (finished || signal.aborted) return;
            feed.subscriptionId = h.subscription?.id;
            const prices = h.history?.prices,
                times = h.history?.times;
            const epoch = Number(times?.slice(-1)[0]);
            if (
                !Array.isArray(prices) ||
                prices.length < sampleSize ||
                !Number.isInteger(h.pip_size) ||
                !freshVolatilityEpoch(epoch)
            )
                throw new Error('Invalid market history.');
            const digits = prices.slice(-sampleSize).map(price => lastDigit(price, h.pip_size!));
            if (digits.some(d => d === null)) throw new Error('Invalid market digits.');
            feed.digits = digits as number[];
            feed.epoch = epoch;
            feed.arrival = Date.now();
            feed.ready = true;
            feed.failed = false;
            publish(feed, false);
            feed.queue.forEach(tick => accept(feed, tick));
            feed.queue = [];
        } catch (error) {
            lastFeedFailure = error;
            if (!finished && !signal.aborted) {
                invalidate(feed);
                feed.retryAt = Date.now() + 5000;
            }
        } finally {
            feed.busy = false;
        }
    };
    let lastStatus = 0;
    const watchdog = setInterval(() => {
        if (finished) return;
        for (const feed of feeds.values()) if (feed.ready && Date.now() - feed.arrival > 6000) invalidate(feed);
        const live = [...feeds.values()].filter(f => f.ready && !f.failed).length;
        if (initialized && !live) finish(new Error('All live Volatility feeds became stale.'));
        else if (Date.now() - lastStatus >= 5000) {
            lastStatus = Date.now();
            status(
                feeds.size
                    ? `Observing ${live}/${feeds.size} Volatility markets live · All feeds checked as ticks arrive.`
                    : 'Loading simultaneous market feeds…'
            );
        }
        if (initialized && live && !finished) {
            for (const feed of feeds.values()) {
                if (refilling >= 3) break;
                if (feed.failed && !feed.busy && !feed.unsupported && Date.now() >= feed.retryAt) {
                    refilling++;
                    void seed(feed).finally(() => {
                        refilling--;
                    });
                }
            }
        }
    }, 1000);
    try {
        if (signal.aborted) return;
        const response = await request({ active_symbols: 'brief' });
        const markets = (response.active_symbols || []).filter(
            m => /^(R_\d+|1HZ\d+V)$/.test(m.symbol) && m.exchange_is_open && !m.is_trading_suspended
        );
        if (!markets.length) throw new Error('No available Volatility markets.');
        markets.forEach(market =>
            feeds.set(market.symbol, {
                market,
                digits: [],
                epoch: 0,
                arrival: Date.now(),
                ready: false,
                queue: [],
                failed: false,
                busy: false,
                unsupported: false,
                retryAt: 0,
            })
        );
        const worker = async () => {
            while (!finished && !signal.aborted && cursor < markets.length) {
                const market = markets[cursor++];
                await seed(feeds.get(market.symbol)!);
            }
        };
        await Promise.race([Promise.all(Array.from({ length: Math.min(3, markets.length) }, worker)), done]);
        initialized = true;
        if (!finished && !signal.aborted) options.ready?.();
        if (!finished && ![...feeds.values()].some(f => f.ready && !f.failed))
            throw Object.assign(new Error('No fresh live Volatility feeds.'), { cause: lastFeedFailure });
        await done;
    } catch (error) {
        if (!signal.aborted) throw failure || error;
    } finally {
        finished = true;
        pending.abort();
        clearInterval(watchdog);
        listener.unsubscribe();
        signal.removeEventListener('abort', abort);
        api.connection?.removeEventListener('close', closed);
        api.connection?.removeEventListener('error', closed);
    }
}
