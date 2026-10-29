import { parityRecoveryDirection } from '@/services/digit-strategy/strategy';
import { freshVolatilityEpoch, observeVolatilityMarkets } from './live-volatility-markets';
import { lastDigit } from '@/pages/digit-analysis/digits';
export type RecoveryTick = {
    symbol?: string;
    underlying_symbol?: string;
    quote: number;
    epoch: number;
    pip_size: number;
};
type RecoveryResponse = {
    tick?: RecoveryTick;
    error?: unknown;
    subscription?: { id: string };
    active_symbols?: {
        symbol: string;
        display_name?: string;
        exchange_is_open: number;
        is_trading_suspended?: number;
    }[];
    history?: { prices?: number[]; times?: number[] };
    pip_size?: number;
    contracts_for?: {
        available?: {
            contract_type: string;
            expiry_type: string;
            min_contract_duration: string;
            max_contract_duration: string;
        }[];
    };
};
type Api = {
    connection?: EventTarget;
    onMessage: () => {
        subscribe: (callback: (message: { data: RecoveryResponse }) => void) => { unsubscribe: () => void };
    };
    send: (body: Record<string, unknown>) => Promise<RecoveryResponse>;
    disconnect: () => void;
};
export type ParityRecovery = { symbol: string; direction: 'DIGITEVEN' | 'DIGITODD'; epoch: number };
const fresh = (epoch: number) =>
    Number.isFinite(epoch) && Date.now() / 1000 - epoch <= 6 && epoch <= Date.now() / 1000 + 2;
export async function waitForXmlParityFormation(
    api: Api,
    request: (body: Record<string, unknown>) => Promise<RecoveryResponse>,
    symbol: string,
    direction: 'DIGITEVEN' | 'DIGITODD',
    sampleSize: number,
    signal: AbortSignal,
    status: (message: string) => void
): Promise<ParityRecovery | undefined> {
    let ready = false,
        finished = false;
    let digits: number[] = [],
        pattern: number[] = [];
    let lastEpoch = 0,
        lastArrival = Date.now();
    let subscriptionId: string | undefined;
    let resolve!: (plan?: ParityRecovery) => void, reject!: (error: Error) => void;
    const result = new Promise<ParityRecovery | undefined>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void result.catch(() => {});
    const finish = (plan?: ParityRecovery) => {
        if (!finished) {
            finished = true;
            resolve(plan);
        }
    };
    const fail = () => {
        if (!finished) {
            finished = true;
            reject(new Error('Recovery live feed unavailable'));
        }
    };
    const abort = () => finish();
    const queued: RecoveryTick[] = [];
    const accept = (tick: RecoveryTick) => {
        if (finished || signal.aborted || tick.epoch <= lastEpoch) return;
        const digit = lastDigit(tick.quote, tick.pip_size);
        if (digit === null || !fresh(tick.epoch) || tick.epoch - lastEpoch > 6) {
            fail();
            return;
        }
        lastEpoch = tick.epoch;
        lastArrival = Date.now();
        digits = [...digits, digit].slice(-sampleSize);
        const counts = Array<number>(10).fill(0);
        digits.forEach(value => counts[value]++);
        if (parityRecoveryDirection(counts) !== direction) {
            status(`Recovery candidate changed · ${symbol} · Continuing market search.`);
            finish();
            return;
        }
        pattern = [...pattern, digit % 2].slice(-3);
        const chosen = direction === 'DIGITEVEN' ? 0 : 1;
        if (pattern.length === 3 && pattern[0] === chosen && pattern[1] === chosen && pattern[2] !== chosen) {
            status(`Recovery entry ready · ${symbol}`);
            finish({ symbol, direction, epoch: lastEpoch });
        }
    };
    signal.addEventListener('abort', abort, { once: true });
    api.connection?.addEventListener('close', fail);
    api.connection?.addEventListener('error', fail);
    const listener = api.onMessage().subscribe(({ data }) => {
        if (finished) return;
        if (data.error) {
            fail();
            return;
        }
        if (!data.tick) return;
        const market = data.tick.symbol || data.tick.underlying_symbol;
        if (market && market !== symbol) return;
        if (!ready) queued.push(data.tick);
        else accept(data.tick);
    });
    let lastStatus = Date.now();
    const watchdog = setInterval(() => {
        if (ready && Date.now() - lastArrival > 6000) fail();
        else if (ready && !finished && Date.now() - lastStatus >= 10000) {
            lastStatus = Date.now();
            status(`Waiting for recovery entry · ${symbol} · Live data current.`);
        }
    }, 1000);
    try {
        if (signal.aborted) return;
        status(`Waiting for recovery entry · ${symbol}`);
        const response = await request({
            ticks_history: symbol,
            style: 'ticks',
            end: 'latest',
            count: sampleSize,
            subscribe: 1,
        });
        subscriptionId = response.subscription?.id;
        if (finished || signal.aborted) return await result;
        const prices = response.history?.prices;
        lastEpoch = Number(response.history?.times?.slice(-1)[0]);
        if (
            !Array.isArray(prices) ||
            prices.length < sampleSize ||
            !Number.isInteger(response.pip_size) ||
            !fresh(lastEpoch)
        ) {
            fail();
            return await result;
        }
        const parsed = prices.slice(-sampleSize).map(price => lastDigit(price, response.pip_size!));
        if (parsed.some(d => d === null)) {
            fail();
            return await result;
        }
        digits = parsed as number[];
        const counts = Array<number>(10).fill(0);
        digits.forEach(d => counts[d]++);
        if (parityRecoveryDirection(counts) !== direction) return;
        ready = true;
        lastArrival = Date.now();
        queued.forEach(accept);
        return await result;
    } finally {
        finished = true;
        clearInterval(watchdog);
        listener.unsubscribe();
        signal.removeEventListener('abort', abort);
        api.connection?.removeEventListener('close', fail);
        api.connection?.removeEventListener('error', fail);
        if (subscriptionId && !signal.aborted) void api.send({ forget: subscriptionId }).catch(() => {});
    }
}

