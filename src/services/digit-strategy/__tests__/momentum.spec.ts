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
    const recovery = {
        ...state,
        streak: 1,
        lockedSymbol: 'R_10',
        lockedDirection: 'DIGITOVER' as const,
        recoveryLocked: true,
    };
    expect(chooseSignal([over.m, under.m], recovery, settings, over.now())).toMatchObject({
        symbol: 'R_10',
        direction: 'DIGITOVER',
        barrier: '4',
        recovery: true,
    });
    expect(momentumSignal(over.m, recovery, over.now() + 4000)).toBeUndefined();
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
it.each(['over', 'under'] as const)('waits for a rising 52%% %s recovery share and two fresh winning digits', side => {
    let now = 1700000000000;
    const m = new DigitMarket('R_25', 2, 'Volatility 25 Index');
    const outside = side === 'over' ? 0 : 9,
        inside = side === 'over' ? 8 : 2;
    const digits = [...Array<number>(480).fill(outside), ...Array<number>(520).fill(inside)];
    digits.forEach((digit, i) => m.add(100 + digit / 100, now / 1000 - 1000 + i));
    const tick = (digit: number) => {
        now += 1000;
        m.add(100 + digit / 100, now / 1000, now);
    };
    for (let i = 0; i < 3; i++) tick(outside);
    const recovering = {
        ...state,
        streak: 1,
        deficit: 35,
        lockedDirection: side === 'over' ? ('DIGITOVER' as const) : ('DIGITUNDER' as const),
    };
    tick(inside);
    tick(inside);
    expect(momentumSignal(m, recovering, now)).toBeUndefined();
    tick(side === 'over' ? 6 : 4);
    expect(momentumSignal(m, recovering, now)).toMatchObject({
        barrier: side === 'over' ? '4' : '5',
        recovery: true,
        formation: true,
    });
    const locked = { ...recovering, recoveryLocked: true, lockedSymbol: 'R_25' };
    m.recoveryMomentum.DIGITOVER.percentage = 20;
    m.recoveryMomentum.DIGITUNDER.percentage = 20;
    m.resetMomentum();
    expect(momentumSignal(m, locked, now)).toMatchObject({
        barrier: side === 'over' ? '4' : '5',
        recovery: true,
        formation: false,
    });
    const other = new DigitMarket('R_50', 2, 'Another market');
    expect(momentumSignal(other, locked, now)).toBeUndefined();
});
it('selects a recovery market across the watchlist once, then ignores stronger alternatives until recovery ends', () => {
    const now = 1700000000000;
    const market = (symbol: string, percentage: number) => {
        const m = new DigitMarket(symbol, 2, symbol);
        m.digits = Array(1000).fill(8);
        m.liveTicks = 3;
        m.received = now;
        m.arrivals = Array(1000).fill(now);
        m.epochs = Array(1000).fill(now / 1000);
        m.recoveryMomentum.DIGITOVER = { percentage, change: 0.1, run: 2, armed: true, epoch: now / 1000 };
        return m;
    };
    const first = market('R_10', 56),
        second = market('R_50', 60);
    const recovering = { ...state, streak: 1, deficit: 35, lockedDirection: 'DIGITOVER' as const };
    expect(
        chooseSignal([first, second], { ...recovering, lockedSymbol: 'R_10', recoveryLocked: false }, settings, now)
    ).toMatchObject({
        symbol: 'R_50',
        barrier: '4',
        recovery: true,
    });
    first.recoveryMomentum.DIGITOVER.percentage = 95;
    second.resetMomentum();
    second.recoveryMomentum.DIGITOVER.percentage = 20;
    expect(
        chooseSignal([first, second], { ...recovering, lockedSymbol: 'R_50', recoveryLocked: true }, settings, now)
    ).toMatchObject({ symbol: 'R_50', barrier: '4', formation: false, recovery: true });
});

it('accepts exactly 52% for a formed rising recovery entry and rejects a value below it', () => {
    const f = feed();
    const recovering = { ...state, deficit: 35, lockedDirection: 'DIGITOVER' as const };
    f.m.recoveryMomentum.DIGITOVER = { percentage: 52, change: 0.1, armed: true, run: 2, epoch: f.now() / 1000 };
    expect(momentumSignal(f.m, recovering, f.now())).toMatchObject({ barrier: '4', recovery: true });
    f.m.recoveryMomentum.DIGITOVER.percentage = 51.9;
    expect(momentumSignal(f.m, recovering, f.now())).toBeUndefined();
});
