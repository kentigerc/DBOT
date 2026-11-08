import { DigitMarket, type MomentumReading } from '@/services/digit-strategy/strategy';
import { observeVolatilityMarkets, type VolatilityApi } from './live-volatility-markets';

export type ManualSide = 'over' | 'under';
export type ManualMarket = {
    symbol: string;
    name: string;
    submarket: string;
    epoch: number;
    checkedAt: number;
    ready: boolean;
    latest?: number;
    count: number;
    over: MomentumReading;
    under: MomentumReading;
    digits: ReturnType<DigitMarket['frequencies']>;
};
export const SWITCHERS = {
    over: { name: 'Over Switcher', fileName: 'over-1-over-0.xml', direction: 'DIGITOVER' },
    under: { name: 'Under Switcher', fileName: 'under-8-under-9.xml', direction: 'DIGITUNDER' },
} as const;
export function manualEntryReady(market: ManualMarket, side: ManualSide, now = Date.now()) {
    const reading = market[side];
    return (
        market.ready &&
        now - market.checkedAt <= 3500 &&
        now / 1000 - market.epoch <= 6 &&
        market.epoch <= now / 1000 + 2 &&
        reading.percentage >= 70 &&
        reading.change > 0 &&
        reading.armed &&
        reading.run >= 2
    );
}
function delay(signal: AbortSignal) {
    return new Promise<void>(resolve => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, 2000);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
    });
}
// Use Momentum 70's actual rolling calculation rather than a second set of entry rules.
export async function watchManualMarkets(
    createApi: () => Promise<VolatilityApi & { disconnect: () => void }>,
    signal: AbortSignal,
    update: (market: ManualMarket) => void,
    status: (message: string) => void,
    stale: (symbol?: string) => void,
    onlySymbol?: string,
    after?: () => number
) {
    while (!signal.aborted) {
        let api: (VolatilityApi & { disconnect: () => void }) | undefined;
        const markets = new Map<string, DigitMarket>();
        let lastReset = after?.() || 0;
        try {
            status('Connecting to live markets…');
            api = await createApi();
            if (signal.aborted) return;
            await observeVolatilityMarkets(
                api,
                1000,
                signal,
                sample => {
                    const reset = after?.() || 0;
                    if (reset !== lastReset) {
                        markets.forEach(market => market.resetMomentum());
                        lastReset = reset;
                    }
                    let market = markets.get(sample.market.symbol);
                    if (!market || !sample.live) {
                        market = new DigitMarket(
                            sample.market.symbol,
                            0,
                            sample.market.display_name || sample.market.symbol
                        );
                        // Positive synthetic quotes preserve every last digit, including zero.
                        sample.digits.forEach((digit, index) =>
                            market!.add(10 + digit, sample.epoch - (sample.digits.length - 1 - index) * 2)
                        );
                        markets.set(sample.market.symbol, market);
                    } else market.add(10 + sample.digits[sample.digits.length - 1], sample.epoch, Date.now());
                    update({
                        symbol: market.symbol,
                        name: market.name,
                        submarket: sample.market.submarket || 'random_index',
                        epoch: market.epoch,
                        checkedAt: Date.now(),
                        ready: market.ready(Date.now()),
                        latest: market.digits[market.digits.length - 1],
                        count: market.digits.length,
                        over: { ...market.momentum.DIGITOVER },
                        under: { ...market.momentum.DIGITUNDER },
                        digits: market.frequencies(),
                    });
                },
                status,
                {
                    prepare: onlySymbol ? async market => market.symbol === onlySymbol : undefined,
                    stale: symbol => {
                        markets.delete(symbol);
                        stale(symbol);
                    },
                }
            );
        } catch {
            if (signal.aborted) return;
            stale();
            status('Market connection interrupted. Reconnecting…');
        } finally {
            api?.disconnect();
        }
        if (!signal.aborted) await delay(signal);
    }
}
