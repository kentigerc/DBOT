import { cycleDirections } from '@/services/digit-strategy/strategy';
import { digitFrequencies } from '../digits';
import { evaluateScan, scanDigits } from '../scanner';
const sample = (counts: number[]) => counts.flatMap((count, digit) => Array<number>(count).fill(digit));
const over = [9, 9, 9, 8, 10, 10, 11, 11, 11, 12];
const under = [...over].reverse();
const endWith = (digits: number[], last: number) => {
    const index = digits.indexOf(last);
    return [...digits.slice(0, index), ...digits.slice(index + 1), last];
};
describe('Over/Under market scanner', () => {
    it('retains the wider protection regions independently of the new entry ranges', () => {
        expect(scanDigits('over')).toEqual([0, 1, 2, 3]);
        expect(scanDigits('under')).toEqual([6, 7, 8, 9]);
        expect(evaluateScan(sample(over), 'over', 100)).toMatchObject({
            matches: true,
            redDigits: [3],
            greenDigits: [9],
        });
        expect(evaluateScan(sample(under), 'under', 100)).toMatchObject({
            matches: true,
            redDigits: [6],
            greenDigits: [0],
        });
    });
    it('rejects exactly ten percent and every tied frequency mark on entry digits', () => {
        expect(evaluateScan(sample([10, 9, 9, 7, 10, 10, 11, 11, 11, 12]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample([8, 9, 9, 9, 10, 10, 11, 11, 11, 12]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample([8, 9, 9, 8, 10, 10, 11, 11, 12, 12]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample(under), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample(over), 'under', 100).matches).toBe(false);
    });
    it.each(['over', 'under'] as const)(
        'agrees with HIT AND RUN entry selection for %s on every latest digit',
        side => {
            const digits = sample(side === 'over' ? over : under);
            const frequencies = digitFrequencies(digits);
            const maximum = Math.max(...frequencies.map(row => row.count));
            const minimum = Math.min(...frequencies.map(row => row.count));
            for (let latest = 0; latest <= 9; latest++) {
                const expected = cycleDirections(
                    frequencies.map((row, digit) => ({
                        digit,
                        count: row.count,
                        percentage: row.percent,
                        most: row.count === maximum,
                        least: row.count === minimum,
                    })),
                    latest
                );
                expect(evaluateScan(endWith(digits, latest), side, 100).entryReady).toBe(
                    expected.includes(side === 'over' ? 'DIGITOVER' : 'DIGITUNDER')
                );
            }
        }
    );
    it('requires a complete nonuniform sample and distinguishes a market match from the purchase digit', () => {
        expect(evaluateScan(sample(over), 'over', 100)).toMatchObject({ matches: true, entryReady: false });
        expect(evaluateScan(endWith(sample(over), 1), 'over', 100).entryReady).toBe(true);
        expect(evaluateScan(sample(over).slice(1), 'over', 100).matches).toBe(false);
        expect(evaluateScan([], 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample(Array(10).fill(10)), 'over', 100).matches).toBe(false);
    });
});
