import { type Broker, DigitStrategyEngine, empty, type Snapshot } from '../engine';
import { DEFAULT_SETTINGS, sharedRecoverySettings, type Settings } from '../strategy';
jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
jest.mock('@/external/bot-skeleton', () => ({ api_base: { is_running: false } }));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: () => undefined }));
jest.mock('@/utils/trading-lock', () => ({ setAnalysisTrading: jest.fn() }));
class FakeBroker implements Broker {
    availableBalance = 1000;
    lastEpoch = 1000;
    connection = new EventTarget();
    listeners = new Set<(event: { data: Record<string, any> }) => void>();
    buys: Record<string, any>[] = [];
    quotes: Record<string, any>[] = [];
    contractId = 100;
    latest: Record<string, any> = {};
    holdBuy = false;
    holdQuote = false;
    quoteResolve?: (value: Record<string, any>) => void;
    send = jest.fn(async (body: Record<string, any>): Promise<Record<string, any>> => {
        if (body.balance) return { balance: { balance: this.availableBalance, currency: 'USD' } };
        if (body.active_symbols)
            return {
                active_symbols: [
                    {
                        symbol: 'R_100',
                        display_name: 'Volatility 100 Index',
                        market: 'synthetic_index',
                        exchange_is_open: 1,
                    },
                ],
            };
        if (body.contracts_for)
            return {
                contracts_for: {
                    available: ['DIGITOVER', 'DIGITUNDER', 'DIGITDIFF', 'DIGITEVEN', 'DIGITODD'].map(type => ({
                        contract_type: type,
                        expiry_type: 'tick',
                        min_contract_duration: '1t',
                        max_contract_duration: '10t',
                    })),
                },
            };
        if (body.ticks_history)
            return {
                pip_size: 2,
                history: {
                    prices: [
                        ...Array<number>(40).fill(1),
                        ...Array<number>(560).fill(0),
                        ...Array<number>(400).fill(3),
                    ].map(d => 100 + d / 100),
                    times: Array.from({ length: 1000 }, (_, i) => i + 1),
                },
            };
        if (body.proposal) {
            this.quotes.push(body);
            if (this.holdQuote)
                return new Promise(resolve => {
                    this.quoteResolve = resolve;
                });
            return {
                proposal: { ask_price: body.amount, payout: Math.round(Math.round(body.amount * 100) * 1.9) / 100 },
            };
        }
        if (body.buy) {
            this.buys.push(body);
            if (this.holdBuy) return new Promise(() => {});
            this.latest = {
                contract_id: ++this.contractId,
                underlying: 'R_100',
                contract_type: body.parameters.contract_type,
                barrier: body.parameters.barrier,
                currency: 'USD',
                buy_price: body.price,
                tick_count: body.parameters.duration,
                is_sold: 0,
                payout: Math.round(Math.round(body.price * 100) * 1.9) / 100,
                entry_tick: 100.25,
            };
            return {
                buy: {
                    contract_id: this.contractId,
                    buy_price: body.price,
                    payout: Math.round(Math.round(body.price * 100) * 1.9) / 100,
                },
            };
        }
        if (body.proposal_open_contract) return { proposal_open_contract: this.latest };
        return {};
    });
    onMessage = () => ({
        subscribe: (fn: (event: { data: Record<string, any> }) => void) => {
            this.listeners.add(fn);
            return { unsubscribe: () => this.listeners.delete(fn) };
        },
    });
    disconnect = jest.fn();
    emit(data: Record<string, any>) {
        if (data.tick) this.lastEpoch = data.tick.epoch;
        this.listeners.forEach(fn => fn({ data }));
    }
    settle(profit: number) {
        this.latest = { ...this.latest, is_sold: 1, profit };
        this.emit({ proposal_open_contract: this.latest });
    }
}
const account = {
    account_id: 'DEMO-TEST',
    account_type: 'demo' as const,
    currency: 'USD',
    balance: 1000,
    status: 'active',
};
async function setup(
    options: Partial<typeof DEFAULT_SETTINGS> = {},
    broker = new FakeBroker(),
    Engine = DigitStrategyEngine,
    storage: Storage & { flush?: (key: string) => Promise<void> } = localStorage,
    extra: ConstructorParameters<typeof DigitStrategyEngine>[0] = {}
) {
    const engine = new Engine({
        createApi: async () => broker,
        account: () => account,
        builderRunning: () => false,
        now: () => Date.now(),
        random: () => 0,
        storage,
        ...extra,
    });
    const settings = { ...DEFAULT_SETTINGS, recoveryMode: 'under5_run' as const, takeProfit: 0, ...options };
    const starting = engine.start(settings);
    await jest.advanceTimersByTimeAsync(150);
    await starting;
    for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(1000);
        broker.emit({ tick: { symbol: 'R_100', quote: 100 + (5 + i) / 100, epoch: 1001 + i, pip_size: 2 } });
    }
    await jest.advanceTimersByTimeAsync(150);
    return { engine, broker, settings };
}
async function liveTick(broker: FakeBroker, digit = 8) {
    await jest.advanceTimersByTimeAsync(1000);
    broker.emit({ tick: { symbol: 'R_100', quote: 100 + digit / 100, epoch: broker.lastEpoch + 1, pip_size: 2 } });
    await jest.advanceTimersByTimeAsync(150);
}
async function recoveryEntry(engine: DigitStrategyEngine, broker: FakeBroker) {
    for (let i = 0; i < (engine.getSnapshot().recovery.recoveryLocked ? 1 : 3); i++) await liveTick(broker);
}
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1000000);
    localStorage.clear();
});
afterEach(() => jest.useRealTimers());
it('restores a legacy Momentum parity contract without changing its pending order, stake or journal', () => {
    const pending = {
        nonce: 'old-order',
        contractId: 12345,
        sentAt: 999000,
        stake: 74,
        payout: 141,
        signal: { symbol: 'R_100', direction: 'DIGITEVEN', epoch: 999, recovery: true, formation: false },
    };
    localStorage.setItem(
        'neto.digit-strategy.v1.DEMO-TEST',
        JSON.stringify({
            ...empty(),
            version: 1,
            accountId: account.account_id,
            settings: { ...DEFAULT_SETTINGS, strategy: 'momentum-70', multiplier: 2.1 },
            pending,
            stake: 74,
            pnl: -123,
            recovery: {
                streak: 2,
                deficit: 123,
                momentumPending: true,
                previous: 'DIGITOVER',
                lockedDirection: 'DIGITEVEN',
                lockedSymbol: 'R_100',
                recoveryLocked: true,
                countAfter: 0,
                pauseUntil: 0,
            },
        })
    );
    const createApi = jest.fn();
    const engine = new DigitStrategyEngine({ createApi, storage: localStorage, account: () => account });
    engine.selectAccount(account);
    expect(engine.getSnapshot()).toMatchObject({
        pending,
        stake: 74,
        pnl: -123,
        settings: { strategy: 'momentum-70', recoveryMode: 'same_contract', multiplier: 2.1 },
        recovery: { lockedDirection: 'DIGITOVER', recoveryLocked: false },
    });
    expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
    expect(createApi).not.toHaveBeenCalled();
});
describe('resuming a manually stopped session', () => {
    function restore(strategy?: Settings['strategy'], overrides: Partial<Snapshot> = {}) {
        const saved: Snapshot = {
            ...empty(),
            accountId: account.account_id,
            settings: sharedRecoverySettings({ ...DEFAULT_SETTINGS, strategy }),
            pnl: -11,
            wins: 2,
            losses: 1,
            streak: 1,
            stake: 74,
            batch: 1,
            peak: 24,
            maxDrawdown: 35,
            highestStake: 35,
            recovery: {
                streak: 1,
                countAfter: 0,
                pauseUntil: 0,
                deficit: 35,
                momentumPending: true,
                recoveryLocked: true,
                lockedSymbol: 'R_100',
                lockedDirection: 'DIGITEVEN',
            },
            trades: [12, 12, -35].map((profit, index) => ({
                id: `settled-${index}`,
                contractId: 100 + index,
                market: 'R_100',
                direction: 'DIGITEVEN',
                recovery: false,
                stake: 35,
                payout: profit > 0 ? 47 : 0,
                profit,
                status: profit > 0 ? 'Won' : 'Lost',
                at: 999000 + index,
            })),
            ...overrides,
        };
        localStorage.setItem(`neto.digit-strategy.v1.${account.account_id}`, JSON.stringify({ ...saved, version: 1 }));
        const broker = new FakeBroker();
        const createApi = jest.fn(async () => broker);
        const engine = new DigitStrategyEngine({ createApi, account: () => account, storage: localStorage });
        engine.selectAccount(account);
        return { engine, broker, createApi };
    }
    // PostgreSQL JSONB and stopped-session GET responses reorder object keys.
    const databaseSettings = (settings: Settings): Settings =>
        Object.fromEntries(
            Object.entries(settings).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
        ) as Settings;

    it.each([undefined, 'over2-under7', 'even-odd', 'momentum-70'] as const)(
        'resumes %s without resetting statistics or recovery when the database reorders settings',
        async strategy => {
            const { engine, broker } = restore(strategy);
            await engine.start(engine.getSnapshot().settings);
            expect(engine.getSnapshot().active).toBe(true);
            engine.stop();
            const stopped = engine.getSnapshot();
            expect(stopped.active).toBe(false);
            const settings = databaseSettings(stopped.settings);
            expect(JSON.stringify(settings)).not.toBe(JSON.stringify(stopped.settings));
            try {
                await expect(engine.start(settings)).resolves.toBeUndefined();
                expect(engine.getSnapshot()).toMatchObject({
                    active: true,
                    wantsRun: true,
                    pnl: stopped.pnl,
                    wins: stopped.wins,
                    losses: stopped.losses,
                    streak: stopped.streak,
                    stake: stopped.stake,
                    batch: stopped.batch,
                    peak: stopped.peak,
                    maxDrawdown: stopped.maxDrawdown,
                    highestStake: stopped.highestStake,
                    recovery: stopped.recovery,
                    trades: stopped.trades,
                });
                expect(broker.buys).toHaveLength(0);
            } finally {
                engine.stop();
            }
        }
    );
    it.each([undefined, 'over2-under7', 'even-odd', 'momentum-70'] as const)(
        'applies edited stopped settings to %s without clearing its results',
        async strategy => {
            const { engine, broker } = restore(strategy, { streak: 0, recovery: empty().recovery });
            const before = engine.getSnapshot();
            const settings = {
                ...before.settings,
                stake: 0.5,
                multiplier: 3,
                duration: 2,
                maxStake: 200,
                stopLoss: 200,
                takeProfit: 10,
                maxLosses: 12,
            };
            await engine.start(settings);
            expect(engine.getSnapshot()).toMatchObject({
                settings,
                stake: 50,
                active: true,
                pnl: before.pnl,
                wins: before.wins,
                losses: before.losses,
                trades: before.trades,
                batch: before.batch,
                maxDrawdown: before.maxDrawdown,
            });
            expect(broker.buys).toHaveLength(0);
            engine.stop();
        }
    );
    it.each([undefined, 'over2-under7', 'even-odd', 'momentum-70'] as const)(
        'uses a new multiplier for the held %s recovery without erasing its deficit',
        async strategy => {
            const { engine } = restore(strategy);
            const before = engine.getSnapshot();
            await engine.start({ ...before.settings, multiplier: 3, stake: 0.5, duration: 2 });
            expect(engine.getSnapshot()).toMatchObject({
                stake: 105,
                settings: { multiplier: 3, stake: 0.5, duration: 2 },
                pnl: before.pnl,
                streak: before.streak,
                recovery: before.recovery,
                trades: before.trades,
            });
            engine.stop();
        }
    );
    it('blocks changed settings while a real order still requires reconciliation', async () => {
        const { engine, createApi } = restore(undefined, {
            pending: {
                nonce: 'pending',
                contractId: 123,
                signal: { symbol: 'R_100', direction: 'DIGITEVEN', epoch: 1000, recovery: true, formation: false },
                stake: 74,
                payout: 140,
                sentAt: 999000,
            },
        });
        await expect(engine.start({ ...engine.getSnapshot().settings, multiplier: 3 })).rejects.toThrow(
            'pending contract before changing settings'
        );
        expect(createApi).not.toHaveBeenCalled();
        expect(engine.getSnapshot().pending?.contractId).toBe(123);
    });
    it('checks the recalculated recovery stake against the newly selected limits before connecting', async () => {
        const { engine, createApi } = restore();
        const before = engine.getSnapshot();
        await expect(engine.start({ ...before.settings, multiplier: 3, maxStake: 1 })).rejects.toThrow(
            'Maximum stake reached'
        );
        expect(createApi).not.toHaveBeenCalled();
        expect(engine.getSnapshot()).toMatchObject({ active: false, stake: before.stake, trades: before.trades });
    });
    it('does not treat a missing strategy field as permission to switch tools', async () => {
        const { engine, createApi } = restore('even-odd');
        const { strategy: _strategy, ...settings } = engine.getSnapshot().settings;
        await expect(engine.start(settings)).rejects.toThrow('Reset the stopped session before switching strategies');
        expect(createApi).not.toHaveBeenCalled();
    });
    it.each([
        [{ pnl: 500 }, 'Take-profit reached'],
        [{ streak: 10 }, 'Consecutive-loss limit reached'],
        [{ pnl: -9950 }, 'Stop-loss'],
        [{ stake: 10001 }, 'Maximum stake reached'],
    ] as [Partial<Snapshot>, string][])(
        'preserves a reached session risk limit on restart: %j',
        async (state, reason) => {
            const { engine, createApi } = restore(undefined, state);
            await expect(engine.start(databaseSettings(engine.getSnapshot().settings))).rejects.toThrow(reason);
            expect(engine.getSnapshot().active).toBe(false);
            expect(createApi).not.toHaveBeenCalled();
        }
    );
    it('settles the open trade after STOP before resuming its recovery and journal', async () => {
        const { engine, broker } = await setup();
        expect(broker.buys).toHaveLength(1);
        engine.stop();
        expect(engine.getSnapshot()).toMatchObject({ active: true, wantsRun: false });
        await engine.start(engine.getSnapshot().settings);
        expect(broker.buys).toHaveLength(1);
        expect(engine.getSnapshot().wantsRun).toBe(false);
        broker.settle(-0.35);
        const stopped = engine.getSnapshot();
        expect(stopped).toMatchObject({ active: false, pending: undefined, losses: 1, pnl: -35, stake: 74 });
        try {
            await expect(engine.start(databaseSettings(stopped.settings))).resolves.toBeUndefined();
            expect(engine.getSnapshot()).toMatchObject({
                active: true,
                losses: 1,
                pnl: -35,
                stake: 74,
                recovery: stopped.recovery,
                trades: stopped.trades,
            });
            expect(broker.buys).toHaveLength(1);
        } finally {
            engine.stop();
        }
    });
});
describe('strategy execution and exposure controls', () => {
    it.each([0, 0.34])(
        'does not start trading when live balance is %s, even with a stale funded account snapshot',
        async available => {
            const broker = new FakeBroker();
            broker.availableBalance = available;
            const { engine } = await setup({}, broker);
            expect(engine.getSnapshot().active).toBe(false);
            expect(engine.getSnapshot().phase).toMatch(/Insufficient balance/);
            expect(broker.buys).toHaveLength(0);
        }
    );
    it('allows a stake exactly equal to the available balance', async () => {
        const broker = new FakeBroker();
        broker.availableBalance = 0.35;
        const { engine } = await setup({}, broker);
        expect(broker.buys).toHaveLength(1);
        engine.stop();
    });
    it('stops before an unaffordable recovery instead of repeating rejected buys', async () => {
        const { engine, broker } = await setup();
        broker.availableBalance = 0.5;
        broker.settle(-0.35);
        await recoveryEntry(engine, broker);
        expect(engine.getSnapshot()).toMatchObject({ active: false, pending: undefined, losses: 1 });
        expect(engine.getSnapshot().phase).toMatch(/Insufficient balance.*required USD 0.74/);
        expect(broker.buys).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(20000);
        expect(broker.buys).toHaveLength(1);
    });
    it('rechecks balance after a quote instead of relying on the startup balance', async () => {
        const broker = new FakeBroker();
        const send = broker.send;
        broker.send = jest.fn(async body => {
            const response = await send(body);
            if (body.proposal) broker.availableBalance = 0.1;
            return response;
        });
        const { engine } = await setup({}, broker);
        expect(engine.getSnapshot().active).toBe(false);
        expect(engine.getSnapshot().phase).toMatch(/Insufficient balance/);
        expect(broker.buys).toHaveLength(0);
    });
    it('stops if Deriv rejects a buy after funds changed during the balance-to-buy interval', async () => {
        const broker = new FakeBroker();
        const send = broker.send;
        broker.send = jest.fn(async body => {
            if (body.buy) throw { error: { code: 'InsufficientBalance', message: 'Insufficient funds' } };
            return send(body);
        });
        const { engine } = await setup({}, broker);
        expect(engine.getSnapshot()).toMatchObject({ active: false, pending: undefined });
        expect(engine.getSnapshot().phase).toMatch(/Insufficient balance/);
        await jest.advanceTimersByTimeAsync(20000);
        expect(broker.send.mock.calls.filter(([body]) => body.buy)).toHaveLength(1);
    });
    it('allows only one open purchase and settles before placing another', async () => {
        const { engine, broker } = await setup();
        expect(broker.buys).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(2000);
        expect(broker.buys).toHaveLength(1);
        engine.stop();
        broker.settle(0.32);
        expect(engine.getSnapshot()).toMatchObject({ active: false, pnl: 32, wins: 1, pending: undefined });
        await jest.advanceTimersByTimeAsync(2000);
        expect(broker.buys).toHaveLength(1);
    });
    it('stops before the recovery stake exceeds the per-trade cap', async () => {
        const { engine, broker } = await setup({ maxStake: 0.5 });
        broker.settle(-0.35);
        expect(engine.getSnapshot().phase).toMatch(/Maximum stake/);
        expect(engine.getSnapshot().active).toBe(false);
        expect(engine.getSnapshot().stake).toBe(74);
        expect(broker.buys).toHaveLength(1);
    });
    it('reserves worst-case loss before the next trade', async () => {
        const { engine, broker } = await setup({ stopLoss: 0.5 });
        broker.settle(-0.35);
        expect(engine.getSnapshot().phase).toMatch(/Stop-loss/);
        expect(broker.buys).toHaveLength(1);
    });
    it('stops exactly at the consecutive-loss limit', async () => {
        const { engine, broker } = await setup({ maxLosses: 1 });
        broker.settle(-0.35);
        expect(engine.getSnapshot()).toMatchObject({ active: false, streak: 1, pnl: -35 });
        expect(engine.getSnapshot().phase).toMatch(/Consecutive/);
    });
    it('continues recovery at x2.1 and stops after five consecutive losses', async () => {
        const { engine, broker } = await setup({ maxLosses: 5 });
        const stakes = [35, 74, 155, 326, 685];
        for (let i = 0; i < 5; i++) {
            expect(broker.buys).toHaveLength(i + 1);
            expect(Math.round(broker.buys[i].price * 100)).toBe(stakes[i]);
            broker.settle(-stakes[i] / 100);
            if (i < 4) {
                await recoveryEntry(engine, broker);
            }
        }
        expect(engine.getSnapshot()).toMatchObject({ active: false, streak: 5, losses: 5 });
        expect(broker.buys).toHaveLength(5);
    });
    it('uses a custom multiplier for the next recovery purchase', async () => {
        const { engine, broker } = await setup({ multiplier: 3 });
        broker.settle(-0.35);
        await recoveryEntry(engine, broker);
        expect(broker.buys[1].parameters.amount).toBe(1.05);
        engine.stop();
    });
    it('resets recovery and stake after one recovery win', async () => {
        const { engine, broker } = await setup();
        broker.settle(-0.35);
        await recoveryEntry(engine, broker);
        expect(broker.buys[1].parameters).toMatchObject({ contract_type: 'DIGITEVEN', amount: 0.74 });
        broker.settle(0.67);
        expect(engine.getSnapshot()).toMatchObject({ pnl: 32, streak: 0, stake: 35 });
        expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
        engine.stop();
    });
    it('does not buy after STOP is pressed while a quote is in flight', async () => {
        const b = new FakeBroker();
        b.holdQuote = true;
        const { engine, broker } = await setup({}, b);
        expect(broker.quotes.length).toBeGreaterThan(0);
        engine.stop();
        b.quoteResolve?.({ proposal: { ask_price: 0.35, payout: 0.67 } });
        await jest.advanceTimersByTimeAsync(10);
        expect(broker.buys).toHaveLength(0);
        expect(engine.getSnapshot().active).toBe(false);
    });
    it.each(['quote', 'balance'])(
        'finishes STOP during a stalled %s and ignores its late reply after a restart',
        async phase => {
            const broker = new FakeBroker();
            broker.holdQuote = phase === 'quote';
            let lateBalance!: (value: Record<string, any>) => void;
            let balances = 0;
            const send = broker.send;
            broker.send = jest.fn(body => {
                if (body.balance && ++balances === 2 && phase === 'balance')
                    return new Promise(resolve => {
                        lateBalance = resolve;
                    });
                return send(body);
            });
            const { engine } = await setup({}, broker);
            const lateReply = phase === 'quote' ? broker.quoteResolve! : lateBalance;
            expect(lateReply).toBeDefined();
            engine.stop();
            await jest.advanceTimersByTimeAsync(1);
            expect(engine.getSnapshot()).toMatchObject({ active: false, wantsRun: false });
            expect(engine.getSnapshot().pending).toBeUndefined();
            expect(broker.buys).toHaveLength(0);
            broker.holdQuote = false;
            try {
                await engine.start(engine.getSnapshot().settings);
                lateReply(
                    phase === 'quote'
                        ? { proposal: { ask_price: 0.35, payout: 0.67 } }
                        : { balance: { balance: 1000, currency: 'USD' } }
                );
                await jest.advanceTimersByTimeAsync(1);
                expect(engine.getSnapshot()).toMatchObject({ active: true, wantsRun: true });
                expect(engine.getSnapshot().pending).toBeUndefined();
                expect(broker.buys).toHaveLength(0);
            } finally {
                engine.stop();
            }
        }
    );
    it.each(
        ['balance', 'active_symbols', 'contracts_for', 'ticks_history'].flatMap(stage =>
            ['success', 'failure'].map(outcome => ({ stage, outcome }))
        )
    )('ignores a cancelled startup’s late $stage $outcome after restarting', async ({ stage, outcome }) => {
        const broker = new FakeBroker();
        const send = broker.send;
        let completeOldRequest!: () => void;
        let holdFirst = true;
        broker.send = jest.fn(body => {
            if (body[stage] && holdFirst) {
                holdFirst = false;
                return new Promise((resolve, reject) => {
                    completeOldRequest = () =>
                        outcome === 'failure' ? reject(new Error('Old connection closed')) : resolve(send(body));
                });
            }
            return send(body);
        });
        const engine = new DigitStrategyEngine({ createApi: async () => broker, account: () => account });
        const starting = engine.start(DEFAULT_SETTINGS);
        await jest.advanceTimersByTimeAsync(1);
        expect(completeOldRequest).toBeDefined();
        engine.stop();
        expect(engine.getSnapshot().active).toBe(false);
        try {
            await engine.start(DEFAULT_SETTINGS);
            const resumed = engine.getSnapshot();
            completeOldRequest();
            await starting;
            expect(engine.getSnapshot()).toBe(resumed);
            expect(engine.getSnapshot()).toMatchObject({ active: true, wantsRun: true, error: '' });
            expect(broker.buys).toHaveLength(0);
        } finally {
            engine.stop();
        }
    });
    it('keeps the current broker when an older cancelled connection opens late', async () => {
        const oldBroker = new FakeBroker(),
            broker = new FakeBroker();
        let connectOld!: (value: Broker) => void;
        const createApi = jest
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise(resolve => {
                        connectOld = resolve;
                    })
            )
            .mockResolvedValue(broker);
        const engine = new DigitStrategyEngine({ createApi, account: () => account, random: () => 0 });
        const starting = engine.start(DEFAULT_SETTINGS);
        await jest.advanceTimersByTimeAsync(1);
        engine.stop();
        await engine.start(DEFAULT_SETTINGS);
        try {
            connectOld(oldBroker);
            await starting;
            expect(oldBroker.disconnect).toHaveBeenCalled();
            for (let i = 0; i < 3; i++) await liveTick(broker, 8);
            expect(broker.buys).toHaveLength(1);
            expect(oldBroker.buys).toHaveLength(0);
        } finally {
            engine.stop();
            broker.settle(0.32);
            oldBroker.settle(0.32);
        }
    });
    it('never retries an unacknowledged buy, and preserves the uncertain intent', async () => {
        const b = new FakeBroker();
        b.holdBuy = true;
        const { engine, broker, settings } = await setup({}, b);
        await jest.advanceTimersByTimeAsync(12001);
        expect(broker.buys).toHaveLength(1);
        expect(engine.getSnapshot()).toMatchObject({ active: false, phase: 'Reconciliation required' });
        expect(engine.getSnapshot().pending?.contractId).toBeUndefined();
        expect(JSON.parse(localStorage.getItem('neto.digit-strategy.v1.DEMO-TEST')!).pending).toBeTruthy();
        await expect(engine.start(settings)).rejects.toThrow(/unconfirmed/);
    });
    it('ignores duplicate settlements and restores a known open contract without a duplicate buy', async () => {
        const { engine, broker, settings } = await setup({ maxLosses: 1 });
        broker.connection.dispatchEvent(new Event('close'));
        expect(engine.getSnapshot().pending?.contractId).toBe(101);
        const saved = JSON.parse(localStorage.getItem('neto.digit-strategy.v1.DEMO-TEST')!);
        delete saved.settings.multiplier;
        saved.settings.recoveryMode = 'under5_pairs';
        saved.settings.triggerCount = 7;
        localStorage.setItem('neto.digit-strategy.v1.DEMO-TEST', JSON.stringify(saved));
        const next = new FakeBroker();
        next.latest = { ...broker.latest, is_sold: 1, profit: -0.35 };
        const restored = new DigitStrategyEngine({
            createApi: async () => next,
            account: () => account,
            builderRunning: () => false,
            storage: localStorage,
        });
        await restored.start(settings);
        expect(next.buys).toHaveLength(0);
        expect(restored.getSnapshot().settings).toMatchObject({
            multiplier: 2.1,
            recoveryMode: 'parity_percentage',
            triggerCount: 3,
        });
        expect(restored.getSnapshot()).toMatchObject({ pnl: -35, losses: 1, active: false, pending: undefined });
        next.emit({ proposal_open_contract: next.latest });
        expect(restored.getSnapshot().pnl).toBe(-35);
    });
    it('rejects a mismatched contract before updating financial totals', async () => {
        const { engine, broker } = await setup();
        broker.emit({ proposal_open_contract: { ...broker.latest, underlying: 'R_50', is_sold: 1, profit: 100 } });
        expect(engine.getSnapshot().pnl).toBe(0);
        expect(engine.getSnapshot().error).toMatch(/match/);
        expect(engine.getSnapshot().pending).toBeTruthy();
    });
    it('requires a USD account and prevents concurrent Builder trading', async () => {
        const blocked = new DigitStrategyEngine({ account: () => account, builderRunning: () => true });
        await expect(blocked.start(DEFAULT_SETTINGS)).rejects.toThrow(/Builder/);
        const nonUsd = new DigitStrategyEngine({
            account: () => ({ ...account, currency: 'EUR' }),
            builderRunning: () => false,
        });
        await expect(nonUsd.start(DEFAULT_SETTINGS)).rejects.toThrow(/USD/);
    });
});

