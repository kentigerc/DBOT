import { advanceParityRecovery, parityRecoveryReady } from './parity-recovery';
import { OverUnderEntries } from './over-under-entry';
// Ported from the uploaded fastbot/digits.py, recovery_filters.py and storage.py.
export type Direction = 'DIGITOVER' | 'DIGITUNDER' | 'DIGITDIFF' | 'DIGITEVEN' | 'DIGITODD';
export const DEMO_RECOVERY_LOSS_LIMIT = 2;
export const RECOVERY_MODES = {
    same_contract: 'Same contract',
    parity_percentage: 'Neto Recovery',
    under5_filtered_once: 'Recovery profile 01',
    under4_filtered_once: 'Recovery profile 02',
    under6_filtered_once: 'Recovery profile 03',
    under5_filtered_pairs: 'Recovery profile 04',
    under5_plain: 'Recovery profile 05',
    under5_run: 'Recovery profile 06',
    under5_pairs: 'Recovery profile 07',
    parity_pair: 'Recovery profile 08',
    parity: 'Recovery profile 09',
    under5: 'Recovery profile 10',
} as const;
export type RecoveryMode = keyof typeof RECOVERY_MODES;
export type Settings = {
    strategy?: 'over2-under7' | 'even-odd' | 'momentum-70';
    hitRecovery?: 'same_contract' | 'analysis';
    stake: number;
    maxLosses: number;
    multiplier: number;
    maxStake: number;
    stopLoss: number;
    takeProfit: number;
    recoveryMode: RecoveryMode;
    triggerCount: number;
    duration: number;
};
export const DEFAULT_SETTINGS: Settings = {
    stake: 0.35,
    maxLosses: 10,
    multiplier: 2.1,
    maxStake: 100,
    stopLoss: 100,
    takeProfit: 5,
    recoveryMode: 'parity_percentage',
    triggerCount: 3,
    duration: 1,
};
export function cents(value: unknown) {
    const amount = Number(value);
    if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        String(value).trim() === '' ||
        !Number.isFinite(amount) ||
        !Number.isSafeInteger(Math.round(amount * 100)) ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7
    )
        throw new Error('Invalid USD amount.');
    return Math.round(amount * 100);
}
export function validateSettings(s: Settings) {
    const fields = [
        'strategy',
        'hitRecovery',
        'stake',
        'maxLosses',
        'multiplier',
        'maxStake',
        'stopLoss',
        'takeProfit',
        'recoveryMode',
        'triggerCount',
        'duration',
    ];
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(key => !fields.includes(key)))
        throw new Error('Unknown or invalid strategy settings.');
    if (s.hitRecovery !== undefined && !['same_contract', 'analysis'].includes(s.hitRecovery))
        throw new Error('Invalid recovery method.');
    if (s.strategy !== undefined && !['over2-under7', 'even-odd', 'momentum-70'].includes(s.strategy))
        throw new Error('Invalid trading strategy.');
    if (s.recoveryMode === 'same_contract' && s.strategy !== 'momentum-70')
        throw new Error('Invalid same-contract strategy settings.');
    if (s.strategy === 'even-odd' && s.recoveryMode !== 'parity_percentage')
        throw new Error('Invalid Even/Odd recovery settings.');
    for (const key of ['stake', 'maxStake', 'stopLoss', 'takeProfit'] as const) {
        const v = s[key];
        if (
            !Number.isFinite(v) ||
            !Number.isSafeInteger(Math.round(v * 100)) ||
            v < (key === 'takeProfit' ? 0 : 0.01) ||
            Math.abs(v * 100 - Math.round(v * 100)) > 1e-7
        )
            throw new Error(
                'Use positive USD amounts with at most two decimal places (take-profit may be 0 to disable).'
            );
    }
    if (
        !Number.isFinite(s.multiplier) ||
        s.multiplier < 1 ||
        !Number.isSafeInteger(Math.round(s.multiplier * 100)) ||
        Math.abs(s.multiplier * 100 - Math.round(s.multiplier * 100)) > 1e-7
    )
        throw new Error('Use a martingale multiplier of at least 1 with at most two decimal places.');
    if (s.stake < 0.35) throw new Error('The minimum starting stake is $0.35.');
    if (s.maxStake < s.stake || s.stopLoss < s.stake)
        throw new Error('Maximum stake and stop-loss must cover the starting stake.');
    if (!Number.isInteger(s.maxLosses) || s.maxLosses < 1 || s.maxLosses > 100)
        throw new Error('Consecutive-loss limit must be an integer from 1 to 100.');
    if (!Number.isInteger(s.triggerCount) || s.triggerCount < 1 || s.triggerCount > 1000)
        throw new Error('Formation count must be an integer from 1 to 1000.');
    if (
        !(['even-odd', 'momentum-70'].includes(s.strategy || '')
            ? Number.isInteger(s.duration) && s.duration >= 1 && s.duration <= 5
            : [1, 2].includes(s.duration)) ||
        !(s.recoveryMode in RECOVERY_MODES)
    )
        throw new Error('Invalid digit strategy settings.');
}
export const nextRecoveryStake = (previousCents: number, multiplier = DEFAULT_SETTINGS.multiplier) =>
    Math.floor((previousCents * Math.round(multiplier * 100) + 50) / 100);
