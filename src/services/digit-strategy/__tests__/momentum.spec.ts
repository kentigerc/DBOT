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
        inside = side === 'over' ? 7 : 2;
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

function recoveryFeed(side: 'over' | 'under' = 'over') {
    const f = feed(side, 600);
    for (let i = 0; i < 10; i++) f.tick(side === 'over' ? 7 : 2);
    f.m.resetMomentum();
    const recovery = {
        ...state,
        streak: 1,
        momentumPending: true,
        lockedDirection: side === 'over' ? 'DIGITOVER' as const : 'DIGITUNDER' as const,
        countAfter: f.now(),
    };
    return { ...f, recovery, pattern: side === 'over' ? [5, 9, 4] : [0, 4, 5] };
}
it.each(['over', 'under'] as const)(
    'requires two winning-group digits then an opposite digit for paired %s recovery',
    side => {
        const f = recoveryFeed(side);
        for (const digit of f.pattern.slice(0, 2)) {
            f.tick(digit);
            expect(chooseSignal([f.m], f.recovery, settings, f.now())).toBeUndefined();
        }
        f.tick(f.pattern[2]);
        expect(chooseSignal([f.m], f.recovery, settings, f.now())).toMatchObject({
            direction: f.recovery.lockedDirection,
            barrier: side === 'over' ? '4' : '5',
            recovery: true,
            formation: true,
        });
        // The trigger is a losing-group digit: its instantaneous change may be
        // zero or negative, while the measured ten-second trend still rises.
        expect(f.m.recoveryMomentum[f.recovery.lockedDirection].change).toBeLessThanOrEqual(0);
        expect(f.m.recoveryMomentum[f.recovery.lockedDirection].rate).toBeGreaterThan(0);
        expect(chooseSignal([f.m], { ...f.recovery, countAfter: f.now() - 500 }, settings, f.now())).toBeUndefined();
        expect(chooseSignal([f.m], f.recovery, settings, f.now() + 4000)).toBeUndefined();
        f.tick(f.pattern[2]);
        expect(chooseSignal([f.m], f.recovery, settings, f.now())).toBeUndefined();
    }
);
it('ranks by fastest rising share before checking the pattern, rather than by the largest percentage', () => {
    const slow = recoveryFeed(), fast = recoveryFeed();
    fast.m.symbol = 'R_50';
    slow.pattern.forEach(digit => slow.tick(digit));
    fast.tick(7);
    fast.tick(8);
    slow.m.recoveryMomentum.DIGITOVER = { ...slow.m.recoveryMomentum.DIGITOVER, percentage: 75, rate: 0.02 };
    fast.m.recoveryMomentum.DIGITOVER = { ...fast.m.recoveryMomentum.DIGITOVER, percentage: 60, rate: 0.08 };
    expect(chooseSignal([slow.m, fast.m], slow.recovery, settings, slow.now())).toBeUndefined();
    fast.tick(0);
    fast.m.recoveryMomentum.DIGITOVER.rate = 0.08;
    expect(chooseSignal([slow.m, fast.m], slow.recovery, settings, fast.now())).toMatchObject({ symbol: 'R_50', barrier: '4' });
});
it.each(['over', 'under'] as const)('keeps the purchased %s market and contract locked without another pattern or momentum check', side => {
    const f = recoveryFeed(side), other = recoveryFeed(side);
    other.m.symbol = '1HZ100V';
    other.pattern.forEach(digit => other.tick(digit));
    other.m.recoveryMomentum[other.recovery.lockedDirection].rate = 1;
    const locked = { ...f.recovery, recoveryLocked: true, lockedSymbol: f.m.symbol };
    expect(chooseSignal([f.m, other.m], locked, settings, f.now())).toMatchObject({
        symbol: f.m.symbol, barrier: side === 'over' ? '4' : '5', formation: false,
    });
    expect(chooseSignal([other.m], locked, settings, other.now())).toBeUndefined();
    f.m.resetMomentum();
    Object.assign(f.m.recoveryMomentum[f.recovery.lockedDirection], { percentage: 10, rate: -1 });
    expect(chooseSignal([f.m], locked, settings, f.now())).toMatchObject({ symbol: f.m.symbol, formation: false });
    expect(chooseSignal([f.m], locked, settings, f.now() + 4000)).toBeUndefined();
});
it.each([{ percentage: 51.9 }, { rate: 0 }, { rate: -0.01 }, { armed: false }])(
    'refuses recovery without the percentage floor and a positive live trend: %s', change => {
        const f = recoveryFeed();
        f.pattern.forEach(digit => f.tick(digit));
        Object.assign(f.m.recoveryMomentum.DIGITOVER, change);
        expect(chooseSignal([f.m], f.recovery, settings, f.now())).toBeUndefined();
    }
);
it('does not treat historical or short-lived samples as ten seconds of live momentum', () => {
    const f = feed('over', 600);
    [7, 8, 0].forEach(digit => f.tick(digit));
    expect(f.m.recoveryMomentum.DIGITOVER.rate).toBe(0);
    expect(chooseSignal([f.m], { ...state, streak: 1, lockedDirection: 'DIGITOVER' }, settings, f.now())).toBeUndefined();
    const live = recoveryFeed();
    live.pattern.forEach(digit => live.tick(digit));
    live.tick(7, 7000);
    expect(live.m.recoveryMomentum.DIGITOVER).toMatchObject({ rate: 0, armed: false, run: 0 });
});
it('allows repeated digits within the first group and resets a broken recovery pattern', () => {
    const f = recoveryFeed();
    [7, 0, 0].forEach(digit => f.tick(digit));
    expect(chooseSignal([f.m], f.recovery, settings, f.now())).toBeUndefined();
    [7, 7, 0].forEach(digit => f.tick(digit));
    expect(chooseSignal([f.m], f.recovery, settings, f.now())).toMatchObject({ barrier: '4' });
});

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
    [4, 100, 100, 0, 100],
    [5, 100, 100, 100, 0],
    [6, 100, 100, 100, 0],
    [7, 100, 100, 100, 0],
    [8, 100, 0, 100, 0],
])('counts digit %s in the updated normal and recovery groups', (digit, over1, under8, over4, under5) => {
    const m = new DigitMarket('R_10', 2, 'Volatility Index');
    for (let i = 0; i < 1000; i++) m.add(100 + digit / 100, i + 1);
    expect(m.momentum.DIGITOVER.percentage).toBe(over1);
    expect(m.momentum.DIGITUNDER.percentage).toBe(under8);
    expect(m.recoveryMomentum.DIGITOVER.percentage).toBe(over4);
    expect(m.recoveryMomentum.DIGITUNDER.percentage).toBe(under5);
});
it('does not repeat recovery solely because a losing recovery left a consecutive-loss streak', () => {
    const f = feed();
    [3, 4, 8].forEach(d => f.tick(d));
    expect(momentumSignal(f.m, { ...state, streak: 2, momentumPending: false }, f.now())).toMatchObject({
        barrier: '1',
        recovery: false,
    });
});
