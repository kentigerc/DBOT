import { digitFrequencies } from './digits';

export type ScanSide = 'over' | 'under';
export const scanDigits = (side: ScanSide) => (side === 'over' ? [0, 1, 2, 3] : [6, 7, 8, 9]);

// The circles mark every tied minimum red and every tied maximum green.
export function evaluateScan(digits: number[], side: ScanSide, expectedSize: number) {
    const frequencies = digitFrequencies(digits);
    const counts = frequencies.map(item => item.count);
    const high = Math.max(...counts);
    const low = Math.min(...counts);
    const redRange = scanDigits(side);
    const greenRange = scanDigits(side === 'over' ? 'under' : 'over');
    const selected = redRange.map(digit => ({ digit, ...frequencies[digit] }));
    const redDigits = counts.flatMap((count, digit) => (high !== low && count === low ? [digit] : []));
    const greenDigits = counts.flatMap((count, digit) => (high !== low && count === high ? [digit] : []));
    return {
        selected,
        redDigits,
        greenDigits,
        matches:
            digits.length === expectedSize &&
            expectedSize > 0 &&
            selected.every(item => item.percent < 10) &&
            redDigits.length > 0 &&
            greenDigits.length > 0 &&
            redDigits.every(digit => redRange.includes(digit)) &&
            greenDigits.every(digit => greenRange.includes(digit)),
    };
}