export type Frequency = { digit: number; count: number; percentage: number; most: boolean; least: boolean };
export type MomentumReading = { percentage: number; change: number; run: number; armed: boolean; epoch: number };
export class DigitMarket {
    entries = new OverUnderEntries();
    private parityCounts = { DIGITEVEN: 0, DIGITODD: 0 };
    parityMomentum: Record<'DIGITEVEN' | 'DIGITODD', MomentumReading> = {
        DIGITEVEN: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
        DIGITODD: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
    };
    private groupCounts = { DIGITOVER: 0, DIGITUNDER: 0, OVER3: 0, UNDER6: 0 };
    momentum: Record<'DIGITOVER' | 'DIGITUNDER', MomentumReading> = {
        DIGITOVER: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
        DIGITUNDER: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
    };
    recoveryMomentum: Record<'DIGITOVER' | 'DIGITUNDER', MomentumReading> = {
        DIGITOVER: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
        DIGITUNDER: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
    };
    prices: string[] = [];
    epochs: number[] = [];
    digits: number[] = [];
    arrivals: number[] = [];
    received = 0;
    liveTicks = 0;
    gapUntil = 0;
    constructor(
        public symbol: string,
        public precision: number,
        public name: string
    ) {
        if (!Number.isInteger(precision) || precision < 0 || precision > 12)
            throw new Error('Unverified market precision.');
    }
    add(price: number | string, epoch: number, received = 0) {
        if (!Number.isFinite(Number(price)) || Number(price) <= 0 || !Number.isInteger(epoch) || epoch <= 0)
            throw new Error('Invalid market tick.');
        if (this.epochs.length && epoch <= this.epochs[this.epochs.length - 1]) return false;
        const display = Number(price).toFixed(this.precision);
        if (Math.abs(Number(display) - Number(price)) > Math.max(1, Number(price)) * Number.EPSILON * 2)
            throw new Error('Tick exceeds verified precision.');
        if (received) {
            if (this.epochs.length && epoch - this.epochs[this.epochs.length - 1] > 6) {
                this.prices = [];
                this.epochs = [];
                this.digits = [];
                this.arrivals = [];
                this.liveTicks = 0;
                this.groupCounts = { DIGITOVER: 0, DIGITUNDER: 0, OVER3: 0, UNDER6: 0 };
                this.parityCounts = { DIGITEVEN: 0, DIGITODD: 0 };
                this.entries = new OverUnderEntries();
                this.resetMomentum();
                this.gapUntil = received + 6000;
            }
            this.received = received;
            this.liveTicks++;
        }
        const full = this.digits.length === 1000;
        const outgoing = full ? this.digits[0] : undefined;
        const digit = Number(display.slice(-1));
        this.prices.push(display);
        this.epochs.push(epoch);
        this.digits.push(Number(display.slice(-1)));
        this.arrivals.push(received);
        for (const list of [this.prices, this.epochs, this.digits, this.arrivals]) if (list.length > 1000) list.shift();
        for (const key of ['DIGITOVER', 'DIGITUNDER', 'OVER3', 'UNDER6'] as const) {
            const recovery = key === 'OVER3' || key === 'UNDER6';
            const direction = key === 'DIGITOVER' || key === 'OVER3' ? 'DIGITOVER' : 'DIGITUNDER';
            const target = recovery ? this.recoveryMomentum : this.momentum;
            const accepts = (digit: number) =>
                key === 'OVER3'
                    ? digit > 3
                    : key === 'UNDER6'
                      ? digit < 6
                      : key === 'DIGITOVER'
                        ? digit > 1
                        : digit < 8;
            const previous = this.groupCounts[key];
            const count = previous + (accepts(digit) ? 1 : 0) - (outgoing !== undefined && accepts(outgoing) ? 1 : 0);
            this.groupCounts[key] = count;
            const oldCount = full ? previous : undefined;
            const reading = target[direction];
            const change = oldCount === undefined ? 0 : (count - oldCount) / 10;
            let armed = reading.armed,
                run = reading.run;
            if (!received || !this.ready(received) || count < (recovery ? 520 : 700) || change < 0) {
                armed = false;
                run = 0;
            } else if (!armed && change > 0) {
                armed = true;
                run = 0;
            } else if (armed) run = accepts(this.digits[this.digits.length - 1]) ? Math.min(2, run + 1) : 0;
            target[direction] = { percentage: count / 10, change, armed, run, epoch };
        }
        for (const direction of ['DIGITEVEN', 'DIGITODD'] as const) {
            const parity = direction === 'DIGITEVEN' ? 0 : 1;
            const previous = this.parityCounts[direction];
            const count =
                previous + (digit % 2 === parity ? 1 : 0) - (outgoing !== undefined && outgoing % 2 === parity ? 1 : 0);
            this.parityCounts[direction] = count;
            const change = full ? (count - previous) / 10 : 0;
            this.parityMomentum[direction] = advanceParityRecovery(
                this.parityMomentum[direction],
                direction,
                digit,
                count / 10,
                change,
                epoch,
                !!received && this.ready(received)
            );
        }
        if (this.digits.length === 1000) this.entries.observe(this.digits, epoch, !!received && this.ready(received));
        return true;
    }
    resetMomentum() {
        for (const direction of ['DIGITEVEN', 'DIGITODD'] as const)
            this.parityMomentum[direction] = { ...this.parityMomentum[direction], armed: false, run: 0 };
        for (const direction of ['DIGITOVER', 'DIGITUNDER'] as const) {
            this.momentum[direction] = { ...this.momentum[direction], armed: false, run: 0 };
            this.recoveryMomentum[direction] = { ...this.recoveryMomentum[direction], armed: false, run: 0 };
        }
    }
    frequencies(): Frequency[] {
        const counts = Array<number>(10).fill(0);
        this.digits.forEach(d => counts[d]++);
        const low = Math.min(...counts),
            high = Math.max(...counts);
        return counts.map((count, digit) => ({
            digit,
            count,
            percentage: this.digits.length ? (count / this.digits.length) * 100 : 0,
            most: !!this.digits.length && count === high,
            least: !!this.digits.length && count === low,
        }));
    }
    ready(now: number) {
        return (
            this.digits.length === 1000 && this.liveTicks >= 3 && now >= this.gapUntil && now - this.received <= 3500
        );
    }
    highRun(count: number, after = 0) {
        return (
            this.digits.length >= count &&
            this.digits.slice(-count).every(d => d >= 5) &&
            (!after || this.arrivals.slice(-count).every(at => at > after))
        );
    }
    get standard() {
        return /^R_[1-9][0-9]*$/.test(this.symbol) && !/\b1\s*s\b/i.test(this.name);
    }
    get epoch() {
        return this.epochs[this.epochs.length - 1];
    }
}
export type Signal = {
    symbol: string;
    direction: Direction;
    barrier?: string;
    epoch: number;
    recovery: boolean;
    formation: boolean;
};
export type RecoveryState = {
    streak: number;
    deficit?: number;
    batchMarket?: string;
    batchDirection?: Direction;
    previous?: Direction;
    recoveryLocked?: boolean;
    momentumPending?: boolean;
    lockedSymbol?: string;
    lockedDirection?: Direction;
    countAfter: number;
    pauseUntil: number;
};
const OPTIONS: [Direction, string?][] = [
    ['DIGITOVER', '0'],
    ['DIGITOVER', '1'],
    ['DIGITOVER', '2'],
    ['DIGITUNDER', '7'],
    ['DIGITUNDER', '9'],
    ['DIGITUNDER', '8'],
    ['DIGITDIFF'],
];
export function signalOn(
    m: DigitMarket,
    direction: Direction,
    barrier: string | undefined,
    recovery: boolean,
    formation = false
): Signal {
    return { symbol: m.symbol, direction, barrier, epoch: m.epoch, recovery, formation };
}
export function parityRecoveryDirection(counts: number[]): 'DIGITEVEN' | 'DIGITODD' | undefined {
    if (counts.length !== 10 || counts.some(n => !Number.isInteger(n) || n < 0)) return;
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (!total) return;
    const even = counts.reduce((sum, count, digit) => sum + (digit % 2 === 0 ? count : 0), 0);
    const odd = total - even;
    if (even * 100 > 52 * total && odd * 100 < 47 * total) return 'DIGITEVEN';
    if (odd * 100 > 52 * total && even * 100 < 47 * total) return 'DIGITODD';
}

