import {
    chooseSignal,
    cycleDirections,
    cycleSignal,
    DEFAULT_SETTINGS,
    DigitMarket,
    validateSettings,
} from '../strategy';
const counts = [90, 90, 90, 80, 100, 100, 110, 110, 110, 120];
const market = (under = false, latest = under ? 4 : 5) => {
    const m = new DigitMarket('R_100', 2, 'Volatility 100 Index');
    const digits = counts.flatMap((count, digit) => Array<number>(count).fill(under ? 9 - digit : digit));
    digits.forEach((digit, i) => m.add(100 + digit / 100, i + 1));
    for (let i = 1; i <= 5; i++) m.add(100 + latest / 100, 1000 + i, 5000 + i * 1000);
    return m;
};
const recovery = { streak: 0, countAfter: 0, pauseUntil: 0 };
describe('HIT AND RUN entry rules', () => {
    it.each([3, 5, 9])('enters Over 2 only after digit %s', digit => {
        expect(cycleSignal(market(false, digit), recovery, 10000)).toMatchObject({
            direction: 'DIGITOVER',
            barrier: '2',
            recovery: false,
            formation: true,
        });
    });
    it.each([0, 4, 6])('enters Under 7 only after digit %s', digit => {
        expect(cycleSignal(market(true, digit), recovery, 10000)).toMatchObject({
            direction: 'DIGITUNDER',
            barrier: '7',
        });
    });
    it('rejects losing digits and requires live formation readings instead of frequency marks', () => {
        expect(cycleSignal(market(false, 2), recovery, 10000)).toBeUndefined();
        expect(cycleSignal(market(true, 7), recovery, 10000)).toBeUndefined();
        const m = market();
        expect(cycleDirections(m.entries)).toEqual(['DIGITOVER']);
        m.entries.reset();
        expect(cycleDirections(m.entries)).toEqual([]);
    });
    it('requires a tick after the batch cooldown before a new normal entry', () => {
        const m = market();
        expect(cycleSignal(m, { ...recovery, countAfter: 10000, pauseUntil: 10000 }, 10000)).toBeUndefined();
        m.add(100.05, 1006, 11000);
        expect(cycleSignal(m, { ...recovery, countAfter: 10000, pauseUntil: 10000 }, 11000)?.direction).toBe(
            'DIGITOVER'
        );
    });
    it('scans both directions initially, then retains the selected contract without reanalysis', () => {
        const over = market(),
            under = market(true);
        under.symbol = 'R_50';
        const settings = { ...DEFAULT_SETTINGS, strategy: 'over2-under7' as const };
        expect(chooseSignal([over], recovery, settings, 10000)?.direction).toBe('DIGITOVER');
        expect(chooseSignal([under], recovery, settings, 10000)?.direction).toBe('DIGITUNDER');
        const locked = { ...recovery, streak: 1, lockedSymbol: 'R_100', lockedDirection: 'DIGITOVER' as const };
        expect(chooseSignal([under], locked, settings, 10000)).toBeUndefined();
        expect(cycleSignal(over, locked, 10000)?.recovery).toBe(true);
        over.entries.reset();
        expect(cycleSignal(over, recovery, 10000)).toBeUndefined();
        expect(cycleSignal(over, { ...locked, countAfter: 10000 }, 10000)).toMatchObject({
            direction: 'DIGITOVER',
            barrier: '2',
            recovery: true,
            formation: false,
        });
        expect(cycleSignal(over, locked, 14000)).toBeUndefined();
        expect(() => validateSettings({ ...settings, strategy: 'bad' } as never)).toThrow('Invalid trading strategy');
    });
});

describe('HIT AND RUN direction selection across fresh analyses', () => {
    const settings = { ...DEFAULT_SETTINGS, strategy: 'over2-under7' as const };
    it('can select either direction when both qualify, without privileging the newest feed', () => {
        const over = market(),
            under = market(true);
        under.symbol = 'R_50';
        under.received = 10001;
        expect(chooseSignal([over, under], recovery, settings, 10001, () => 0)).toMatchObject({
            direction: 'DIGITOVER',
            barrier: '2',
        });
        expect(chooseSignal([over, under], recovery, settings, 10001, () => 0.999)).toMatchObject({
            direction: 'DIGITUNDER',
            barrier: '7',
        });
    });
    it('never forces alternation when only one direction fully qualifies', () => {
        const over = market(false, 2),
            under = market(true);
        under.symbol = 'R_50';
        for (const random of [0, 0.5, 0.999]) {
            expect(chooseSignal([over, under], recovery, settings, 10000, () => random)?.direction).toBe('DIGITUNDER');
        }
        over.entries = market().entries;
        under.entries.reset();
        expect(chooseSignal([over, under], recovery, settings, 10000, () => 0.999)?.direction).toBe('DIGITOVER');
    });
    it('holds Under through recovery, then allows Over after the batch releases the lock', () => {
        const over = market(),
            under = market(true);
        under.symbol = 'R_50';
        const locked = { ...recovery, streak: 1, lockedSymbol: 'R_50', lockedDirection: 'DIGITUNDER' as const };
        expect(chooseSignal([over, under], locked, settings, 10000, () => 0)?.direction).toBe('DIGITUNDER');
        expect(chooseSignal([over, under], recovery, settings, 10000, () => 0)?.direction).toBe('DIGITOVER');
    });
});
