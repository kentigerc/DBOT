import { ParityRecoveryEntries, parityRecoveryReady } from '@/services/digit-strategy/parity-recovery';
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
// Refresh only the locked recovery market; no new market analysis or formation.
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
let retained:
    | { key: number; sampleSize: number; duration: number; scanner: RecoveryScanner; unsubscribe: () => void }
    | undefined;

// Keep all recovery feeds warm; each new loss episode waits for a fresh formation.
// Confirmed recovery purchases retain their chosen market until the first win.
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

function createRecoveryScanner(createApi: () => Promise<Api>, sampleSize: number, duration = 1) {
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    let api: Api | undefined;
    let initialized = false,
        failures = 0;
    let fatal: Error | undefined;
    let message = 'Loading simultaneous recovery feeds…';
    const candidates = new Map<string, { plan: ParityRecovery; share: number }>();
    const trackers = new Map<string, ParityRecoveryEntries>();
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
            trackers.clear();
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
                        const symbol = sample.market.symbol;
                        let tracker = trackers.get(symbol);
                        if (!tracker) {
                            tracker = new ParityRecoveryEntries();
                            trackers.set(symbol, tracker);
                        }
                        tracker.observe(sample.digits, sample.epoch, sample.live);
                        candidates.delete(symbol);
                        for (const direction of ['DIGITEVEN', 'DIGITODD'] as const) {
                            const reading = tracker.readings[direction];
                            if (sample.live && supported.get(symbol)?.has(direction) && parityRecoveryReady(reading))
                                candidates.set(symbol, {
                                    plan: { symbol, direction, epoch: sample.epoch },
                                    share: reading.percentage,
                                });
                        }
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
                                            parseInt(c.min_contract_duration, 10) <= duration &&
                                            /^\d+t$/.test(c.max_contract_duration) &&
                                            parseInt(c.max_contract_duration, 10) >= duration
                                    )
                                    .map(c => c.contract_type)
                            );
                            supported.set(market.symbol, types);
                            return types.size > 0;
                        },
                        stale: symbol => {
                            candidates.delete(symbol);
                            trackers.delete(symbol);
                        },
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
            candidates.clear();
            for (const tracker of trackers.values()) tracker.reset();
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
    scope?: XmlRecoveryScope,
    duration = 1
): Promise<ParityRecovery | undefined> {
    if (signal.aborted || (scope && !scope.valid())) return;
    if (!scope) {
        const scanner = createRecoveryScanner(createApi, sampleSize, duration);
        try {
            return await scanner.next(signal, status);
        } finally {
            scanner.stop();
        }
    }
    if (
        retained &&
        (retained.key !== scope.key || retained.sampleSize !== sampleSize || retained.duration !== duration)
    ) {
        retained.scanner.stop();
        retained.unsubscribe();
        retained = undefined;
    }
    if (!retained) {
        const entry = {
            key: scope.key,
            sampleSize,
            duration,
            scanner: createRecoveryScanner(createApi, sampleSize, duration),
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
