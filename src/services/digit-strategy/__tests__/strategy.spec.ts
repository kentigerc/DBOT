import {
    chooseSignal,
    DEFAULT_SETTINGS,
    DigitMarket,
    nextRecoveryStake,
    riskReason,
    validateSettings,
    type Settings,
} from '../strategy';
function market(counts = [180, 70, 100, 100, 100, 90, 90, 90, 90, 90]) {
    const m = new DigitMarket('R_100', 2, 'Volatility 100 Index');
    m.digits = counts.flatMap((count, digit) => Array(count).fill(digit));
    m.digits.splice(-3, 3, 5, 6, 7);
    m.prices = m.digits.map(d => `100.0${d}`);
    m.epochs = m.digits.map((_, i) => i + 1);
    m.arrivals = m.digits.map(() => 10000);
    m.liveTicks = 3;
    m.received = 10000;
    return m;
}
describe('uploaded digit strategy rules', () => {
    it('preserves displayed trailing zeroes and rejects precision mismatches', () => {
        const m = new DigitMarket('R_100', 2, 'Index');
        m.add(123.4, 1);
        expect(m.digits).toEqual([0]);
        expect(() => m.add(123.456, 2)).toThrow(/precision/);
        expect(m.add(100, 1)).toBe(false);
    });
    it('requires 1000 ticks, three live ticks, fresh feeds and a new full window after a gap', () => {
        const m = market();
        expect(m.ready(10000)).toBe(true);
        m.liveTicks = 2;
        expect(m.ready(10000)).toBe(false);
        m.liveTicks = 3;
        expect(m.ready(14000)).toBe(false);
        m.add(100.01, 1010, 11000);
        expect(m.digits).toEqual([1]);
        expect(m.ready(11000)).toBe(false);
    });
    it('does not repeat the previous normal type or select a marked digit', () => {
        const m = market();
        const s = chooseSignal(
            [m],
            { streak: 0, previous: 'DIGITOVER', countAfter: 0, pauseUntil: 0 },
            DEFAULT_SETTINGS,
            10000,
            () => 0
        )!;
        expect(s.direction).not.toBe('DIGITOVER');
        expect(m.frequencies()[Number(s.barrier)].most).toBe(false);
        expect(m.frequencies()[Number(s.barrier)].least).toBe(false);
    });
    it('rounds every recovery stake half-up to cents and enforces both risk caps before a buy', () => {
        expect(nextRecoveryStake(35)).toBe(74);
        expect(nextRecoveryStake(74)).toBe(155);
        expect(nextRecoveryStake(35, 3)).toBe(105);
        expect(nextRecoveryStake(35, 1.5)).toBe(53);
        expect(DEFAULT_SETTINGS.maxLosses).toBe(10);
        expect(riskReason(DEFAULT_SETTINGS, -200, 9, 100)).toBeUndefined();
        expect(riskReason(DEFAULT_SETTINGS, -200, 10, 100)).toMatch(/Consecutive/);
        expect(riskReason(DEFAULT_SETTINGS, 0, 1, 10001)).toMatch(/Maximum stake/);
        expect(riskReason(DEFAULT_SETTINGS, -9990, 1, 35)).toMatch(/Stop-loss/);
        expect(riskReason(DEFAULT_SETTINGS, 500, 0, 35)).toMatch(/Take-profit/);
    });
    it('rejects invalid limits and unsupported settings', () => {
        expect(() => validateSettings(DEFAULT_SETTINGS)).not.toThrow();
        for (const s of [
            { stake: 0 },
            { stopLoss: 0.1 },
            { maxLosses: 0 },
            { stake: NaN },
            { stake: 0.351 },
            { triggerCount: 0 },
            { duration: 3 },
            { multiplier: 0.9 },
            { multiplier: NaN },
            { multiplier: 2.111 },
        ])
            expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...s } as Settings)).toThrow();
    });
});

describe('standalone Even/Odd strategy', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, strategy: 'even-odd' };
    const state = { streak: 0, countAfter: 0, pauseUntil: 0 };
    it('keeps normal parity entries and does not reuse them as recovery signals', () => {
        const even = market([120, 80, 120, 80, 120, 80, 120, 80, 120, 80]);
        const odd = market([70, 130, 70, 130, 70, 130, 70, 130, 70, 130]);
        odd.symbol = 'R_50';
        even.digits.splice(-3, 3, 2, 4, 1);
        odd.digits.splice(-3, 3, 1, 3, 2);
        const normal = chooseSignal([even, odd], state, settings, 10000);
        expect(normal).toMatchObject({ symbol: 'R_50', direction: 'DIGITODD', recovery: false });
        expect(normal?.barrier).toBeUndefined();
        expect(chooseSignal([even], { ...state, streak: 1 }, settings, 10000)).toBeUndefined();
    });
    it('waits on balanced or stale data and rejects incompatible settings', () => {
        const balanced = market(Array(10).fill(100));
        expect(chooseSignal([balanced], state, settings, 10000)).toBeUndefined();
        const even = market([120, 80, 120, 80, 120, 80, 120, 80, 120, 80]);
        expect(chooseSignal([even], state, settings, 14000)).toBeUndefined();
        expect(() => validateSettings({ ...settings, duration: 5 })).not.toThrow();
        expect(() => validateSettings({ ...settings, duration: 6 })).toThrow();
        expect(() => validateSettings({ ...settings, duration: 1.5 })).toThrow();
        expect(() => validateSettings(settings)).not.toThrow();
    });
});

