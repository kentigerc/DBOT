import {
    chooseSignal,
    DEFAULT_SETTINGS,
    DigitMarket,
    momentumSignal,
    validateSettings,
    sharedRecoverySettings,
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
            barrier: side === 'over' ? '1' : '8',
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

it.each(['over', 'under'] as const)(
    'scans all markets for a rising 52%% %s recovery and locks only after purchase',
    side => {
        const direction = side === 'over' ? 'DIGITOVER' : 'DIGITUNDER';
        const f = feed(side, 520);
        const recovery = { ...state, streak: 1, momentumPending: true, lockedDirection: direction } as const;
        f.tick(side === 'over' ? 4 : 2);
        expect(chooseSignal([f.m], recovery, settings, f.now())).toBeUndefined();
        f.tick(side === 'over' ? 5 : 3);
        expect(chooseSignal([f.m], recovery, settings, f.now())).toBeUndefined();
        f.tick(side === 'over' ? 8 : 4);
        const selected = chooseSignal([f.m], recovery, settings, f.now());
        expect(selected).toMatchObject({
            direction,
            barrier: side === 'over' ? '3' : '6',
            recovery: true,
            formation: true,
        });
        const low = feed(side, 500);
        for (let i = 0; i < 3; i++) low.tick(side === 'over' ? 4 : 2);
        expect(chooseSignal([low.m], recovery, settings, low.now())).toBeUndefined();
        const flat = feed(side, 1000);
        for (let i = 0; i < 5; i++) flat.tick(side === 'over' ? 4 : 2);
        expect(chooseSignal([flat.m], recovery, settings, flat.now())).toBeUndefined();
        const stronger = feed(side, 800);
        stronger.m.symbol = '1HZ100V';
        for (let i = 0; i < 3; i++) stronger.tick(side === 'over' ? 4 : 2);
        expect(chooseSignal([f.m, stronger.m], recovery, settings, stronger.now())?.symbol).toBe('1HZ100V');
        f.m.resetMomentum();
        const locked = { ...recovery, recoveryLocked: true, lockedSymbol: f.m.symbol };
        expect(chooseSignal([f.m, stronger.m], locked, settings, f.now())).toMatchObject({
            symbol: f.m.symbol,
            direction,
            formation: false,
        });
        expect(chooseSignal([f.m], locked, settings, f.now() + 4000)).toBeUndefined();
    }
);

it('normalizes only Momentum to the paired recovery policy while retaining its chosen multiplier', () => {
    expect(sharedRecoverySettings({ ...settings, recoveryMode: 'parity_percentage', multiplier: 2.5 })).toMatchObject({
        recoveryMode: 'same_contract',
        hitRecovery: 'same_contract',
        multiplier: 2.5,
    });
    for (const strategy of [undefined, 'over2-under7', 'even-odd'] as const)
        expect(sharedRecoverySettings({ ...DEFAULT_SETTINGS, strategy }).recoveryMode).toBe('parity_percentage');
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
it('compares both normal directions across markets', () => {
    const over = feed('over', 700),
        under = feed('under', 720);
    [3, 4, 8].forEach(d => over.tick(d));
    [2, 5, 6].forEach(d => under.tick(d));
    expect(chooseSignal([over.m, under.m], state, settings, under.now())).toMatchObject({
        symbol: 'R_50',
        direction: 'DIGITUNDER',
    });
    expect(momentumSignal(over.m, state, over.now() + 4000)).toBeUndefined();
});
it('supports the paired recovery policy and validates one-to-five tick durations', () => {
    expect(() => validateSettings(settings)).not.toThrow();
    expect(() => validateSettings({ ...settings, duration: 5 })).not.toThrow();
    expect(() => validateSettings({ ...settings, duration: 6 })).toThrow();
    expect(() => validateSettings({ ...settings, recoveryMode: 'same_contract' })).not.toThrow(); // Legacy sessions can reconcile.
    expect(() => validateSettings({ ...settings, strategy: undefined, recoveryMode: 'same_contract' })).toThrow();
});
it('arms exactly at 70% when the previous sample was below the threshold', () => {
    const f = feed('over', 699);
    f.tick(3);
    expect(f.m.momentum.DIGITOVER).toMatchObject({ percentage: 70, armed: true, run: 0 });
    expect(momentumSignal(f.m, state, f.now())).toBeUndefined();
});
it.each([
    [1, 0, 100, 0, 100],
    [2, 100, 100, 0, 100],
    [3, 100, 100, 0, 100],
    [4, 100, 100, 100, 100],
    [5, 100, 100, 100, 100],
    [6, 100, 100, 100, 0],
    [7, 100, 100, 100, 0],
    [8, 100, 0, 100, 0],
])('counts digit %s in the updated normal and recovery groups', (digit, over1, under8, over3, under6) => {
    const m = new DigitMarket('R_10', 2, 'Volatility Index');
    for (let i = 0; i < 1000; i++) m.add(100 + digit / 100, i + 1);
    expect(m.momentum.DIGITOVER.percentage).toBe(over1);
    expect(m.momentum.DIGITUNDER.percentage).toBe(under8);
    expect(m.recoveryMomentum.DIGITOVER.percentage).toBe(over3);
    expect(m.recoveryMomentum.DIGITUNDER.percentage).toBe(under6);
});
it('does not repeat recovery solely because a losing recovery left a consecutive-loss streak', () => {
    const f = feed();
    [3, 4, 8].forEach(d => f.tick(d));
    expect(momentumSignal(f.m, { ...state, streak: 2, momentumPending: false }, f.now())).toMatchObject({
        barrier: '1',
        recovery: false,
    });
});