// Entry directions are derived from live formation readings, not static frequency marks.
export function cycleDirections(entries: OverUnderEntries): Direction[] {
    return (['DIGITOVER', 'DIGITUNDER'] as const).filter(direction =>
        entries.ready(direction, direction === 'DIGITOVER' ? 2 : 7)
    );
}
export function cycleSignal(m: DigitMarket, state: RecoveryState, now: number): Signal | undefined {
    if (state.momentumPending ?? (state.streak > 0 || (state.deficit || 0) > 0))
        return chooseParityRecovery([m], state, now);
    if (!m.ready(now) || now < state.pauseUntil || m.received <= state.countAfter) return;
    if (state.lockedSymbol && m.symbol !== state.lockedSymbol) return;
    const direction = cycleDirections(m.entries).find(d => !state.lockedDirection || state.lockedDirection === d);
    return direction ? signalOn(m, direction, direction === 'DIGITOVER' ? '2' : '7', false, true) : undefined;
}
export function momentumSignal(m: DigitMarket, state: RecoveryState, now: number): Signal | undefined {
    const recovering = state.momentumPending ?? (state.streak > 0 || (state.deficit || 0) > 0);
    if (!m.ready(now) || now < state.pauseUntil) return;
    if (recovering && state.recoveryLocked) {
        if (m.symbol !== state.lockedSymbol || !['DIGITOVER', 'DIGITUNDER'].includes(state.lockedDirection || ''))
            return;
        return signalOn(m, state.lockedDirection!, state.lockedDirection === 'DIGITOVER' ? '3' : '6', true);
    }
    const readings = recovering ? m.recoveryMomentum : m.momentum;
    const direction = (['DIGITOVER', 'DIGITUNDER'] as const)
        .filter(d => !recovering || !state.lockedDirection || state.lockedDirection === d)
        .filter(d => {
            const r = readings[d];
            return (
                r.armed &&
                r.run >= 2 &&
                r.percentage >= (recovering ? 52 : 70) &&
                r.change > 0 &&
                m.arrivals.slice(-2).every(at => at > state.countAfter)
            );
        })
        .sort((a, b) => readings[b].percentage - readings[a].percentage)[0];
    return direction
        ? signalOn(
              m,
              direction,
              recovering ? (direction === 'DIGITOVER' ? '3' : '6') : direction === 'DIGITOVER' ? '1' : '8',
              recovering,
              true
          )
        : undefined;
}
export function sharedRecoverySettings(settings: Settings): Settings {
    return {
        ...settings,
        recoveryMode: settings.strategy === 'momentum-70' ? 'same_contract' : 'parity_percentage',
        hitRecovery:
            settings.strategy === 'momentum-70'
                ? 'same_contract'
                : settings.strategy === 'over2-under7'
                  ? 'analysis'
                  : undefined,
        triggerCount: 3,
    };
}
export function chooseParityRecovery(markets: DigitMarket[], state: RecoveryState, now: number): Signal | undefined {
    if (state.recoveryLocked && ['DIGITEVEN', 'DIGITODD'].includes(state.lockedDirection || '')) {
        const market = markets.find(m => m.symbol === state.lockedSymbol);
        return market?.ready(now) && now >= state.pauseUntil
            ? signalOn(market, state.lockedDirection!, undefined, true)
            : undefined;
    }
    const candidates = markets.flatMap(m => {
        if (!m.ready(now) || now < state.pauseUntil) return [];
        return (['DIGITEVEN', 'DIGITODD'] as const).flatMap(direction => {
            const parity = direction === 'DIGITEVEN' ? 0 : 1;
            if (
                !parityRecoveryReady(m.parityMomentum[direction]) ||
                !m.digits.slice(-3).every(d => d % 2 === parity) ||
                !m.arrivals.slice(-3).every(at => at > state.countAfter)
            )
                return [];
            return [signalOn(m, direction, undefined, true, true)];
        });
    });
    return candidates.sort(
        (a, b) =>
            markets.find(m => m.symbol === b.symbol)!.parityMomentum[b.direction as 'DIGITEVEN' | 'DIGITODD']
                .percentage -
            markets.find(m => m.symbol === a.symbol)!.parityMomentum[a.direction as 'DIGITEVEN' | 'DIGITODD'].percentage
    )[0];
}
export function chooseSignal(
    markets: DigitMarket[],
    state: RecoveryState,
    config: Settings,
    now: number,
    random = Math.random
): Signal | undefined {
    if (config.strategy !== 'momentum-70' && (state.momentumPending ?? (state.streak > 0 || (state.deficit || 0) > 0)))
        return chooseParityRecovery(markets, state, now);
    if (config.strategy === 'momentum-70') {
        return markets
            .map(m => momentumSignal(m, state, now))
            .filter((s): s is Signal => !!s)
            .sort(
                (a, b) =>
                    (b.recovery
                        ? markets.find(m => m.symbol === b.symbol)!.recoveryMomentum
                        : markets.find(m => m.symbol === b.symbol)!.momentum)[b.direction as 'DIGITOVER' | 'DIGITUNDER']
                        .percentage -
                    (a.recovery
                        ? markets.find(m => m.symbol === a.symbol)!.recoveryMomentum
                        : markets.find(m => m.symbol === a.symbol)!.momentum)[a.direction as 'DIGITOVER' | 'DIGITUNDER']
                        .percentage
            )[0];
    }
    if (config.strategy === 'even-odd') {
        const candidates = markets.flatMap(m => {
            if (!m.ready(now)) return [];
            const direction = parityRecoveryDirection(m.frequencies().map(d => d.count));
            if (!direction) return [];
            const parity = direction === 'DIGITEVEN' ? 0 : 1;
            const tail = m.digits.slice(-3);
            if (
                tail[0] % 2 !== parity ||
                tail[1] % 2 !== parity ||
                tail[2] % 2 === parity ||
                !m.arrivals.slice(-3).every(at => at > (state.countAfter || 0))
            )
                return [];
            return [signalOn(m, direction, undefined, false, true)];
        });
        const share = (s: Signal) =>
            markets
                .find(m => m.symbol === s.symbol)!
                .frequencies()
                .filter(d => d.digit % 2 === (s.direction === 'DIGITEVEN' ? 0 : 1))
                .reduce((n, d) => n + d.count, 0);
        return candidates.sort((a, b) => share(b) - share(a))[0];
    }
    if (config.strategy === 'over2-under7') {
        if (state.lockedSymbol) {
            const selected = markets.find(m => m.symbol === state.lockedSymbol);
            return selected ? cycleSignal(selected, state, now) : undefined;
        }
        const eligible = markets.map(m => cycleSignal(m, state, now)).filter((signal): signal is Signal => !!signal);
        // Every candidate has passed both the full entry rules and freshness checks.
        // Randomize ties rather than privileging the feed whose tick arrived last.
        return eligible.length
            ? eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))]
            : undefined;
    }
    const pick = <T>(rows: T[]) => rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))];
    const groups: Signal[][] = [];
    for (const [direction, value] of OPTIONS) {
        if (direction === state.previous) continue;
        const signals: Signal[] = [];
        for (const m of markets) {
            if (!m.ready(now)) continue;
            const barrier = value ?? String(m.digits[m.digits.length - 1]);
            if (direction === 'DIGITOVER' || direction === 'DIGITUNDER') {
                if (m.entries.ready(direction, Number(barrier)))
                    signals.push(signalOn(m, direction, barrier, false, true));
            } else {
                const mark = m.frequencies()[Number(barrier)];
                if (!mark.most && !mark.least) signals.push(signalOn(m, direction, barrier, false));
            }
        }
        if (signals.length) groups.push(signals);
    }
    return groups.length ? pick(pick(groups)) : undefined;
}
export function riskReason(
    settings: Settings,
    pnlCents: number,
    streak: number,
    stakeCents: number
): string | undefined {
    if (streak >= settings.maxLosses) return 'Consecutive-loss limit reached';
    if (stakeCents > cents(settings.maxStake)) return 'Maximum stake reached';
    if (pnlCents - stakeCents < -cents(settings.stopLoss)) return 'Stop-loss: no room for the next stake';
    if (settings.takeProfit > 0 && pnlCents >= cents(settings.takeProfit)) return 'Take-profit reached';
}
