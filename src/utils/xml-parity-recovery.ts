import { parityRecoveryDirection } from '@/services/digit-strategy/strategy';
import { lastDigit } from '@/pages/digit-analysis/digits';
type RecoveryResponse = {
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
type Api = { send: (body: Record<string, unknown>) => Promise<RecoveryResponse>; disconnect: () => void };
export type ParityRecovery = { symbol: string; direction: 'DIGITEVEN' | 'DIGITODD'; epoch: number };
const fresh = (epoch: number) =>
    Number.isFinite(epoch) && Date.now() / 1000 - epoch <= 6 && epoch <= Date.now() / 1000 + 2;
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
                                found = true;
                                return { symbol: market.symbol, direction, epoch };
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
