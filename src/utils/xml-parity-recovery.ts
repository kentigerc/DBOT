import { parityRecoveryDirection } from '@/services/digit-strategy/strategy';
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
            finish();
            return;
        }
        pattern = [...pattern, digit % 2].slice(-3);
        const chosen = direction === 'DIGITEVEN' ? 0 : 1;
        if (pattern.length === 3 && pattern[0] === chosen && pattern[1] === chosen && pattern[2] !== chosen)
            finish({ symbol, direction, epoch: lastEpoch });
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
    const watchdog = setInterval(() => {
        if (ready && Date.now() - lastArrival > 6000) fail();
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

// Later attempts keep the first formation's market and direction. This is only
// a fresh quote check, not another percentage scan or formation analysis.
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

export async function scanXmlParityRecovery(
    createApi: () => Promise<Api>,
    sampleSize: number,
    signal: AbortSignal,
    status: (message: string) => void
): Promise<ParityRecovery | undefined> {
    let api: Api | undefined;
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
    try {
        while (!signal.aborted) {
            try {
                api = await createApi();
                if (signal.aborted) return;
                const response = await request({ active_symbols: 'brief' });
                const markets = (response.active_symbols || []).filter(
                    m => /^(R_\d+|1HZ\d+V)$/.test(m.symbol) && m.exchange_is_open && !m.is_trading_suspended
                );
                if (!markets.length) throw new Error('No recovery markets available');
                while (!signal.aborted) {
                    for (const market of markets) {
                        if (signal.aborted) return;
                        status(`Searching recovery markets · ${market.display_name || market.symbol}`);
                        let found = false;
                        try {
                            const data = await request({
                                ticks_history: market.symbol,
                                style: 'ticks',
                                end: 'latest',
                                count: sampleSize,
                            });
                            const prices = data.history?.prices;
                            const epoch = Number(data.history?.times?.slice(-1)[0]);
                            if (
                                !Array.isArray(prices) ||
                                prices.length < sampleSize ||
                                !Number.isInteger(data.pip_size) ||
                                !fresh(epoch)
                            )
                                continue;
                            const digits = prices.slice(-sampleSize).map(price => lastDigit(price, data.pip_size!));
                            if (digits.some(d => d === null)) continue;
                            const counts = Array<number>(10).fill(0);
                            digits.forEach(d => counts[d!]++);
                            const direction = parityRecoveryDirection(counts);
                            if (!direction) continue;
                            const available = await request({ contracts_for: market.symbol });
                            const supported = (available.contracts_for?.available || []).some(
                                c =>
                                    c.contract_type === direction &&
                                    c.expiry_type === 'tick' &&
                                    /^\d+t$/.test(c.min_contract_duration) &&
                                    parseInt(c.min_contract_duration, 10) <= 1 &&
                                    /^\d+t$/.test(c.max_contract_duration) &&
                                    parseInt(c.max_contract_duration, 10) >= 1
                            );
                            if (supported && !signal.aborted && fresh(epoch)) {
                                const plan = await waitForXmlParityFormation(
                                    api,
                                    request,
                                    market.symbol,
                                    direction,
                                    sampleSize,
                                    signal,
                                    status
                                );
                                if (plan) {
                                    found = true;
                                    return plan;
                                }
                            }
                        } catch (error) {
                            if (signal.aborted) return;
                            throw error;
                        } finally {
                            if (!found && !signal.aborted) await pause();
                        }
                    }
                }
            } catch {
                if (signal.aborted) return;
                status('Recovery data reconnecting · No purchase submitted.');
                await pause();
            } finally {
                api?.disconnect();
                api = undefined;
            }
        }
    } finally {
        api?.disconnect();
    }
}
