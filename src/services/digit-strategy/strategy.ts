// Ported from the uploaded fastbot/digits.py, recovery_filters.py and storage.py.
export type Direction = 'DIGITOVER' | 'DIGITUNDER' | 'DIGITDIFF' | 'DIGITEVEN' | 'DIGITODD';
export const RECOVERY_MODES = {
    under5_filtered_once: 'Under 5 · count once, filtered',
    under4_filtered_once: 'Under 4 · count once, filtered',
    under6_filtered_once: 'Under 6 · count once, filtered',
    under5_filtered_pairs: 'Under 5 · filtered pairs',
    under5_plain: 'Under 5 · filtered, no formation',
    under5_run: 'Under 5 · initial high-digit run',
    under5_pairs: 'Under 5 · paired recovery',
    parity_pair: 'Parity · opposite ten-digit run',
    parity: 'Parity · alternate after recovery loss',
    under5: 'Under 5 · unfiltered',
} as const;
export type RecoveryMode = keyof typeof RECOVERY_MODES;
export type Settings = {
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
    maxLosses: 5,
    multiplier: 2.1,
    maxStake: 100,
    stopLoss: 100,
    takeProfit: 5,
    recoveryMode: 'under5_filtered_once',
    triggerCount: 3,
    duration: 2,
};
export function cents(value: unknown) {
    const amount = Number(value);
    if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        String(value).trim() === '' ||
        !Number.isFinite(amount) ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7
    )
        throw new Error('Invalid USD amount.');
    return Math.round(amount * 100);
}
export function validateSettings(s: Settings) {
    for (const key of ['stake', 'maxStake', 'stopLoss', 'takeProfit'] as const) {
        const v = s[key];
        if (
            !Number.isFinite(v) ||
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
    if (![1, 2].includes(s.duration) || !(s.recoveryMode in RECOVERY_MODES))
        throw new Error('Invalid digit strategy settings.');
}
export const nextRecoveryStake = (previousCents: number, multiplier = DEFAULT_SETTINGS.multiplier) =>
    Math.floor((previousCents * Math.round(multiplier * 100) + 50) / 100);
export type Frequency = { digit: number; count: number; percentage: number; most: boolean; least: boolean };
export class DigitMarket {
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
                this.gapUntil = received + 6000;
            }
            this.received = received;
            this.liveTicks++;
        }
        this.prices.push(display);
        this.epochs.push(epoch);
        this.digits.push(Number(display.slice(-1)));
        this.arrivals.push(received);
        for (const list of [this.prices, this.epochs, this.digits, this.arrivals]) if (list.length > 1000) list.shift();
        return true;
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
    previous?: Direction;
    lockedSymbol?: string;
    lockedDirection?: Direction;
    countAfter: number;
    pauseUntil: number;
};
const OPTIONS: [Direction, string?][] = [
    ['DIGITOVER', '0'],
    ['DIGITOVER', '1'],
    ['DIGITOVER', '2'],
    ['DIGITUNDER', '9'],
    ['DIGITUNDER', '8'],
    ['DIGITDIFF'],
];
export const isPaired = (mode: RecoveryMode) =>
    ['under5_pairs', 'under5_plain', 'under5_filtered_pairs'].includes(mode);
export function signalOn(
    m: DigitMarket,
    direction: Direction,
    barrier: string | undefined,
    recovery: boolean,
    formation = false
): Signal {
    return { symbol: m.symbol, direction, barrier, epoch: m.epoch, recovery, formation };
}
export function recoverySignal(m: DigitMarket, s: RecoveryState, config: Settings, now: number): Signal | undefined {
    if (!m.ready(now) || now < s.pauseUntil || (s.lockedSymbol && m.symbol !== s.lockedSymbol)) return;
    const mode = config.recoveryMode;
    if (mode === 'parity' || mode === 'parity_pair') {
        if (s.lockedDirection) return signalOn(m, s.lockedDirection, undefined, true);
        if (mode === 'parity_pair') {
            const tail = m.digits.slice(-10);
            if (!tail.every(d => d % 2 === tail[0] % 2)) return;
            return signalOn(m, tail[0] % 2 === 0 ? 'DIGITODD' : 'DIGITEVEN', undefined, true, true);
        }
        return;
    }
    const barrier = mode === 'under4_filtered_once' ? '4' : mode === 'under6_filtered_once' ? '6' : '5';
    const filtered = mode.includes('filtered') || mode === 'under5_plain';
    if (
        filtered &&
        (!m.standard ||
            m
                .frequencies()
                .slice(Number(barrier))
                .some(d => d.most || d.least))
    )
        return;
    const needsFormation = mode !== 'under5' && mode !== 'under5_plain' && (!s.lockedSymbol || s.countAfter > 0);
    if (needsFormation && !m.highRun(config.triggerCount, s.countAfter)) return;
    return signalOn(m, 'DIGITUNDER', barrier, true, needsFormation);
}
export function chooseSignal(
    markets: DigitMarket[],
    state: RecoveryState,
    config: Settings,
    now: number,
    random = Math.random
): Signal | undefined {
    const pick = <T>(rows: T[]) => rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))];
    if (state.streak) {
        const signals = markets.map(m => recoverySignal(m, state, config, now)).filter((s): s is Signal => !!s);
        if (!signals.length) return;
        if (config.recoveryMode === 'under5' || config.recoveryMode === 'parity') return pick(signals);
        return signals.sort(
            (a, b) =>
                markets.find(m => m.symbol === b.symbol)!.received - markets.find(m => m.symbol === a.symbol)!.received
        )[0];
    }
    const groups: Signal[][] = [];
    for (const [direction, value] of OPTIONS) {
        if (direction === state.previous) continue;
        const signals: Signal[] = [];
        for (const m of markets) {
            if (!m.ready(now)) continue;
            const barrier = value ?? String(m.digits[m.digits.length - 1]);
            const mark = m.frequencies()[Number(barrier)];
            if (!mark.most && !mark.least) signals.push(signalOn(m, direction, barrier, false));
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
