import {
    chooseSignal,
    DEFAULT_SETTINGS,
    DigitMarket,
    momentumSignal,
    validateSettings,
    type Settings,
} from '../strategy';
const settings: Settings = { ...DEFAULT_SETTINGS, strategy: 'momentum-70', recoveryMode: 'same_contract' };
const state = { streak: 0, countAfter: 0, pauseUntil: 0 };
function feed(side: 'over' | 'under' = 'over', winners = 700) {
    let now = 1700000000000;
    const m = new DigitMarket(side === 'over' ? 'R_10' : 'R_50', 2, 'Volatility Index');
    const outside = side === 'over' ? 0 : 9,
        inside = side === 'over' ? 4 : 2;
    const digits = [...Array<number>(1000 - winners).fill(outside), ...Array<number>(winners).fill(inside)];
    digits.forEach((digit, i) => m.add(100 + digit / 100, now / 1000 - 1000 + i));
    const tick = (digit: number, ms = 1000) => {
        now += ms;
        m.add(100 + digit / 100, now / 1000, now);
    };
    for (let i = 0; i < 3; i++) tick(outside);
    return { m, tick, now: () => now };
}
it.each(['over', 'under'] as const)(
    'arms a rising %s share and then waits for two consecutive qualifying live digits',
    side => {
        const f = feed(side),
            a = side === 'over' ? 3 : 2,
            b = side === 'over' ? 8 : 6;
        f.tick(a);
        expect(momentumSignal(f.m, state, f.now())).toBeUndefined();
        f.tick(a);
        expect(momentumSignal(f.m, state, f.now())).toBeUndefined();
        f.tick(b);
        expect(momentumSignal(f.m, state, f.now())).toMatchObject({
            direction: side === 'over' ? 'DIGITOVER' : 'DIGITUNDER',
            barrier: side === 'over' ? '2' : '7',
            recovery: false,
        });
    }
);
it('requires a 70% threshold and an actual increase; a flat share is not a rising entry', () => {
    const low = feed('over', 690);
    for (let i = 0; i < 3; i++) low.tick(4);
    expect(momentumSignal(low.m, state, low.now())).toBeUndefined();
    const flat = feed('over', 1000);
    for (let i = 0; i < 6; i++) flat.tick(4);
    expect(flat.m.momentum.DIGITOVER.change).toBe(0);
    expect(momentumSignal(flat.m, state, flat.now())).toBeUndefined();
});
it('breaks the formation on an outside digit and never enters from stale or gapped data', () => {
    const f = feed();
    f.tick(3);
    f.tick(4);
    f.tick(1);
    f.tick(5);
    expect(momentumSignal(f.m, state, f.now())).toBeUndefined();
    f.tick(6);
    expect(momentumSignal(f.m, state, f.now())).toBeDefined();
    expect(momentumSignal(f.m, state, f.now() + 4000)).toBeUndefined();
    f.tick(7, 7000);
    expect(f.m.momentum.DIGITOVER.armed).toBe(false);
    expect(momentumSignal(f.m, state, f.now())).toBeUndefined();
});
it('compares both directions across markets and locks recovery to the losing market and direction', () => {
    const over = feed('over', 700),
        under = feed('under', 720);
    [3, 4, 8].forEach(d => over.tick(d));
    [2, 5, 6].forEach(d => under.tick(d));
    expect(chooseSignal([over.m, under.m], state, settings, under.now())).toMatchObject({
        symbol: 'R_50',
        direction: 'DIGITUNDER',
    });
    const recovery = { ...state, streak: 1, lockedSymbol: 'R_10', lockedDirection: 'DIGITOVER' as const };
    expect(chooseSignal([over.m, under.m], recovery, settings, over.now())).toMatchObject({
        symbol: 'R_10',
        direction: 'DIGITOVER',
        barrier: '2',
        recovery: true,
    });
    expect(momentumSignal(over.m, { ...recovery, countAfter: over.now() }, over.now())).toBeUndefined();
});
it('requires the same-contract policy and validates one-to-five tick durations', () => {
    expect(() => validateSettings(settings)).not.toThrow();
    expect(() => validateSettings({ ...settings, duration: 5 })).not.toThrow();
    expect(() => validateSettings({ ...settings, duration: 6 })).toThrow();
    expect(() => validateSettings({ ...settings, recoveryMode: 'parity_percentage' })).toThrow();
    expect(() => validateSettings({ ...settings, strategy: undefined })).toThrow();
});
it('arms exactly at 70% when the previous sample was below the threshold', () => {
    const f = feed('over', 699);
    f.tick(3);
    expect(f.m.momentum.DIGITOVER).toMatchObject({ percentage: 70, armed: true, run: 0 });
    expect(momentumSignal(f.m, state, f.now())).toBeUndefined();
});