// Legacy quote-check helper. XML Auto's current recovery path uses a fresh
// percentage scan for every attempt instead of this locked-market policy.
export async function refreshXmlParityRecovery(
    api: Pick<Api, 'send'>,
    plan: ParityRecovery,
    signal: AbortSignal
): Promise<ParityRecovery | undefined> {
    if (signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    try {
        const response = await Promise.race([
            api.send({ ticks_history: plan.symbol, style: 'ticks', end: 'latest', count: 1 }),
            new Promise<never>((_, reject) => {
                cancel = () => reject(new Error('Recovery cancelled'));
                signal.addEventListener('abort', cancel, { once: true });
                if (signal.aborted) cancel();
                timer = setTimeout(() => reject(new Error('Recovery market data timed out.')), 15000);
            }),
        ]);
        if (signal.aborted) return;
        const epoch = Number(response.history?.times?.slice(-1)[0]);
        const price = response.history?.prices?.slice(-1)[0];
        if (
            price === undefined ||
            !Number.isInteger(response.pip_size) ||
            lastDigit(price, response.pip_size!) === null ||
            !fresh(epoch)
        )
            throw new Error('Recovery market data is unavailable. No recovery trade was submitted.');
        return { ...plan, epoch };
    } catch (error) {
        if (!signal.aborted) throw error;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
    }
}

export type XmlRecoveryScope = {
    key: number;
    valid: () => boolean;
    subscribe: (listener: () => void) => () => void;
};

type RecoveryScanner = ReturnType<typeof createRecoveryScanner>;
let retained: { key: number; sampleSize: number; scanner: RecoveryScanner; unsubscribe: () => void } | undefined;

// Keep every recovery feed warm for the active XML Auto session. Each purchase
// reselects the best current percentage without repeating discovery/history loads.
function recoveryDataReason(error: unknown, depth = 0): string {
    if (depth > 2) return 'market data request failed';
    const value = error as
        | { code?: unknown; error?: { code?: unknown }; cause?: unknown; message?: unknown }
        | undefined;
    const code = value?.error?.code ?? value?.code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)) return `provider ${code}`;
    if (value?.cause) return recoveryDataReason(value.cause, depth + 1);
    const reasons: Record<string, string> = {
        'No fresh live Volatility feeds.': 'fresh market histories unavailable',
        'All live Volatility feeds became stale.': 'live market ticks stalled',
        'No available Volatility markets.': 'no available Volatility markets',
        'Live market connection unavailable.': 'market data connection closed',
        'Market data request timed out.': 'market data request timed out',
        'Recovery market request timed out': 'market capability request timed out',
        'Invalid market history.': 'incomplete or stale market history',
        'Invalid market digits.': 'invalid market prices',
    };
    return (typeof value?.message === 'string' && reasons[value.message]) || 'market data request failed';
}

