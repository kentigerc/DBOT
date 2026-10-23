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

async function setupCycle(options: Partial<typeof DEFAULT_SETTINGS> = {}, under = false) {
    const broker = new FakeBroker();
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
    it('places at most three sequence trades, pauses, and requires a fresh entry after reanalysis', async () => {
        const { broker, engine, tick } = await setupCycle();
        expect(broker.buys).toHaveLength(1);
        expect(broker.buys[0].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '2', duration: 2 });
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
            recovery: { countAfter: expect.any(Number) },
        });
        await jest.advanceTimersByTimeAsync(5000);
        expect(broker.buys).toHaveLength(3);
        await tick();
        expect(broker.buys).toHaveLength(4);
        engine.stop();
    });
    it('waits for a qualifying recovery entry, multiplies stake and ends the sequence after recovery wins', async () => {
        const { broker, engine, tick } = await setupCycle({ multiplier: 3 });
        broker.settle(-0.35);
        expect(engine.getSnapshot()).toMatchObject({
            streak: 1,
            stake: 105,
            recovery: { lockedSymbol: 'R_100', lockedDirection: 'DIGITOVER' },
        });
        await tick(5);
        expect(broker.buys).toHaveLength(1);
        await tick(2);
        expect(broker.buys).toHaveLength(2);
        expect(broker.buys[1].price).toBe(1.05);
        expect(engine.getSnapshot().pending?.signal.recovery).toBe(true);
        broker.settle(0.95);
        expect(engine.getSnapshot()).toMatchObject({ streak: 0, stake: 35, batch: 0 });
        await tick();
        expect(broker.buys).toHaveLength(2);
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
    it('does not buy when the triggering digit changes while quoting', async () => {
        const { broker, engine, tick } = await setupCycle();
        broker.settle(0.32);
        broker.holdQuote = true;
        await tick(2);
        await tick(5);
        broker.quoteResolve!({ proposal: { ask_price: 0.35, payout: 0.67 } });
        await jest.advanceTimersByTimeAsync(150);
        expect(broker.buys).toHaveLength(1);
        engine.stop();
    });
});

it('executes Under 7 with the same HIT AND RUN safeguards', async () => {
    const { broker, engine } = await setupCycle({}, true);
    expect(broker.buys).toHaveLength(1);
    expect(broker.buys[0].parameters).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '7', duration: 2 });
    engine.stop();
    broker.settle(0.32);
    expect(engine.getSnapshot().active).toBe(false);
});
