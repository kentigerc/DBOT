import { evaluateScan, scanDigits } from '../scanner';

const sample = (counts: number[]) => counts.flatMap((count, digit) => Array<number>(count).fill(digit));
const over = [8, 9, 9, 9, 10, 10, 11, 11, 11, 12];
const under = [...over].reverse();
describe('Over/Under market scanner', () => {
    it('uses mirrored digit ranges and marker positions', () => {
        expect(scanDigits('over')).toEqual([0, 1, 2, 3]);
        expect(scanDigits('under')).toEqual([6, 7, 8, 9]);
        expect(evaluateScan(sample(over), 'over', 100)).toMatchObject({
            matches: true,
            redDigits: [0],
            greenDigits: [9],
        });
        expect(evaluateScan(sample(under), 'under', 100)).toMatchObject({
            matches: true,
            redDigits: [9],
            greenDigits: [0],
        });
    });
    it('rejects exactly ten percent even when both marker groups are correct', () => {
        expect(evaluateScan(sample([8, 10, 9, 9, 9, 10, 11, 11, 11, 12]), 'over', 100).matches).toBe(false);
    });
    it('rejects a red or green mark outside its required group', () => {
        expect(evaluateScan(sample([9, 9, 9, 9, 8, 11, 11, 11, 11, 12]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample([8, 9, 9, 9, 12, 10, 11, 11, 10, 11]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample(over), 'under', 100).matches).toBe(false);
        expect(evaluateScan(sample(under), 'over', 100).matches).toBe(false);
    });
    it('requires every tied mark to be in its group', () => {
        expect(evaluateScan(sample([8, 8, 9, 9, 8, 11, 11, 11, 12, 13]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample([8, 9, 9, 9, 12, 8, 11, 11, 11, 12]), 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample([8, 8, 9, 9, 10, 10, 11, 11, 12, 12]), 'over', 100)).toMatchObject({
            matches: true,
            redDigits: [0, 1],
            greenDigits: [8, 9],
        });
    });
    it('ignores the latest-digit outline and rejects incomplete or uniform data', () => {
        const digits = sample(over);
        digits.push(digits.shift()!);
        expect(evaluateScan(digits, 'over', 100).matches).toBe(true);
        expect(evaluateScan(digits.slice(1), 'over', 100).matches).toBe(false);
        expect(evaluateScan([], 'over', 100).matches).toBe(false);
        expect(evaluateScan(sample(Array(10).fill(10)), 'over', 100).matches).toBe(false);
    });
});
