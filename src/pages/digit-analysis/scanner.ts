import { digitFrequencies } from './digits';

export type ScanSide = 'over' | 'under';
export const scanDigits = (side: ScanSide) => (side === 'over' ? [0, 1, 2, 3] : [6, 7, 8, 9]);

// The circles mark every tied minimum red and every tied maximum green.
export function evaluateScan(digits: number[], side: ScanSide, expectedSize: number) {
    const frequencies = digitFrequencies(digits);
    const counts = frequencies.map(item => item.count);
    const high = Math.max(...counts);
    const low = Math.min(...counts);
    const redRange = side === 'over' ? [0, 1, 2] : [7, 8, 9];
    const selected = redRange.map(digit => ({ digit, ...frequencies[digit] }));
    const redDigits = counts.flatMap((count, digit) => (high !== low && count === low ? [digit] : []));
    const greenDigits = counts.flatMap((count, digit) => (high !== low && count === high ? [digit] : []));
    const matches =
        digits.length === expectedSize &&
        expectedSize > 0 &&
        selected.every(
            item =>
                item.count * 10 < expectedSize && !redDigits.includes(item.digit) && !greenDigits.includes(item.digit)
        );
    const latest = digits[digits.length - 1];
    return {
        selected,
        redDigits,
        greenDigits,
        matches,
        entryReady: matches && (side === 'over' ? latest === 1 || latest === 2 : latest === 7 || latest === 8),
    };
}
