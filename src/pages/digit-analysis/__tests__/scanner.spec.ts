import { evaluateScan, scanDigits } from '../scanner';

const sample = (counts: number[]) => counts.flatMap((count, digit) => Array<number>(count).fill(digit));
describe('Over/Under market scanner', () => {
    it('uses the requested mirrored digit ranges', () => {
        expect(scanDigits('over')).toEqual([0, 1, 2, 3]);
        expect(scanDigits('under')).toEqual([6, 7, 8, 9]);
    });
    it('accepts four digits strictly below ten percent without extrema or the latest mark', () => {
        expect(evaluateScan(sample([9, 9, 9, 9, 8, 11, 11, 11, 11, 12]), 'over', 100).matches).toBe(true);
        const under = sample([8, 11, 11, 11, 11, 12, 9, 9, 9, 9]);
        under.push(under.shift()!); // Latest tick outside the selected range.
        expect(evaluateScan(under, 'under', 100).matches).toBe(true);
    });
    it('rejects exactly ten percent and all tied minima', () => {
        expect(evaluateScan(sample([10, 9, 9, 9, 8, 11, 11, 11, 11, 11]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample([8, 8, 9, 9, 8, 11, 11, 11, 12, 13]), 'over', 100).matches).toBe(false);
    });
    it('rejects a selected latest digit and incomplete data', () => {
        const digits = sample([9, 9, 9, 9, 8, 11, 11, 11, 11, 12]);
        digits.push(digits.shift()!);
        expect(evaluateScan(digits, 'over', 100).matches).toBe(false);
        expect(evaluateScan(digits.slice(1), 'over', 100).matches).toBe(false);
        expect(evaluateScan([], 'over', 100).matches).toBe(false);
    });
});
