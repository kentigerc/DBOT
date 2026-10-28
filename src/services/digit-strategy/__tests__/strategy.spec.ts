import {
    chooseSignal,
    DEFAULT_SETTINGS,
    DigitMarket,
    nextRecoveryStake,
    recoverySignal,
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
    it.each(['R_100', '1HZ100V'])('uses last digit 5/7/9 on every filtered Under 5 entry on %s', symbol => {
        for (let digit = 0; digit <= 9; digit++) {
            const m = market();
            m.symbol = symbol;
            m.digits.splice(-3, 3, 1, 2, digit);
            for (const locked of [false, true]) {
                const signal = recoverySignal(
                    m,
                    {
                        streak: locked ? 2 : 1,
                        countAfter: 0,
                        pauseUntil: 0,
                        ...(locked ? { lockedSymbol: symbol } : {}),
                    },
                    { ...DEFAULT_SETTINGS, recoveryMode: 'under5_filtered_once' },
                    10000
                );
                if ([5, 7, 9].includes(digit))
                    expect(signal).toMatchObject({
                        direction: 'DIGITUNDER',
                        barrier: '5',
                        epoch: m.epoch,
                        formation: true,
                    });
                else expect(signal).toBeUndefined();
            }
        }
    });
    it('retains frequency filters, freshness, market locking and pauses for last-digit recovery', () => {
        const m = market();
        const s = { streak: 1, countAfter: 0, pauseUntil: 0 };
        expect(
            recoverySignal(
                m,
                { ...s, lockedSymbol: 'R_50' },
                { ...DEFAULT_SETTINGS, recoveryMode: 'under5_filtered_once' },
                10000
            )
        ).toBeUndefined();
        expect(
            recoverySignal(
                m,
                { ...s, pauseUntil: 11000 },
                { ...DEFAULT_SETTINGS, recoveryMode: 'under5_filtered_once' },
                10000
            )
        ).toBeUndefined();
        expect(
            recoverySignal(m, s, { ...DEFAULT_SETTINGS, recoveryMode: 'under5_filtered_once' }, 14000)
        ).toBeUndefined();
        m.symbol = '1HZ100V';
        m.digits = Array(1000).fill(9);
        expect(
            recoverySignal(m, s, { ...DEFAULT_SETTINGS, recoveryMode: 'under5_filtered_once' }, 10000)
        ).toBeUndefined();
    });
    it('uses Under 4/6 barriers and opposite ten-digit parity formations', () => {
        const m = market();
        expect(
            recoverySignal(
                m,
                { streak: 1, countAfter: 0, pauseUntil: 0 },
                { ...DEFAULT_SETTINGS, recoveryMode: 'under4_filtered_once' },
                10000
            )?.barrier
        ).toBe('4');
        expect(
            recoverySignal(
                m,
                { streak: 1, countAfter: 0, pauseUntil: 0 },
                { ...DEFAULT_SETTINGS, recoveryMode: 'under6_filtered_once' },
                10000
            )?.barrier
        ).toBe('6');
        m.digits.splice(-10, 10, ...Array(10).fill(2));
        expect(
            recoverySignal(
                m,
                { streak: 1, countAfter: 0, pauseUntil: 0 },
                { ...DEFAULT_SETTINGS, recoveryMode: 'parity_pair' },
                10000
            )?.direction
        ).toBe('DIGITODD');
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

describe('percentage-based Even/Odd recovery', () => {
    const recovery = { streak: 1, countAfter: 0, pauseUntil: 0 };
    const parityMarket = (evenCount: number, symbol = 'R_100') => {
        const m = market();
        m.symbol = symbol;
        m.digits = [...Array<number>(evenCount).fill(0), ...Array<number>(1000 - evenCount).fill(1)];
        return m;
    };
    it.each([
        [550, 'DIGITEVEN'],
        [450, 'DIGITODD'],
        [531, 'DIGITEVEN'],
        [469, 'DIGITODD'],
        [540, 'DIGITEVEN'],
        [460, 'DIGITODD'],
        [530, undefined],
        [520, undefined],
        [480, undefined],
        [470, undefined],
        [500, undefined],
    ])('evaluates %i even digits with strict thresholds', (count, expected) => {
        expect(recoverySignal(parityMarket(count as number), recovery, DEFAULT_SETTINGS, 10000)?.direction).toBe(
            expected
        );
    });
    it('compares both sides on every market, includes 1s, ignores old locks and selects the strongest eligible share', () => {
        const even = parityMarket(550),
            odd = parityMarket(400, '1HZ100V');
        expect(
            chooseSignal(
                [even, odd],
                { ...recovery, lockedSymbol: even.symbol, lockedDirection: 'DIGITEVEN' },
                DEFAULT_SETTINGS,
                10000
            )
        ).toMatchObject({ symbol: odd.symbol, direction: 'DIGITODD', recovery: true, formation: false });
        odd.digits = [...Array<number>(650).fill(0), ...Array<number>(350).fill(1)];
        expect(chooseSignal([even, odd], recovery, DEFAULT_SETTINGS, 10000)).toMatchObject({
            symbol: odd.symbol,
            direction: 'DIGITEVEN',
        });
        expect(chooseSignal([even, odd], recovery, DEFAULT_SETTINGS, 14000)).toBeUndefined();
    });
});

describe('standalone Even/Odd strategy', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, strategy: 'even-odd' };
    const state = { streak: 0, countAfter: 0, pauseUntil: 0 };
    it('selects the strongest qualifying parity market for normal trades and recovery', () => {
        const even = market([120, 80, 120, 80, 120, 80, 120, 80, 120, 80]);
        const odd = market([70, 130, 70, 130, 70, 130, 70, 130, 70, 130]);
        odd.symbol = 'R_50';
        even.digits.splice(-3, 3, 2, 4, 1);
        odd.digits.splice(-3, 3, 1, 3, 2);
        const normal = chooseSignal([even, odd], state, settings, 10000);
        expect(normal).toMatchObject({ symbol: 'R_50', direction: 'DIGITODD', recovery: false });
        expect(normal?.barrier).toBeUndefined();
        expect(chooseSignal([even], { ...state, streak: 1 }, settings, 10000)).toMatchObject({
            direction: 'DIGITEVEN',
            recovery: true,
        });
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

it('locks standalone recovery through percentage drift and partial wins, but requires its first fresh formation', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, strategy: 'even-odd' };
    const m = market([120, 80, 120, 80, 120, 80, 120, 80, 120, 80]);
    const state = { streak: 1, deficit: 35, countAfter: 9999, pauseUntil: 0 };
    expect(chooseSignal([m], state, settings, 10000)).toBeUndefined();
    m.digits.splice(-3, 3, 2, 4, 1);
    expect(chooseSignal([m], state, settings, 10000)).toMatchObject({
        direction: 'DIGITEVEN',
        recovery: true,
        formation: true,
    });
    expect(chooseSignal([m], { ...state, countAfter: 10000 }, settings, 10000)).toBeUndefined();
    m.digits = Array(1000).fill(1);
    expect(
        chooseSignal(
            [m],
            { ...state, streak: 0, deficit: 6, lockedSymbol: m.symbol, lockedDirection: 'DIGITEVEN' },
            settings,
            10000
        )
    ).toMatchObject({ direction: 'DIGITEVEN', recovery: true, formation: false });
    expect(
        chooseSignal([m], { ...state, lockedSymbol: m.symbol, lockedDirection: 'DIGITEVEN' }, settings, 14000)
    ).toBeUndefined();
});