function createRecoveryScanner(createApi: () => Promise<Api>, sampleSize: number) {
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    let api: Api | undefined;
    let initialized = false,
        failures = 0;
    let fatal: Error | undefined;
    let message = 'Loading simultaneous recovery feeds…';
    const candidates = new Map<string, { plan: ParityRecovery; share: number }>();
    let waiter:
        | {
              resolve: (plan?: ParityRecovery) => void;
              reject: (reason: Error) => void;
              status: (text: string) => void;
              cleanup: () => void;
          }
        | undefined;
    const settle = (plan?: ParityRecovery, error?: Error) => {
        const waiting = waiter;
        waiter = undefined;
        waiting?.cleanup();
        if (error) waiting?.reject(error);
        else waiting?.resolve(plan);
    };
    const status = (text: string) => {
        message = text;
        waiter?.status(text);
    };
    const select = () => {
        if (!waiter || !initialized || signal.aborted || fatal) return;
        const best = [...candidates.values()]
            .filter(c => freshVolatilityEpoch(c.plan.epoch))
            .sort((a, b) => b.share - a.share)[0];
        if (!best) return;
        waiter.status(`Recovery entry ready · ${best.plan.symbol}`);
        settle({ ...best.plan });
    };
    const request = async (body: Record<string, unknown>) => {
        if (signal.aborted) throw new Error('Recovery cancelled');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
            return await Promise.race([
                api!.send(body),
                new Promise<never>((_, reject) => {
                    cancel = () => reject(new Error('Recovery cancelled'));
                    signal.addEventListener('abort', cancel, { once: true });
                    if (signal.aborted) cancel();
                    timer = setTimeout(() => reject(new Error('Recovery market request timed out')), 15000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
        }
    };
    const pause = () =>
        new Promise<void>(resolve => {
            const done = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, 1000);
            signal.addEventListener('abort', done, { once: true });
            if (signal.aborted) done();
        });
    const run = async () => {
        while (!signal.aborted) {
            initialized = false;
            candidates.clear();
            let unwatch = () => {};
            try {
                status('Loading simultaneous recovery feeds…');
                api = await createApi();
                if (signal.aborted) return;
                const connection = api.connection;
                const unavailable = () => {
                    initialized = false;
                    candidates.clear();
                };
                connection?.addEventListener('close', unavailable);
                connection?.addEventListener('error', unavailable);
                unwatch = () => {
                    connection?.removeEventListener('close', unavailable);
                    connection?.removeEventListener('error', unavailable);
                };
                const supported = new Map<string, Set<string>>();
                await observeVolatilityMarkets(
                    api,
                    sampleSize,
                    signal,
                    sample => {
                        if (signal.aborted) return;
                        if (sample.live) failures = 0;
                        const counts = Array<number>(10).fill(0);
                        sample.digits.forEach(d => counts[d]++);
                        const direction = parityRecoveryDirection(counts),
                            symbol = sample.market.symbol;
                        if (!direction || !supported.get(symbol)?.has(direction)) {
                            candidates.delete(symbol);
                            return;
                        }
                        const parity = direction === 'DIGITEVEN' ? 0 : 1;
                        candidates.set(symbol, {
                            plan: { symbol, direction, epoch: sample.epoch },
                            share: counts.reduce(
                                (total, count, digit) => total + (digit % 2 === parity ? count : 0),
                                0
                            ),
                        });
                        select();
                    },
                    text => status(`Searching recovery markets · ${text}`),
                    {
                        prepare: async market => {
                            const response = await request({ contracts_for: market.symbol });
                            const types = new Set(
                                (response.contracts_for?.available || [])
                                    .filter(
                                        c =>
                                            ['DIGITEVEN', 'DIGITODD'].includes(c.contract_type) &&
                                            c.expiry_type === 'tick' &&
                                            /^\d+t$/.test(c.min_contract_duration) &&
                                            parseInt(c.min_contract_duration, 10) <= 1 &&
                                            /^\d+t$/.test(c.max_contract_duration) &&
                                            parseInt(c.max_contract_duration, 10) >= 1
                                    )
                                    .map(c => c.contract_type)
                            );
                            supported.set(market.symbol, types);
                            return types.size > 0;
                        },
                        stale: symbol => candidates.delete(symbol),
                        ready: () => {
                            initialized = true;
                            select();
                        },
                    }
                );
            } catch (error) {
                if (signal.aborted) return;
                const reason = recoveryDataReason(error);
                initialized = false;
                candidates.clear();
                failures++;
                if (failures >= 3) {
                    fatal = new Error(
                        `Recovery data unavailable after three attempts (${reason}). No recovery order was submitted.`
                    );
                    settle(undefined, fatal);
                    return;
                }
                status(`Recovery data reconnecting · Attempt ${failures}/3 · ${reason} · No purchase submitted.`);
                await pause();
            } finally {
                unwatch();
                api?.disconnect();
                api = undefined;
            }
        }
    };
    void run();
    return {
        next(attempt: AbortSignal, report: (text: string) => void): Promise<ParityRecovery | undefined> {
            if (attempt.aborted || signal.aborted) return Promise.resolve(undefined);
            if (fatal) {
                // An idle feed failure must not poison a later authorized recovery.
                // Start a new bounded connection attempt; never reuse failed samples.
                fatal = undefined;
                failures = 0;
                void run();
            }
            if (waiter) return Promise.reject(new Error('A recovery selection is already pending.'));
            return new Promise((resolve, reject) => {
                const abort = () => settle();
                waiter = {
                    resolve,
                    reject,
                    status: report,
                    cleanup: () => attempt.removeEventListener('abort', abort),
                };
                attempt.addEventListener('abort', abort, { once: true });
                report(message);
                select();
            });
        },
        stop() {
            lifetime.abort();
            settle();
            api?.disconnect();
            api = undefined;
        },
    };
}

export async function scanXmlParityRecovery(
    createApi: () => Promise<Api>,
    sampleSize: number,
    signal: AbortSignal,
    status: (message: string) => void,
    scope?: XmlRecoveryScope
): Promise<ParityRecovery | undefined> {
    if (signal.aborted || (scope && !scope.valid())) return;
    if (!scope) {
        const scanner = createRecoveryScanner(createApi, sampleSize);
        try {
            return await scanner.next(signal, status);
        } finally {
            scanner.stop();
        }
    }
    if (retained && (retained.key !== scope.key || retained.sampleSize !== sampleSize)) {
        retained.scanner.stop();
        retained.unsubscribe();
        retained = undefined;
    }
    if (!retained) {
        const entry = {
            key: scope.key,
            sampleSize,
            scanner: createRecoveryScanner(createApi, sampleSize),
            unsubscribe: () => {},
        };
        retained = entry;
        entry.unsubscribe = scope.subscribe(() => {
            if (scope.valid()) return;
            entry.scanner.stop();
            entry.unsubscribe();
            if (retained === entry) retained = undefined;
        });
        if (!scope.valid()) {
            entry.scanner.stop();
            entry.unsubscribe();
            retained = undefined;
            return;
        }
    }
    return retained.scanner.next(signal, status);
}