async function setupCycle(options: Partial<typeof DEFAULT_SETTINGS> = {}, under = false, holdInitialQuote = false) {
    const broker = new FakeBroker();
    broker.holdQuote = holdInitialQuote;
    const send = broker.send;
    const counts = [90, 90, 90, 80, 100, 100, 110, 110, 110, 120];
    const digits = counts.flatMap((count, digit) => Array<number>(count).fill(under ? 9 - digit : digit));
    broker.send = jest.fn(async body =>
        body.ticks_history
            ? { pip_size: 2, history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => i + 1) } }
            : send(body)
    );
    const engine = new DigitStrategyEngine({
        createApi: async () => broker,
        account: () => account,
        builderRunning: () => false,
        now: () => Date.now(),
        storage: localStorage,
    });
    const settings = { ...DEFAULT_SETTINGS, strategy: 'over2-under7' as const, takeProfit: 0, ...options };
    const starting = engine.start(settings);
    await jest.advanceTimersByTimeAsync(150);
    await starting;
    let epoch = 1000;
    const tick = async (digit = under ? 4 : 5) => {
        await jest.advanceTimersByTimeAsync(1000);
        broker.emit({ tick: { symbol: 'R_100', quote: 100 + digit / 100, epoch: ++epoch, pip_size: 2 } });
        await jest.advanceTimersByTimeAsync(150);
    };
    for (let i = 0; i < 5; i++) await tick();
    const entry = async () => {
        for (let i = 0; i < 3; i++) await tick();
    };
    return { broker, engine, tick, entry };
}
describe('HIT AND RUN execution', () => {
    it('finishes a three-win batch and waits for fresh analysis before another entry', async () => {
        const { broker, engine, tick, entry } = await setupCycle();
        expect(broker.buys).toHaveLength(1);
        expect(broker.buys[0].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', duration: 1 });
        broker.settle(0.32);
        await entry();
        expect(broker.buys).toHaveLength(2);
        broker.settle(0.32);
        await entry();
        expect(broker.buys).toHaveLength(3);
        broker.settle(0.32);
        expect(engine.getSnapshot()).toMatchObject({
            active: true,
            batch: 0,
            batchPause: expect.any(Number),
            recovery: { pauseUntil: expect.any(Number) },
        });
        expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
        await jest.advanceTimersByTimeAsync(5000);
        expect(broker.buys).toHaveLength(3);
        await tick(5);
        expect(broker.buys).toHaveLength(3);
        await entry();
        expect(broker.buys).toHaveLength(4);
        engine.stop();
    });
    it('halts at a risk limit instead of attempting recovery', async () => {
        const { broker, engine, tick } = await setupCycle({ maxLosses: 1 });
        broker.settle(-0.35);
        expect(engine.getSnapshot().active).toBe(false);
        expect(engine.getSnapshot().phase).toMatch(/Consecutive-loss/);
        await tick(2);
        expect(broker.buys).toHaveLength(1);
    });
    it('still validates the initial triggering digit while quoting', async () => {
        const { broker, engine, tick } = await setupCycle({}, false, true);
        expect(broker.buys).toHaveLength(0);
        await tick(5);
        broker.quoteResolve!({ proposal: { ask_price: 0.35, payout: 0.67 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(0);
        engine.stop();
    });
    it('revalidates normal continuation quotes and honors STOP before a wire purchase', async () => {
        const { broker, engine, tick, entry } = await setupCycle();
        broker.settle(0.32);
        broker.holdQuote = true;
        await entry();
        await tick(1); // Entry invalidated while the quote was in flight.
        broker.quoteResolve!({ proposal: { ask_price: 0.35, payout: 0.67 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(1);
        await entry();
        engine.stop();
        broker.quoteResolve!({ proposal: { ask_price: 0.35, payout: 0.67 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(1);
    });
});

it('executes Under 7 with the same HIT AND RUN safeguards', async () => {
    const { broker, engine } = await setupCycle({}, true);
    expect(broker.buys).toHaveLength(1);
    expect(broker.buys[0].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '7', duration: 1 });
    engine.stop();
    broker.settle(0.32);
    expect(engine.getSnapshot().active).toBe(false);
});
it('excludes markets that do not offer one-tick Even/Odd recovery contracts', async () => {
    const broker = new FakeBroker();
    const send = broker.send;
    broker.send = jest.fn(async body => {
        const response = await send(body);
        if (body.contracts_for) {
            response.contracts_for.available = response.contracts_for.available.map(
                (contract: Record<string, unknown>) => ({
                    ...contract,
                    min_contract_duration: ['DIGITEVEN', 'DIGITODD'].includes(String(contract.contract_type))
                        ? '2t'
                        : '1t',
                })
            );
        }
        return response;
    });
    const { engine } = await setup({ recoveryMode: 'parity_percentage' }, broker);
    expect(engine.getSnapshot().active).toBe(false);
    expect(engine.getSnapshot().error).toMatch(/No supported/);
    expect(broker.buys).toHaveLength(0);
});

it.each([
    {
        direction: 'DIGITEVEN',
        winner: 8,
        loser: 1,
        entryDigits: [2, 4, 1],
        recoveryDigits: [2, 4, 8],
        drift: 9,
        duration: 2,
    },
    {
        direction: 'DIGITODD',
        winner: 9,
        loser: 2,
        entryDigits: [1, 3, 2],
        recoveryDigits: [1, 5, 9],
        drift: 0,
        duration: 5,
    },
])(
    'recovers a parity loss with $direction until its first win, then resumes normal parity entries',
    async ({ direction, winner, loser, entryDigits, recoveryDigits, drift, duration }) => {
        const broker = new FakeBroker();
        const send = broker.send;
        broker.send = jest.fn(async body => {
            if (body.ticks_history) {
                const digits = [...Array<number>(460).fill(loser), ...Array<number>(540).fill(winner)];
                return {
                    pip_size: 2,
                    history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => i + 1) },
                };
            }
            return send(body);
        });
        const { engine } = await setup(
            { strategy: 'even-odd', recoveryMode: 'parity_percentage', multiplier: 2.1, duration },
            broker
        );
        let epoch = 1003;
        const tick = async (digit: number) => {
            await jest.advanceTimersByTimeAsync(1000);
            broker.emit({ tick: { symbol: 'R_100', quote: 100 + digit / 100, epoch: ++epoch, pip_size: 2 } });
            await jest.advanceTimersByTimeAsync(150);
        };
        for (const digit of entryDigits) await tick(digit);
        expect(broker.buys[0].parameters).toMatchObject({ contract_type: direction, duration, amount: 0.35 });
        broker.settle(-0.35);
        expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
        expect(engine.getSnapshot().recovery.recoveryLocked).not.toBe(true);
        expect(broker.buys).toHaveLength(1);
        for (const digit of entryDigits) await tick(digit);
        expect(broker.buys).toHaveLength(1); // Normal entry patterns do not trigger recovery.
        await tick(recoveryDigits[0]);
        await tick(recoveryDigits[1]);
        expect(broker.buys).toHaveLength(1);
        await tick(recoveryDigits[2]);
        expect(broker.buys[1].parameters).toMatchObject({
            contract_type: direction,
            duration,
            amount: 0.74,
        });
        expect(broker.buys[1].parameters.barrier).toBeUndefined();
        expect(engine.getSnapshot().recovery).toMatchObject({
            lockedSymbol: 'R_100',
            lockedDirection: direction,
            recoveryLocked: true,
        });
        broker.settle(-0.74);
        await tick(drift);
        expect(broker.buys[2].parameters).toMatchObject({
            contract_type: direction,
            duration,
            amount: 1.55,
        });
        broker.settle(0.1); // A first recovery win ends this episode even when it does not repay every loss.
        expect(engine.getSnapshot()).toMatchObject({
            stake: 35,
            batch: 0,
            recovery: { momentumPending: false, deficit: 0 },
        });
        expect(engine.getSnapshot().pnl).toBe(-99);
        expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
        expect(engine.getSnapshot().recovery.recoveryLocked).not.toBe(true);
        expect(broker.buys).toHaveLength(3);
        for (const digit of entryDigits) await tick(digit);
        expect(broker.buys[3].parameters).toMatchObject({ contract_type: direction, duration, amount: 0.35 });
        engine.stop();
    }
);

it('initializes other market feeds while an earlier contract-capability request is still pending', async () => {
    const broker = new FakeBroker(),
        send = broker.send;
    const info = await send({ contracts_for: 'R_100' });
    let release!: () => void;
    broker.send = jest.fn(async body => {
        if (body.active_symbols)
            return {
                active_symbols: ['R_100', 'R_50', '1HZ50V'].map(symbol => ({
                    symbol,
                    display_name: `Volatility ${symbol}`,
                    market: 'synthetic_index',
                    exchange_is_open: 1,
                })),
            };
        if (body.contracts_for === 'R_100')
            return new Promise(resolve => {
                release = () => resolve(info);
            });
        return send(body);
    });
    const engine = new DigitStrategyEngine({
        createApi: async () => broker,
        account: () => account,
        builderRunning: () => false,
        now: () => Date.now(),
        storage: localStorage,
    });
    const starting = engine.start(DEFAULT_SETTINGS);
    await jest.advanceTimersByTimeAsync(0);
    expect(broker.send.mock.calls.some(([body]) => body.ticks_history === 'R_50')).toBe(true);
    expect(broker.send.mock.calls.some(([body]) => body.ticks_history === '1HZ50V')).toBe(true);
    expect(broker.send.mock.calls.some(([body]) => body.ticks_history === 'R_100')).toBe(false);
    engine.stop();
    release();
    await starting;
    expect(engine.getSnapshot().active).toBe(false);
    expect(broker.buys).toHaveLength(0);
});

it.each([1, 2, 3, 4, 5].flatMap(duration => (['over', 'under'] as const).map(side => [side, duration] as const)))(
    'uses paired %s Momentum recovery at %s ticks with a 2.5 multiplier',
    async (side, duration) => {
        const direction = side === 'over' ? 'DIGITOVER' : 'DIGITUNDER';
        const winner = side === 'over' ? 7 : 2;
        const broker = new FakeBroker(),
            send = broker.send;
        broker.send = jest.fn(async body => {
            if (body.ticks_history) {
                const digits = [
                    ...Array<number>(300).fill(side === 'over' ? 0 : 9),
                    ...Array<number>(700).fill(winner),
                ];
                return {
                    pip_size: 2,
                    history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => i + 1) },
                };
            }
            return send(body);
        });
        const { engine } = await setup(
            { strategy: 'momentum-70', recoveryMode: 'same_contract', multiplier: 2.5, duration },
            broker,
            jest.requireActual('../../../../.server-build/engine.js').DigitStrategyEngine
        );
        let epoch = 1003;
        const tick = async (digit: number) => {
            await jest.advanceTimersByTimeAsync(1000);
            broker.emit({ tick: { symbol: 'R_100', quote: 100 + digit / 100, epoch: ++epoch, pip_size: 2 } });
            await jest.advanceTimersByTimeAsync(150);
        };
        await tick(winner);
        await tick(4);
        expect(broker.buys[0].parameters).toMatchObject({
            contract_type: direction,
            barrier: side === 'over' ? '1' : '8',
            amount: 0.35,
            duration,
        });
        broker.settle(-0.35);
        await tick(winner);
        await tick(4);
        await tick(winner);
        expect(broker.buys[1].parameters).toMatchObject({
            contract_type: direction,
            barrier: side === 'over' ? '3' : '6',
            amount: 0.88,
            duration,
        });
        broker.settle(-0.88);
        expect(engine.getSnapshot()).toMatchObject({
            stake: 220,
            streak: 2,
            recovery: {
                momentumPending: true,
                recoveryLocked: true,
                lockedSymbol: 'R_100',
                lockedDirection: direction,
            },
        });
        await tick(side === 'over' ? 1 : 7);
        expect(broker.buys[2].parameters).toMatchObject({
            symbol: 'R_100',
            contract_type: direction,
            barrier: side === 'over' ? '3' : '6',
            amount: 2.2,
            duration,
        });
        broker.settle(0.2);
        expect(engine.getSnapshot()).toMatchObject({ stake: 35, recovery: { momentumPending: false } });
        await tick(winner);
        await tick(4);
        await tick(7);
        expect(broker.buys[3].parameters).toMatchObject({
            contract_type: direction,
            barrier: side === 'over' ? '1' : '8',
            amount: 0.35,
            duration,
        });
        engine.stop();
        broker.settle(0.06);
    }
);

it.each([
    [undefined, false],
    [undefined, true],
    ['over2-under7', false],
    ['over2-under7', true],
] as const)(
    'uses shared parity recovery for %s (Odd=%s), locks after confirmation and ends on the first win',
    async (strategy, odd) => {
        const broker = new FakeBroker();
        const send = broker.send;
        broker.send = jest.fn(async body => {
            if (body.ticks_history) {
                const digits = [
                    ...Array<number>(200).fill(1),
                    ...Array<number>(560).fill(4),
                    ...Array<number>(240).fill(5),
                ].map(d => (odd ? 9 - d : d));
                return {
                    pip_size: 2,
                    history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => i + 1) },
                };
            }
            return send(body);
        });
        const { engine } = await setup({ strategy, recoveryMode: 'under5_run', duration: 2 }, broker);
        for (let i = 0; i < 3 && !broker.buys.length; i++) await liveTick(broker, odd ? 5 : 4);
        expect(broker.buys).toHaveLength(1);
        expect(broker.buys[0].parameters.duration).toBe(2);
        expect(engine.getSnapshot().settings.recoveryMode).toBe('parity_percentage');
        broker.settle(-0.35);
        expect(engine.getSnapshot().recovery.recoveryLocked).not.toBe(true);
        for (let i = 0; i < 2; i++) await liveTick(broker, odd ? 3 : 2);
        expect(broker.buys).toHaveLength(1);
        broker.holdQuote = true;
        await liveTick(broker, odd ? 5 : 4);
        expect(engine.getSnapshot().recovery.recoveryLocked).not.toBe(true);
        broker.holdQuote = false;
        broker.quoteResolve!({ proposal: { ask_price: 0.74, payout: 1.41 } });
        await jest.advanceTimersByTimeAsync(150);
        const direction = odd ? 'DIGITODD' : 'DIGITEVEN';
        expect(broker.buys[1].parameters).toMatchObject({ contract_type: direction, amount: 0.74, duration: 2 });
        expect(broker.buys[1].parameters.barrier).toBeUndefined();
        expect(engine.getSnapshot().recovery).toMatchObject({
            lockedSymbol: 'R_100',
            lockedDirection: direction,
            recoveryLocked: true,
        });
        broker.settle(-0.74);
        await liveTick(broker, odd ? 2 : 1); // Deliberately opposite parity; direct continuation must stay locked.
        expect(broker.buys[2].parameters).toMatchObject({ contract_type: direction, amount: 1.55, duration: 2 });
        broker.settle(0); // Voids preserve the lock and stake.
        await liveTick(broker, odd ? 2 : 1);
        expect(broker.buys[3].price).toBe(1.55);
        broker.settle(0.1);
        expect(engine.getSnapshot()).toMatchObject({
            stake: 35,
            batch: 0,
            pnl: -99,
            recovery: { momentumPending: false, deficit: 0 },
        });
        expect(engine.getSnapshot().recovery.recoveryLocked).not.toBe(true);
        expect(broker.buys).toHaveLength(4);
        for (let i = 0; i < 3; i++) await liveTick(broker, odd ? 5 : 4);
        expect(broker.buys).toHaveLength(5);
        expect(engine.getSnapshot().pending?.signal.recovery).toBe(false);
        expect(broker.buys[4].price).toBe(0.35);
        engine.stop();
    }
);

function checkpointStorage(flush: (key: string) => Promise<void>): Storage & { flush: typeof flush } {
    return {
        getItem: key => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
        removeItem: key => localStorage.removeItem(key),
        clear: () => localStorage.clear(),
        key: index => localStorage.key(index),
        get length() {
            return localStorage.length;
        },
        flush,
    };
}
describe('durable purchase checkpoints', () => {
    it('does not send a purchase until its saved intent is acknowledged', async () => {
        let release!: () => void;
        let held = false;
        const storage = checkpointStorage(key => {
            const pending = JSON.parse(localStorage.getItem(key) || '{}').pending;
            if (pending && !held) {
                held = true;
                return new Promise(resolve => {
                    release = resolve;
                });
            }
            return Promise.resolve();
        });
        const { engine, broker } = await setup({}, new FakeBroker(), DigitStrategyEngine, storage);
        expect(engine.getSnapshot().pending?.nonce).toBeTruthy();
        expect(broker.buys).toHaveLength(0);
        release();
        await jest.advanceTimersByTimeAsync(1);
        expect(broker.buys).toHaveLength(1);
        engine.stop();
    });
    it('halts without sending or retrying a buy when the durable intent cannot be committed', async () => {
        const storage = checkpointStorage(async key => {
            if (JSON.parse(localStorage.getItem(key) || '{}').pending) throw new Error('Database unavailable');
        });
        const { engine, broker } = await setup({}, new FakeBroker(), DigitStrategyEngine, storage);
        expect(broker.buys).toHaveLength(0);
        expect(engine.getSnapshot().active).toBe(false);
        expect(engine.getSnapshot().phase).toMatch(/save purchase intent.*No order was sent/);
        await jest.advanceTimersByTimeAsync(20000);
        expect(broker.buys).toHaveLength(0);
    });
    it('honors STOP while the purchase checkpoint is in flight', async () => {
        let release!: () => void;
        let held = false;
        const storage = checkpointStorage(key => {
            if (JSON.parse(localStorage.getItem(key) || '{}').pending && !held) {
                held = true;
                return new Promise(resolve => {
                    release = resolve;
                });
            }
            return Promise.resolve();
        });
        const { engine, broker } = await setup({}, new FakeBroker(), DigitStrategyEngine, storage);
        engine.stop();
        release();
        await jest.advanceTimersByTimeAsync(1);
        expect(broker.buys).toHaveLength(0);
        expect(engine.getSnapshot()).toMatchObject({ active: false, pending: undefined, wantsRun: false });
        expect(JSON.parse(localStorage.getItem('neto.digit-strategy.v1.DEMO-TEST')!).pending).toBeUndefined();
    });
    it('rechecks the live signal after a delayed database commit', async () => {
        let release!: () => void;
        let held = false;
        const storage = checkpointStorage(key => {
            if (JSON.parse(localStorage.getItem(key) || '{}').pending && !held) {
                held = true;
                return new Promise(resolve => {
                    release = resolve;
                });
            }
            return Promise.resolve();
        });
        const { engine, broker } = await setup({}, new FakeBroker(), DigitStrategyEngine, storage);
        broker.emit({ tick: { symbol: 'R_100', quote: 100, epoch: broker.lastEpoch + 1, pip_size: 2 } });
        release();
        await jest.advanceTimersByTimeAsync(1);
        expect(broker.buys).toHaveLength(0);
        expect(engine.getSnapshot().pending).toBeUndefined();
        engine.stop();
    });
});

it('stops without an uncertain intent or another attempt when account protection rejects an unsent buy', async () => {
    const broker = new FakeBroker();
    const send = broker.send;
    broker.send = jest.fn(async body => {
        if (body.buy) throw { code: 'NetoPurchaseCancelled' };
        return send(body);
    });
    const { engine } = await setup({}, broker);
    expect(engine.getSnapshot()).toMatchObject({ active: false, wantsRun: false, pending: undefined });
    expect(engine.getSnapshot().phase).toMatch(/Account protection stopped/);
    await jest.advanceTimersByTimeAsync(20000);
    expect(broker.buys).toHaveLength(0);
});

describe('real recovery demo pauses', () => {
    async function recovering(strategy: Settings['strategy'], demo: jest.Mock, real = true, maxLosses = 10) {
        const settings = sharedRecoverySettings({
            ...DEFAULT_SETTINGS,
            strategy,
            multiplier: 2.5,
            duration: 2,
            takeProfit: 0,
            maxLosses,
        });
        const direction = strategy === 'momentum-70' ? 'DIGITOVER' : 'DIGITEVEN';
        localStorage.setItem(
            'neto.digit-strategy.v1.DEMO-TEST',
            JSON.stringify({
                ...empty(),
                accountId: account.account_id,
                version: 1,
                settings,
                stake: 88,
                streak: 1,
                pnl: -35,
                losses: 1,
                trades: [
                    {
                        id: 'normal-loss',
                        contractId: 99,
                        market: 'R_100',
                        direction: 'DIGITOVER',
                        recovery: false,
                        stake: 35,
                        profit: -35,
                        status: 'Lost',
                        at: Date.now(),
                    },
                ],
                recovery: {
                    streak: 1,
                    deficit: 35,
                    momentumPending: true,
                    previous: 'DIGITOVER',
                    lockedDirection: direction,
                    lockedSymbol: 'R_100',
                    recoveryLocked: true,
                    countAfter: 0,
                    pauseUntil: 0,
                },
            })
        );
        return setup(settings, new FakeBroker(), DigitStrategyEngine, localStorage, {
            account: () => ({ ...account, account_type: real ? 'real' : 'demo' }),
            runDemoPause: demo,
        });
    }
    async function twoLosses(engine: DigitStrategyEngine, broker: FakeBroker) {
        expect(broker.buys[0].price).toBe(0.88);
        broker.settle(-0.88);
        await liveTick(broker);
        expect(broker.buys[1].price).toBe(2.2);
        broker.settle(-2.2);
        expect(engine.getSnapshot()).toMatchObject({ pnl: -343, streak: 3, losses: 3, recoveryLosses: 2, stake: 550 });
    }
    it.each([undefined, 'over2-under7', 'even-odd', 'momentum-70'] as const)(
        'pauses the third real recovery for %s and retains its real ledger through demo losses until a win',
        async strategy => {
            let finish!: (value: any) => void;
            const pause = jest.fn(
                (_spec: any, _options: any) =>
                    new Promise(resolve => {
                        finish = resolve;
                    })
            );
            const { engine, broker } = await recovering(strategy, pause);
            await twoLosses(engine, broker);
            expect(pause).not.toHaveBeenCalled();
            await liveTick(broker);
            expect(pause).toHaveBeenCalledTimes(1);
            expect(broker.buys).toHaveLength(2);
            const [spec, options] = pause.mock.calls[0];
            expect(spec).toMatchObject({ stake: 0.35, duration: 2, symbol: 'R_100', triggerContractId: 102 });
            const progress = {
                triggerContractId: 102,
                demoAccountId: 'DEMO2',
                status: 'running',
                completed: 1,
                trades: [{ contractId: 201, profit: -35, stake: 35, at: Date.now() }],
            };
            options.progress(progress);
            expect(engine.getSnapshot()).toMatchObject({
                pnl: -343,
                streak: 3,
                losses: 3,
                stake: 550,
                demoPause: { completed: 1, heldStake: 550 },
            });
            expect(broker.buys).toHaveLength(2);
            options.progress({ ...progress, completed: 2, wins: 0 });
            expect(broker.buys).toHaveLength(2);
            finish({ ...progress, status: 'done', completed: 3, wins: 1 });
            await jest.advanceTimersByTimeAsync(150);
            expect(broker.buys).toHaveLength(3);
            expect(broker.buys[2].price).toBe(5.5);
            expect(engine.getSnapshot()).toMatchObject({
                pnl: -343,
                streak: 3,
                losses: 3,
                recoveryLosses: 0,
                stake: 550,
            });
            engine.stop();
            broker.settle(0.2);
        }
    );
    it('does not apply the demo pause to a strategy already running on demo', async () => {
        const pause = jest.fn();
        const { engine, broker } = await recovering('even-odd', pause, false);
        await twoLosses(engine, broker);
        await liveTick(broker);
        expect(pause).not.toHaveBeenCalled();
        expect(broker.buys).toHaveLength(3);
        engine.stop();
        broker.settle(0.2);
    });
    it('keeps the existing total real-loss limit ahead of the demo pause', async () => {
        const pause = jest.fn();
        const { engine, broker } = await recovering('even-odd', pause, true, 3);
        await twoLosses(engine, broker);
        await liveTick(broker);
        expect(pause).not.toHaveBeenCalled();
        expect(broker.buys).toHaveLength(2);
        expect(engine.getSnapshot().active).toBe(false);
    });
    it('cannot resume real trades after STOP even if the demo command returns late', async () => {
        let finish!: (value: any) => void;
        const pause = jest.fn(
            (_spec: any, _options: any) =>
                new Promise(resolve => {
                    finish = resolve;
                })
        );
        const { engine, broker } = await recovering('even-odd', pause);
        await twoLosses(engine, broker);
        await liveTick(broker);
        engine.stop();
        finish({ triggerContractId: 102, completed: 1, wins: 1, status: 'done' });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(2);
        expect(engine.getSnapshot().active).toBe(false);
    });
    it('halts real recovery if demo access fails instead of skipping the pause', async () => {
        const pause = jest.fn().mockRejectedValue(new Error('Demo account unavailable'));
        const { engine, broker } = await recovering('even-odd', pause);
        await twoLosses(engine, broker);
        await liveTick(broker);
        expect(broker.buys).toHaveLength(2);
        expect(engine.getSnapshot()).toMatchObject({ active: false, error: 'Demo account unavailable', stake: 550 });
    });
    it.each([undefined, 0])('cannot resume on two completed demo losses without a confirmed win (%s)', async wins => {
        const pause = jest.fn().mockResolvedValue({ triggerContractId: 102, completed: 2, wins, status: 'done' });
        const { engine, broker } = await recovering('even-odd', pause);
        await twoLosses(engine, broker);
        await liveTick(broker);
        expect(broker.buys).toHaveLength(2);
        expect(engine.getSnapshot()).toMatchObject({ active: false, stake: 550, pnl: -343 });
    });
    it.each([undefined, { triggerContractId: 99, completed: 1, wins: 1, status: 'done' }])(
        'enforces the lowered threshold for a saved session without a current demo trigger (%j)',
        async demoPause => {
            const original = await recovering('even-odd', jest.fn());
            await twoLosses(original.engine, original.broker);
            original.engine.stop();
            await jest.advanceTimersByTimeAsync(150);
            const key = 'neto.digit-strategy.v1.DEMO-TEST';
            const saved = JSON.parse(localStorage.getItem(key)!);
            saved.demoPause = demoPause;
            localStorage.setItem(key, JSON.stringify(saved));
            let finish!: (value: unknown) => void;
            const pause = jest.fn(
                (_spec: any, _options: any) =>
                    new Promise<any>(resolve => {
                        finish = resolve;
                    })
            );
            const { engine, broker } = await setup(
                saved.settings,
                new FakeBroker(),
                DigitStrategyEngine,
                localStorage,
                {
                    account: () => ({ ...account, account_type: 'real' }),
                    runDemoPause: pause,
                }
            );
            expect(pause).toHaveBeenCalledWith(expect.objectContaining({ triggerContractId: 102 }), expect.anything());
            expect(broker.buys).toHaveLength(0);
            engine.stop();
            finish({ triggerContractId: 102, completed: 1, wins: 1, status: 'done' });
            await jest.advanceTimersByTimeAsync(150);
        }
    );
});
