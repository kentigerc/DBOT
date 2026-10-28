import { type Broker, DigitStrategyEngine } from '../engine';
import { DEFAULT_SETTINGS } from '../strategy';
jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
jest.mock('@/external/bot-skeleton', () => ({ api_base: { is_running: false } }));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: () => undefined }));
jest.mock('@/utils/trading-lock', () => ({ setAnalysisTrading: jest.fn() }));
class FakeBroker implements Broker {
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
                    prices: Array.from({ length: 1000 }, (_, i) => 100 + (i % 10) / 100),
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
async function setup(options: Partial<typeof DEFAULT_SETTINGS> = {}, broker = new FakeBroker()) {
    const engine = new DigitStrategyEngine({
        createApi: async () => broker,
        account: () => account,
        builderRunning: () => false,
        now: () => Date.now(),
        random: () => 0,
        storage: localStorage,
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
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1000000);
    localStorage.clear();
});
afterEach(() => jest.useRealTimers());
describe('strategy execution and exposure controls', () => {
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
                await jest.advanceTimersByTimeAsync(1000);
                broker.emit({ tick: { symbol: 'R_100', quote: 100.08, epoch: 1004 + i, pip_size: 2 } });
                await jest.advanceTimersByTimeAsync(150);
            }
        }
        expect(engine.getSnapshot()).toMatchObject({ active: false, streak: 5, losses: 5 });
        expect(broker.buys).toHaveLength(5);
    });
    it('uses a custom multiplier for the next recovery purchase', async () => {
        const { engine, broker } = await setup({ multiplier: 3 });
        broker.settle(-0.35);
        await jest.advanceTimersByTimeAsync(1000);
        broker.emit({ tick: { symbol: 'R_100', quote: 100.08, epoch: 1004, pip_size: 2 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys[1].parameters.amount).toBe(1.05);
        engine.stop();
    });
    it('resets recovery and stake after one recovery win', async () => {
        const { engine, broker } = await setup();
        broker.settle(-0.35);
        await jest.advanceTimersByTimeAsync(1000);
        broker.emit({ tick: { symbol: 'R_100', quote: 100.08, epoch: 1004, pip_size: 2 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys[1].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '5', amount: 0.74 });
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
        expect(restored.getSnapshot().settings.multiplier).toBe(2.1);
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
    const digits = (under ? [...counts].reverse() : counts).flatMap((count, digit) => Array<number>(count).fill(digit));
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
    const tick = async (digit = under ? 7 : 1) => {
        await jest.advanceTimersByTimeAsync(1000);
        broker.emit({ tick: { symbol: 'R_100', quote: 100 + digit / 100, epoch: ++epoch, pip_size: 2 } });
        await jest.advanceTimersByTimeAsync(150);
    };
    await tick();
    await tick(under ? 8 : 2);
    await tick();
    return { broker, engine, tick };
}
describe('HIT AND RUN execution', () => {
    it('finishes a three-win batch and waits for fresh analysis before another entry', async () => {
        const { broker, engine, tick } = await setupCycle();
        expect(broker.buys).toHaveLength(1);
        expect(broker.buys[0].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', duration: 1 });
        broker.settle(0.32);
        await tick();
        expect(broker.buys).toHaveLength(2);
        broker.settle(0.32);
        await tick(2);
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
        await tick(1);
        expect(broker.buys).toHaveLength(4);
        engine.stop();
    });
    it('continues recovery without analysis, then restarts a three-win batch on the same market', async () => {
        const { broker, engine, tick } = await setupCycle({ multiplier: 3 });
        broker.settle(-0.35);
        expect(engine.getSnapshot()).toMatchObject({
            streak: 1,
            stake: 105,
            recovery: { lockedSymbol: 'R_100', lockedDirection: 'DIGITOVER' },
        });
        await tick(5);
        expect(broker.buys).toHaveLength(2);
        expect(broker.buys[1].price).toBe(1.05);
        expect(engine.getSnapshot().pending?.signal.recovery).toBe(true);
        broker.settle(-1.05);
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(3);
        expect(broker.buys[2].price).toBe(3.15);
        broker.settle(2.84);
        expect(engine.getSnapshot()).toMatchObject({ streak: 0, stake: 35, batch: 0, batchPause: 0 });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(4);
        expect(broker.buys[3].price).toBe(0.35);
        expect(broker.buys[3].parameters).toMatchObject({ symbol: 'R_100', contract_type: 'DIGITOVER', barrier: '2' });
        broker.settle(0.32);
        await jest.advanceTimersByTimeAsync(150);
        expect(engine.getSnapshot().batch).toBe(1);
        expect(broker.buys).toHaveLength(5);
        broker.settle(0.32);
        await jest.advanceTimersByTimeAsync(150);
        expect(engine.getSnapshot().batch).toBe(2);
        expect(broker.buys).toHaveLength(6);
        broker.settle(0.32);
        await jest.advanceTimersByTimeAsync(150);
        expect(engine.getSnapshot().batch).toBe(0);
        expect(broker.buys).toHaveLength(6);
        expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
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
    it('does not reapply entry triggers to continuation quotes, but still honors STOP', async () => {
        const { broker, engine, tick } = await setupCycle();
        broker.settle(0.32);
        broker.holdQuote = true;
        await tick(5);
        await tick(6);
        broker.quoteResolve!({ proposal: { ask_price: 0.35, payout: 0.67 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(2);
        broker.settle(0.32);
        await jest.advanceTimersByTimeAsync(150);
        engine.stop();
        broker.quoteResolve!({ proposal: { ask_price: 0.35, payout: 0.67 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(2);
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
it('recovers a loss in a later HIT AND RUN session and then starts a full new three-win batch', async () => {
    const { broker, engine, tick } = await setupCycle();
    for (let i = 0; i < 3; i++) {
        broker.settle(0.32);
        await jest.advanceTimersByTimeAsync(150);
    }
    expect(broker.buys).toHaveLength(3);
    expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
    await jest.advanceTimersByTimeAsync(5000);
    await tick(1);
    expect(broker.buys).toHaveLength(4);
    // Two successful normal trades do not count toward the next batch after a loss.
    for (let i = 0; i < 2; i++) {
        broker.settle(0.32);
        await jest.advanceTimersByTimeAsync(150);
    }
    expect(broker.buys).toHaveLength(6);
    expect(engine.getSnapshot().batch).toBe(2);
    broker.settle(-0.35);
    await jest.advanceTimersByTimeAsync(150);
    expect(broker.buys).toHaveLength(7);
    expect(broker.buys[6].price).toBe(0.74);
    expect(engine.getSnapshot()).toMatchObject({ batch: 0, recovery: { lockedSymbol: 'R_100' } });
    broker.settle(0.67);
    await jest.advanceTimersByTimeAsync(150);
    expect(broker.buys).toHaveLength(8);
    expect(broker.buys[7].price).toBe(0.35);
    expect(engine.getSnapshot()).toMatchObject({ batch: 0, recovery: { lockedSymbol: 'R_100' } });
    for (let i = 0; i < 3; i++) {
        broker.settle(0.32);
        await jest.advanceTimersByTimeAsync(150);
    }
    expect(broker.buys).toHaveLength(10);
    expect(engine.getSnapshot().batch).toBe(0);
    expect(engine.getSnapshot().recovery.lockedSymbol).toBeUndefined();
    engine.stop();
});
describe('HIT AND RUN Analysis Tool recovery policies', () => {
    it('waits for the chosen formation, buys Under 5 recovery, and restores the original Over 2 batch', async () => {
        const { broker, engine, tick } = await setupCycle({
            hitRecovery: 'analysis',
            recoveryMode: 'under5_run',
            triggerCount: 3,
        });
        broker.settle(-0.35);
        expect(engine.getSnapshot().recovery).toMatchObject({ batchMarket: 'R_100', batchDirection: 'DIGITOVER' });
        await tick(5);
        await tick(6);
        expect(broker.buys).toHaveLength(1);
        await tick(7);
        expect(broker.buys).toHaveLength(2);
        expect(broker.buys[1].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '5', amount: 0.74 });
        broker.settle(0.67);
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(3);
        expect(broker.buys[2].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', amount: 0.35 });
        expect(engine.getSnapshot()).toMatchObject({
            batch: 0,
            recovery: { lockedSymbol: 'R_100', lockedDirection: 'DIGITOVER' },
        });
        engine.stop();
    });
    it('retains paired-loss pauses and requires the next fresh recovery formation', async () => {
        const { broker, engine, tick } = await setupCycle({
            hitRecovery: 'analysis',
            recoveryMode: 'under5_pairs',
            triggerCount: 3,
        });
        broker.settle(-0.35);
        await tick(5);
        await tick(6);
        await tick(7);
        expect(broker.buys).toHaveLength(2);
        broker.settle(-0.74);
        await tick(6);
        expect(broker.buys).toHaveLength(3);
        broker.settle(-1.55);
        const state = engine.getSnapshot();
        expect(state.recovery.pauseUntil).toBeGreaterThan(Date.now());
        expect(state.recovery.countAfter).toBe(state.recovery.pauseUntil);
        await jest.advanceTimersByTimeAsync(5000);
        expect(broker.buys).toHaveLength(3);
        await tick(5);
        await tick(6);
        expect(broker.buys).toHaveLength(3);
        await tick(7);
        expect(broker.buys).toHaveLength(4);
        engine.stop();
    });
    it('uses parity recovery and alternates after a recovery loss instead of reusing the normal entry direction', async () => {
        const { broker, engine, tick } = await setupCycle({ hitRecovery: 'analysis', recoveryMode: 'parity' });
        broker.settle(-0.35);
        await tick(5);
        expect(broker.buys).toHaveLength(2);
        const first = broker.buys[1].parameters.contract_type;
        expect(['DIGITEVEN', 'DIGITODD']).toContain(first);
        expect(broker.buys[1].parameters.barrier).toBeUndefined();
        broker.settle(-0.74);
        await tick(6);
        expect(broker.buys).toHaveLength(3);
        expect(broker.buys[2].parameters.contract_type).toBe(first === 'DIGITEVEN' ? 'DIGITODD' : 'DIGITEVEN');
        engine.stop();
    });
});

it('rechecks last-digit Under 5 triggers after every recovery loss', async () => {
    const broker = new FakeBroker();
    const send = broker.send;
    broker.send = jest.fn(async body => {
        if (body.ticks_history) {
            const digits = [180, 70, 100, 100, 100, 90, 90, 90, 90, 90].flatMap((count, digit) =>
                Array<number>(count).fill(digit)
            );
            return {
                pip_size: 2,
                history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => i + 1) },
            };
        }
        return send(body);
    });
    const { engine } = await setup({ recoveryMode: 'under5_filtered_once' }, broker);
    expect(broker.buys).toHaveLength(1);
    broker.settle(-0.35);
    let epoch = 1003;
    const tick = async (digit: number) => {
        await jest.advanceTimersByTimeAsync(1000);
        broker.emit({ tick: { symbol: 'R_100', quote: 100 + digit / 100, epoch: ++epoch, pip_size: 2 } });
        await jest.advanceTimersByTimeAsync(150);
    };
    await tick(2);
    expect(broker.buys).toHaveLength(1);
    await tick(5);
    expect(broker.buys).toHaveLength(2);
    expect(broker.buys[1].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '5', amount: 0.74 });
    broker.settle(-0.74);
    await tick(6);
    expect(broker.buys).toHaveLength(2);
    await tick(9);
    expect(broker.buys).toHaveLength(3);
    expect(broker.buys[2].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '5', amount: 1.55 });
    engine.stop();
});

it('executes percentage recovery immediately at one tick and returns to normal two-tick trades after a win', async () => {
    const broker = new FakeBroker();
    const send = broker.send;
    broker.send = jest.fn(async body => {
        if (body.ticks_history) {
            const digits = [...Array<number>(550).fill(0), ...Array<number>(450).fill(1)];
            return {
                pip_size: 2,
                history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => i + 1) },
            };
        }
        return send(body);
    });
    const { engine } = await setup({ recoveryMode: 'parity_percentage', duration: 2 }, broker);
    expect(broker.buys).toHaveLength(1);
    expect(broker.buys[0].parameters.duration).toBe(2);
    // A fresh tick during the open normal contract; no formation follows the loss.
    await jest.advanceTimersByTimeAsync(1000);
    broker.emit({ tick: { symbol: 'R_100', quote: 100.02, epoch: 1004, pip_size: 2 } });
    broker.settle(-0.35);
    await jest.advanceTimersByTimeAsync(150);
    expect(broker.buys).toHaveLength(2);
    expect(broker.buys[1].parameters).toMatchObject({ contract_type: 'DIGITEVEN', duration: 1, amount: 0.74 });
    expect(broker.buys[1].parameters.barrier).toBeUndefined();
    expect(engine.getSnapshot().pending?.duration).toBe(1);
    broker.settle(0.67);
    expect(engine.getSnapshot()).toMatchObject({ streak: 0, wins: 1, losses: 1, stake: 35 });
    await jest.advanceTimersByTimeAsync(1000);
    broker.emit({ tick: { symbol: 'R_100', quote: 100.03, epoch: 1005, pip_size: 2 } });
    await jest.advanceTimersByTimeAsync(150);
    expect(broker.buys[2].parameters.duration).toBe(2);
    engine.stop();
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

it('uses initial formation then recovers directly on the losing volatility until its deficit clears', async () => {
    const broker = new FakeBroker();
    const send = broker.send;
    broker.send = jest.fn(async body => {
        if (body.ticks_history) {
            const digits = [...Array<number>(600).fill(0), ...Array<number>(400).fill(1)];
            return {
                pip_size: 2,
                history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => i + 1) },
            };
        }
        return send(body);
    });
    const { engine } = await setup(
        { strategy: 'even-odd', recoveryMode: 'parity_percentage', multiplier: 2, duration: 5 },
        broker
    );
    let epoch = 1003;
    const tick = async (digit: number) => {
        await jest.advanceTimersByTimeAsync(1000);
        broker.emit({ tick: { symbol: 'R_100', quote: 100 + digit / 100, epoch: ++epoch, pip_size: 2 } });
        await jest.advanceTimersByTimeAsync(150);
    };
    expect(broker.buys).toHaveLength(0);
    await tick(2);
    await tick(4);
    await tick(1);
    expect(broker.buys[0].parameters).toMatchObject({ contract_type: 'DIGITEVEN', duration: 5, amount: 0.35 });
    broker.settle(-0.35);
    await jest.advanceTimersByTimeAsync(150);
    expect(broker.buys).toHaveLength(1);
    expect(engine.getSnapshot().recovery).toMatchObject({ lockedSymbol: 'R_100', lockedDirection: 'DIGITEVEN' });
    await tick(9); // No new formation is required after the initial loss.
    expect(broker.buys[1].parameters).toMatchObject({ contract_type: 'DIGITEVEN', duration: 5, amount: 0.7 });
    broker.settle(-0.7);
    await tick(9);
    expect(broker.buys[2].parameters).toMatchObject({ contract_type: 'DIGITEVEN', duration: 5, amount: 1.4 });
    broker.settle(0.8);
    expect(engine.getSnapshot().recovery).toMatchObject({
        deficit: 25,
        lockedSymbol: 'R_100',
        lockedDirection: 'DIGITEVEN',
    });
    await tick(9);
    expect(broker.buys[3].parameters).toMatchObject({ contract_type: 'DIGITEVEN', duration: 5, amount: 0.35 });
    broker.settle(0.1);
    expect(engine.getSnapshot()).toMatchObject({
        stake: 35,
        recovery: { deficit: 15, lockedSymbol: 'R_100', lockedDirection: 'DIGITEVEN' },
    });
    await tick(9);
    expect(broker.buys[4].parameters).toMatchObject({ contract_type: 'DIGITEVEN', duration: 5, amount: 0.35 });
    engine.stop();
    broker.settle(0.15);
    expect(engine.getSnapshot()).toMatchObject({ active: false, stake: 35, recovery: { deficit: 0 } });
});

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
