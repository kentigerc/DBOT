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
                    DEFAULT_SETTINGS,
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
        expect(recoverySignal(m, { ...s, lockedSymbol: 'R_50' }, DEFAULT_SETTINGS, 10000)).toBeUndefined();
        expect(recoverySignal(m, { ...s, pauseUntil: 11000 }, DEFAULT_SETTINGS, 10000)).toBeUndefined();
        expect(recoverySignal(m, s, DEFAULT_SETTINGS, 14000)).toBeUndefined();
        m.symbol = '1HZ100V';
        m.digits = Array(1000).fill(9);
        expect(recoverySignal(m, s, DEFAULT_SETTINGS, 10000)).toBeUndefined();
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
