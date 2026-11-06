import { OverUnderEntries } from '@/services/digit-strategy/over-under-entry';
import { digitFrequencies } from './digits';

export type ScanSide = 'over' | 'under';
export const scanDigits = (side: ScanSide) => (side === 'over' ? [0, 1, 2, 3] : [6, 7, 8, 9]);

// The circles mark every tied minimum red and every tied maximum green.
export function evaluateScan(digits: number[], side: ScanSide, expectedSize: number, entries?: OverUnderEntries) {
    const frequencies = digitFrequencies(digits);
    const counts = frequencies.map(item => item.count);
    const high = Math.max(...counts);
    const low = Math.min(...counts);
    const redRange = side === 'over' ? [0, 1, 2] : [7, 8, 9];
    const selected = redRange.map(digit => ({ digit, ...frequencies[digit] }));
    const redDigits = counts.flatMap((count, digit) => (high !== low && count === low ? [digit] : []));
    const greenDigits = counts.flatMap((count, digit) => (high !== low && count === high ? [digit] : []));
    const winning = side === 'over' ? frequencies.slice(3) : frequencies.slice(0, 7);
    const percentage = (winning.reduce((sum, item) => sum + item.count, 0) * 100) / expectedSize;
    const matches = digits.length === expectedSize && expectedSize > 0 && percentage >= 70;
    return {
        selected,
        redDigits,
        greenDigits,
        matches,
        entryReady: matches && !!entries?.ready(side === 'over' ? 'DIGITOVER' : 'DIGITUNDER', side === 'over' ? 2 : 7),
        percentage,
    };
}