describe.each([undefined, 'even-odd', 'over2-under7'] as const)(
    'shared parity recovery for non-Momentum tools: %s',
    strategy => {
        const settings: Settings = { ...DEFAULT_SETTINGS, strategy };
        const state = { streak: 1, deficit: 35, countAfter: 9999, pauseUntil: 0, momentumPending: true };
        const ready = (symbol: string, direction: 'DIGITEVEN' | 'DIGITODD', percentage: number) => {
            const m = market();
            m.symbol = symbol;
            m.digits.splice(-3, 3, ...(direction === 'DIGITEVEN' ? [2, 4, 8] : [1, 5, 9]));
            m.parityMomentum[direction] = { percentage, change: 0.1, run: 3, armed: true, epoch: 1000 };
            return m;
        };
        it('compares both sides across markets and picks the highest qualifying share', () => {
            const even = ready('R_10', 'DIGITEVEN', 52);
            const odd = ready('1HZ50V', 'DIGITODD', 64);
            expect(chooseSignal([even, odd], state, settings, 10000)).toMatchObject({
                symbol: odd.symbol,
                direction: 'DIGITODD',
                recovery: true,
                formation: true,
            });
            even.parityMomentum.DIGITEVEN.percentage = 65;
            expect(chooseSignal([even, odd], state, settings, 10000)).toMatchObject({
                symbol: even.symbol,
                direction: 'DIGITEVEN',
                recovery: true,
            });
            expect(chooseSignal([even], state, settings, 10000)?.barrier).toBeUndefined();
        });
        it.each(['DIGITEVEN', 'DIGITODD'] as const)(
            'requires 52%%, increasing momentum and three fresh matching digits for %s',
            direction => {
                const m = ready('R_10', direction, 52);
                expect(chooseSignal([m], state, settings, 10000)?.direction).toBe(direction);
                for (const change of [
                    { percentage: 51.9 },
                    { change: 0 },
                    { change: -0.1 },
                    { run: 2 },
                    { armed: false },
                ]) {
                    const original = { ...m.parityMomentum[direction] };
                    m.parityMomentum[direction] = { ...original, ...change };
                    expect(chooseSignal([m], state, settings, 10000)).toBeUndefined();
                    m.parityMomentum[direction] = original;
                }
                expect(chooseSignal([m], { ...state, countAfter: 10000 }, settings, 10000)).toBeUndefined();
                expect(chooseSignal([m], state, settings, 14000)).toBeUndefined();
                m.digits[m.digits.length - 1] = direction === 'DIGITEVEN' ? 1 : 2;
                expect(chooseSignal([m], state, settings, 10000)).toBeUndefined();
            }
        );
        it('keeps the purchased market and parity through drift without a second formation', () => {
            const locked = ready('R_10', 'DIGITEVEN', 52);
            const stronger = ready('1HZ50V', 'DIGITODD', 90);
            locked.resetMomentum();
            locked.parityMomentum.DIGITEVEN.percentage = 20;
            locked.digits.splice(-3, 3, 1, 3, 5);
            const recovery = {
                ...state,
                recoveryLocked: true,
                lockedSymbol: locked.symbol,
                lockedDirection: 'DIGITEVEN' as const,
            };
            expect(chooseSignal([locked, stronger], recovery, settings, 10000)).toMatchObject({
                symbol: locked.symbol,
                direction: 'DIGITEVEN',
                recovery: true,
                formation: false,
            });
            expect(chooseSignal([stronger], recovery, settings, 10000)).toBeUndefined();
            expect(chooseSignal([locked], recovery, settings, 14000)).toBeUndefined();
        });
        it('does not reuse an obsolete Over/Under recovery lock for new entries', () => {
            const m = ready('1HZ50V', 'DIGITODD', 64);
            expect(
                chooseSignal(
                    [m],
                    { ...state, lockedSymbol: 'old-market', lockedDirection: 'DIGITUNDER', recoveryLocked: true },
                    settings,
                    10000
                )
            ).toMatchObject({ symbol: m.symbol, direction: 'DIGITODD' });
        });
    }
);

it('keeps Under 7 in Analysis Tool and requires its live winning-digit formation', () => {
    const m = new DigitMarket('R_100', 2, 'Volatility 100 Index');
    const digits = [...Array<number>(300).fill(9), ...Array<number>(700).fill(0)];
    digits.forEach((digit, i) => m.add(100 + digit / 100, i + 1));
    const state = { streak: 0, countAfter: 0, pauseUntil: 0, previous: 'DIGITOVER' as const };
    for (let i = 1; i <= 4; i++) m.add(100.04, 1000 + i, 5000 + i * 1000);
    expect(chooseSignal([m], state, DEFAULT_SETTINGS, 9000, () => 0)?.direction).toBe('DIGITDIFF');
    m.add(100.04, 1005, 10000);
    expect(chooseSignal([m], state, DEFAULT_SETTINGS, 10000, () => 0)).toMatchObject({
        direction: 'DIGITUNDER',
        barrier: '7',
        recovery: false,
        formation: true,
    });
    expect(m.entries.ready('DIGITUNDER', 7)).toBe(true);
    m.entries.reset();
    expect(chooseSignal([m], state, DEFAULT_SETTINGS, 10000, () => 0)?.direction).toBe('DIGITDIFF');
});
it('rejects unknown settings and prototype-shaped fields before a trading session can use them', () => {
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, injected: true } as never)).toThrow('Unknown');
    const poisoned = JSON.parse('{"__proto__":{"stake":1}}');
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...poisoned })).toThrow('Unknown');
    expect(({} as any).stake).toBeUndefined();
});
it('rejects USD limits too large for exact integer-cent arithmetic', () => {
    for (const value of [Number.MAX_VALUE, 1e20, Number.MAX_SAFE_INTEGER])
        expect(() =>
            validateSettings({ ...DEFAULT_SETTINGS, stake: value, maxStake: value, stopLoss: value })
        ).toThrow();
});
