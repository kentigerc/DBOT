import {
    chooseSignal,
    cycleDirections,
    cycleSignal,
    DEFAULT_SETTINGS,
    DigitMarket,
    validateSettings,
} from '../strategy';
const counts = [90, 90, 90, 80, 100, 100, 110, 110, 110, 120];
const market = (under = false, latest = under ? 7 : 1) => {
    const m = new DigitMarket('R_100', 2, 'Volatility 100 Index');
    m.digits = (under ? [...counts].reverse() : counts).flatMap((count, digit) => Array<number>(count).fill(digit));
    m.digits[m.digits.length - 1] = latest;
    m.epochs = Array.from({ length: 1000 }, (_, i) => i + 1);
    m.received = 10000;
    m.liveTicks = 3;
    return m;
};
const recovery = { streak: 0, countAfter: 0, pauseUntil: 0 };
describe('HIT AND RUN entry rules', () => {
    it.each([1, 2])('enters Over 2 only after digit %s', digit => {
        expect(cycleSignal(market(false, digit), recovery, 10000)).toMatchObject({
            direction: 'DIGITOVER',
            barrier: '2',
            recovery: false,
            formation: true,
        });
    });
    it.each([7, 8])('enters Under 7 only after digit %s', digit => {
        expect(cycleSignal(market(true, digit), recovery, 10000)).toMatchObject({
            direction: 'DIGITUNDER',
            barrier: '7',
        });
    });
    it('rejects other last digits, exact ten percent and every marked target digit', () => {
        expect(cycleSignal(market(false, 0), recovery, 10000)).toBeUndefined();
        expect(cycleSignal(market(true, 9), recovery, 10000)).toBeUndefined();
        const frequencies = market().frequencies();
        for (const invalid of [
            { ...frequencies[1], percentage: 10 },
            { ...frequencies[1], least: true },
            { ...frequencies[1], most: true },
        ]) {
            const changed = frequencies.map(item => (item.digit === 1 ? invalid : item));
            expect(cycleDirections(changed, 1)).toEqual([]);
        }
    });
    it('scans both directions, locks a sequence and requires fresh recovery eligibility', () => {
        const over = market(),
            under = market(true);
        under.symbol = 'R_50';
        const settings = { ...DEFAULT_SETTINGS, strategy: 'over2-under7' as const };
        expect(chooseSignal([over], recovery, settings, 10000)?.direction).toBe('DIGITOVER');
        expect(chooseSignal([under], recovery, settings, 10000)?.direction).toBe('DIGITUNDER');
        const locked = { ...recovery, streak: 1, lockedSymbol: 'R_100', lockedDirection: 'DIGITOVER' as const };
        expect(chooseSignal([under], locked, settings, 10000)).toBeUndefined();
        expect(cycleSignal(over, locked, 10000)?.recovery).toBe(true);
        expect(cycleSignal(over, { ...locked, countAfter: 10000 }, 10000)).toBeUndefined();
        expect(cycleSignal(over, locked, 14000)).toBeUndefined();
        expect(() => validateSettings({ ...settings, strategy: 'bad' } as never)).toThrow('Invalid trading strategy');
    });
});
