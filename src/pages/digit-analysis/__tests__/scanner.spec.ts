import { OverUnderEntries } from '@/services/digit-strategy/over-under-entry';
import { evaluateScan, scanDigits } from '../scanner';
const sample = (counts: number[]) => counts.flatMap((count, digit) => Array<number>(count).fill(digit));
const over = [9, 9, 9, 8, 10, 10, 11, 11, 11, 12];
it('keeps protection regions separate from the normal contract winning digits', () => {
    expect(scanDigits('over')).toEqual([0, 1, 2, 3]);
    expect(scanDigits('under')).toEqual([6, 7, 8, 9]);
    expect(evaluateScan(sample(over), 'over', 100)).toMatchObject({
        matches: true,
        percentage: 73,
        redDigits: [3],
        greenDigits: [9],
        entryReady: false,
    });
    expect(evaluateScan(sample([...over].reverse()), 'under', 100)).toMatchObject({ matches: true, percentage: 73 });
});
it('requires a complete sample and at least 70%, allowing frequency marks on individual digits', () => {
    expect(evaluateScan(sample([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), 'over', 100).matches).toBe(true);
    expect(evaluateScan(sample([11, 10, 10, 9, 10, 10, 10, 10, 10, 10]), 'over', 100).matches).toBe(false);
    expect(evaluateScan(sample(over).slice(1), 'over', 100).matches).toBe(false);
    expect(evaluateScan([], 'over', 100).matches).toBe(false);
});
it.each(['over', 'under'] as const)('waits for rising momentum and two winning digits for %s', side => {
    const entries = new OverUnderEntries();
    let digits = sample(over).map(d => (side === 'over' ? d : 9 - d));
    entries.observe(digits, 1000, false);
    for (let i = 1; i <= 3; i++) {
        digits = [...digits.slice(1), side === 'over' ? 5 : 4];
        entries.observe(digits, 1000 + i);
        expect(evaluateScan(digits, side, 100, entries).entryReady).toBe(i === 3);
    }
    entries.reset();
    expect(evaluateScan(digits, side, 100, entries).entryReady).toBe(false);
});
