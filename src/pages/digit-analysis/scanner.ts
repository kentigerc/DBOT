import { digitFrequencies } from './digits';

export type ScanSide = 'over' | 'under';
export const scanDigits = (side: ScanSide) => (side === 'over' ? [0, 1, 2, 3] : [6, 7, 8, 9]);

// Match the circles' extrema (including ties) and the red latest-tick outline.
export function evaluateScan(digits: number[], side: ScanSide, expectedSize: number) {
    const frequencies = digitFrequencies(digits);
    const counts = frequencies.map(item => item.count);
    const high = Math.max(...counts);
    const low = Math.min(...counts);
    const selected = scanDigits(side).map(digit => ({ digit, ...frequencies[digit] }));
    return {
        selected,
        matches:
            digits.length === expectedSize &&
            expectedSize > 0 &&
            selected.every(
                item =>
                    item.percent < 10 &&
                    !(high !== low && (item.count === high || item.count === low)) &&
                    item.digit !== digits[digits.length - 1]
            ),
    };
}
