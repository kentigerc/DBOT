import { DigitMarket, type MomentumReading } from '@/services/digit-strategy/strategy';
import { observeVolatilityMarkets, type VolatilityApi } from './live-volatility-markets';

export type ManualSide = 'over' | 'under';
export const MANUAL_MOMENTUM_TICKS = 20;
export const DEFAULT_MANUAL_LEAD = 2;
export type ManualMarket = {
    symbol: string;
    name: string;
    submarket: string;
    epoch: number;
    checkedAt: number;
    ready: boolean;
    latest?: number;
    count: number;
    ticks: number[];
    over: MomentumReading;
    under: MomentumReading;
    trend: { samples: number; over: number | null; under: number | null };
    digits: ReturnType<DigitMarket['frequencies']>;
};
export const SWITCHERS = {
    over: { name: 'Over Switcher', fileName: 'over-1-over-0.xml', direction: 'DIGITOVER' },
    under: { name: 'Under Switcher', fileName: 'under-8-under-9.xml', direction: 'DIGITUNDER' },
} as const;
export const manualLead = (market: ManualMarket, side: ManualSide) =>
    Math.round((market[side].percentage - market[side === 'over' ? 'under' : 'over'].percentage) * 10) / 10;
export function manualEntryReady(
    market: ManualMarket,
    side: ManualSide,
    now = Date.now(),
    minimumLead = DEFAULT_MANUAL_LEAD
) {
    const reading = market[side];
    return (
        market.ready &&
        market.count === 1000 &&
        now - market.checkedAt <= 3500 &&
        now / 1000 - market.epoch <= 6 &&
        market.epoch <= now / 1000 + 2 &&
        reading.percentage >= 70 &&
        reading.change > 0 &&
        Number.isFinite(minimumLead) &&
        minimumLead >= 0.1 &&
        minimumLead <= 100 &&
        manualLead(market, side) >= minimumLead &&
        market.trend.samples >= MANUAL_MOMENTUM_TICKS &&
        (market.trend[side] ?? 0) > 0 &&
        reading.armed &&
        reading.run >= 2
    );
}
export function rankManualMarkets(markets: ManualMarket[], now = Date.now(), minimumLead = DEFAULT_MANUAL_LEAD) {
    const eligible = markets.flatMap(market =>
        (['over', 'under'] as const)
            .filter(side => manualEntryReady(market, side, now, minimumLead))
            .map(side => ({
                market,
                side,
                percentage: market[side].percentage,
                momentum: market.trend[side]!,
                lead: manualLead(market, side),
            }))
    );
    return eligible
        .map(candidate => {
            const shareRank = 1 + eligible.filter(other => other.percentage > candidate.percentage).length;
            const momentumRank = 1 + eligible.filter(other => other.momentum > candidate.momentum).length;
            return { ...candidate, shareRank, momentumRank, score: shareRank + momentumRank };
        })
        .sort(
            (a, b) =>
                a.score - b.score ||
                b.lead - a.lead ||
                b.percentage - a.percentage ||
                b.momentum - a.momentum ||
                a.market.symbol.localeCompare(b.market.symbol) ||
                a.side.localeCompare(b.side)
        );
}
class ManualMomentum {
    private points: { over: number; under: number }[] = [];
    private epoch = 0;
    observe(market: DigitMarket, live: boolean): ManualMarket['trend'] {
        const point = { over: market.momentum.DIGITOVER.percentage, under: market.momentum.DIGITUNDER.percentage };
        if (!live || !this.epoch || market.epoch - this.epoch > 6 || market.digits.length !== 1000)
            this.points = [point];
        else if (market.epoch > this.epoch) this.points = [...this.points, point].slice(-MANUAL_MOMENTUM_TICKS - 1);
        this.epoch = market.epoch;
        const samples = Math.max(0, this.points.length - 1);
        const change = (side: ManualSide) =>
            samples === MANUAL_MOMENTUM_TICKS ? Math.round((point[side] - this.points[0][side]) * 10) / 10 : null;
        return { samples, over: change('over'), under: change('under') };
    }
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
        const trends = new Map<string, ManualMomentum>();
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
                        trends.set(sample.market.symbol, new ManualMomentum());
                    } else if (!market.add(10 + sample.digits[sample.digits.length - 1], sample.epoch, Date.now()))
                        return;
                    update({
                        symbol: market.symbol,
                        name: market.name,
                        submarket: sample.market.submarket || 'random_index',
                        epoch: market.epoch,
                        checkedAt: Date.now(),
                        ready: market.ready(Date.now()),
                        latest: market.digits[market.digits.length - 1],
                        count: market.digits.length,
                        ticks: [...market.digits],
                        over: { ...market.momentum.DIGITOVER },
                        under: { ...market.momentum.DIGITUNDER },
                        trend: trends.get(sample.market.symbol)!.observe(market, sample.live),
                        digits: market.frequencies(),
                    });
                },
                status,
                {
                    prepare: onlySymbol ? async market => market.symbol === onlySymbol : undefined,
                    stale: symbol => {
                        markets.delete(symbol);
                        trends.delete(symbol);
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
