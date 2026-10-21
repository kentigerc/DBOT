import { digitFrequencies, lastDigit } from '../digits';

describe('live last-digit statistics', () => {
    it('counts the quoted last digit at the market precision, including trailing zeroes', () => {
        expect(lastDigit(123.4, 2)).toBe(0);
        expect(lastDigit('123.456', 3)).toBe(6);
        expect(lastDigit(100, 0)).toBe(0);
        expect(lastDigit('invalid', 2)).toBeNull();
        expect(lastDigit(1, -1)).toBeNull();
    });
    it('uses the actual sample count and retains digits with zero occurrences', () => {
        const stats = digitFrequencies([0, 0, 3, 9]);
        expect(stats).toHaveLength(10);
        expect(stats[0]).toEqual({ count: 2, percent: 50 });
        expect(stats[3]).toEqual({ count: 1, percent: 25 });
        expect(stats[1]).toEqual({ count: 0, percent: 0 });
        expect(stats.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
        expect(digitFrequencies([]).every(item => item.percent === 0)).toBe(true);
    });
});
