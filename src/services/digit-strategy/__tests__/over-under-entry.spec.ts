import { OverUnderEntries } from '../over-under-entry';

const seed = (under = false) => {
    const digits = [90, 90, 90, 80, 100, 100, 110, 110, 110, 120].flatMap((count, digit) =>
        Array<number>(count).fill(under ? 9 - digit : digit)
    );
    const entries = new OverUnderEntries();
    let epoch = 1000;
    entries.observe(digits, epoch, false);
    return {
        entries,
        tick(digit: number, live = true) {
            digits.shift();
            digits.push(digit);
            entries.observe(digits, ++epoch, live);
        },
        digits,
    };
};
it.each([false, true])('requires rising winning share then two consecutive winning digits (under=%s)', under => {
    const { entries, tick } = seed(under);
    const direction = under ? 'DIGITUNDER' : 'DIGITOVER';
    const barrier = under ? 7 : 2;
    const winner = under ? 4 : 5;
    const loser = under ? 8 : 1;
    tick(winner);
    expect(entries.ready(direction, barrier)).toBe(false);
    tick(winner);
    expect(entries.ready(direction, barrier)).toBe(false);
    tick(loser);
    expect(entries.ready(direction, barrier)).toBe(false);
    tick(winner);
    expect(entries.ready(direction, barrier)).toBe(false);
    tick(winner);
    expect(entries.ready(direction, barrier)).toBe(true);
    entries.reset();
    expect(entries.ready(direction, barrier)).toBe(false);
});
it('checks each actual barrier and rejects 69.9%, flat momentum and historical formations', () => {
    const entries = new OverUnderEntries();
    let digits = [...Array<number>(301).fill(0), ...Array<number>(699).fill(3)];
    entries.observe(digits, 1000, false);
    expect(entries.ready('DIGITOVER', 2)).toBe(false);
    for (let epoch = 1001; epoch <= 1003; epoch++) entries.observe(digits, epoch);
    expect(entries.ready('DIGITOVER', 2)).toBe(false);
    for (let epoch = 1004; epoch <= 1006; epoch++) {
        digits = [...digits.slice(1), 3];
        entries.observe(digits, epoch);
    }
    expect(entries.ready('DIGITOVER', 2)).toBe(true);
    expect(entries.ready('DIGITOVER', 3)).toBe(false);
    expect(entries.ready('DIGITUNDER', 5)).toBe(false); // 100% but no increase.
    entries.observe(digits, 1007);
    expect(entries.ready('DIGITOVER', 2)).toBe(false);
});
it('clears formation on nonlive data, a feed gap or a falling winning share and ignores duplicate ticks', () => {
    const { entries, tick, digits } = seed();
    for (let i = 0; i < 3; i++) tick(5);
    expect(entries.ready('DIGITOVER', 2)).toBe(true);
    entries.observe(
        digits.map(() => 0),
        1003
    );
    expect(entries.ready('DIGITOVER', 2)).toBe(true); // Duplicate epoch ignored.
    tick(0, false);
    expect(entries.ready('DIGITOVER', 2)).toBe(false);
    for (let i = 0; i < 3; i++) tick(5);
    expect(entries.ready('DIGITOVER', 2)).toBe(true);
    entries.observe(digits, 1020);
    expect(entries.ready('DIGITOVER', 2)).toBe(false);
});
