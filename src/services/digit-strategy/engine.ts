import { type DerivAccount } from '@/utils/deriv-session';
import {
    cents,
    chooseSignal,
    cycleSignal,
    DEFAULT_SETTINGS,
    DigitMarket,
    type Direction,
    isPaired,
    nextRecoveryStake,
    recoverySignal,
    type RecoveryState,
    riskReason,
    type Settings,
    type Signal,
    validateSettings,
} from './strategy';

type Packet = Record<string, any>; // Deriv's compatibility transport supplies legacy and modern fields.
export type Broker = {
    send: (body: Packet) => Promise<Packet>;
    onMessage: () => { subscribe: (fn: (event: { data: Packet }) => void) => { unsubscribe: () => void } };
    connection: EventTarget;
    disconnect: () => void;
};
export type Trade = {
    id: string;
    contractId?: number;
    market: string;
    direction: Direction;
    barrier?: string;
    recovery: boolean;
    stake: number;
    payout: number;
    status: string;
    profit?: number;
    entry?: string;
    exit?: string;
    at: number;
};
type Pending = {
    duration?: number;
    nonce: string;
    signal: Signal;
    stake: number;
    payout: number;
    sentAt: number;
    contractId?: number;
};
export type MarketView = {
    symbol: string;
    name: string;
    price: string;
    latest: number | undefined;
    count: number;
    liveTicks: number;
    ready: boolean;
    highRun: number;
    digits: ReturnType<DigitMarket['frequencies']>;
    status: string;
};
export type Snapshot = {
    accountId: string;
    settings: Settings;
    phase: string;
    active: boolean;
    wantsRun: boolean;
    error: string;
    pnl: number;
    streak: number;
    stake: number;
    wins: number;
    losses: number;
    voids: number;
    maxDrawdown: number;
    peak: number;
    highestStake: number;
    recovery: RecoveryState;
    recoveryLosses: number;
    batch: number;
    batchPause: number;
    pending?: Pending;
    trades: Trade[];
    logs: { at: number; message: string; level: string }[];
    markets: MarketView[];
    selected?: Signal;
    quote?: { stake: number; payout: number; breakEven: number };
    liveUntil: number;
    owner: string;
};
export const empty = (): Snapshot => ({
    accountId: '',
    settings: { ...DEFAULT_SETTINGS },
    phase: 'Ready',
    active: false,
    wantsRun: false,
    error: '',
    pnl: 0,
    streak: 0,
    stake: 35,
    wins: 0,
    losses: 0,
    voids: 0,
    peak: 0,
    maxDrawdown: 0,
    highestStake: 0,
    recovery: { streak: 0, countAfter: 0, pauseUntil: 0 },
    recoveryLosses: 0,
    batch: 0,
    batchPause: 0,
    trades: [],
    logs: [],
    markets: [],
    liveUntil: 0,
    owner: '',
});
const definitive = new Set([
    'PriceMoved',
    'InvalidContractProposal',
    'InvalidContractId',
    'InvalidAmount',
    'InputValidationFailed',
    'InsufficientBalance',
    'AuthorizationRequired',
    'InvalidToken',
    'PermissionDenied',
    'RateLimit',
    'TooManyRequests',
    'MarketIsClosed',
    'TradingSuspended',
    'ContractProposalExpired',
]);
export class DigitStrategyEngine {
    private state = empty();
    private listeners = new Set<() => void>();
    private api?: Broker;
    private subscription?: { unsubscribe: () => void };
    private timer?: ReturnType<typeof setInterval>;
    private markets = new Map<string, DigitMarket>();
    private queues = new Map<string, Packet[]>();
    private attempts = new Map<string, number>();
    private disabled = new Map<string, number>();
    private initialized = false;
    private busy = false;
    private closing = false;
    private generation = 0;
    private reportAt = 0;
    private watching?: number;
    private readonly owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    constructor(
        private deps: {
            createApi?: () => Promise<Broker>;
            account?: () => DerivAccount | undefined;
            builderRunning?: () => boolean;
            now?: () => number;
            random?: () => number;
            storage?: Storage;
            lockChanged?: (locked: boolean) => void;
        } = {}
    ) {}
    getSnapshot = () => this.state;
    subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    };
    private now() {
        return this.deps.now?.() ?? Date.now();
    }
    private storage() {
        return this.deps.storage ?? localStorage;
    }
    private account() {
        return this.deps.account?.();
    }
    private key(account = this.state.accountId) {
        return `neto.digit-strategy.v1.${account}`;
    }
    private update(change: Partial<Snapshot>) {
        this.state = { ...this.state, ...change };
        this.listeners.forEach(fn => fn());
    }
    private log(message: string, level = 'info') {
        this.update({ logs: [...this.state.logs, { at: this.now(), message, level }].slice(-200) });
    }
    private persist() {
        const saved = { ...this.state, markets: undefined };
        this.storage().setItem(this.key(), JSON.stringify({ ...saved, version: 1, owner: this.owner }));
    }
    selectAccount(account?: DerivAccount) {
        if (this.state.active || this.state.pending || this.state.accountId === account?.account_id) return;
        let saved: Partial<Snapshot> = {};
        if (account) {
            const text = this.storage().getItem(this.key(account.account_id));
            if (text) {
                try {
                    const data = JSON.parse(text);
                    if (data.version === 1 && data.accountId === account.account_id) {
                        data.settings = { ...DEFAULT_SETTINGS, ...data.settings };
                        validateSettings(data.settings);
                        saved = data;
                    }
                } catch {
                    throw new Error(
                        'Saved strategy session is unreadable. Do not run until the session has been checked.'
                    );
                }
            }
        }
        this.update({
            ...empty(),
            ...saved,
            accountId: account?.account_id || '',
            active: false,
            wantsRun: false,
            markets: [],
            phase: saved.pending ? 'Resume pending contract' : 'Ready',
        });
        this.deps.lockChanged?.(!!this.state.pending);
    }
    reset() {
        if (this.state.active || this.state.pending)
            throw new Error('Stop and settle the current contract before resetting.');
        const { accountId, settings } = this.state;
        this.update({ ...empty(), accountId, settings, stake: cents(settings.stake) });
        if (accountId) this.persist();
    }
    async start(settings: Settings, reconcileId?: number) {
        if (this.state.active) return;
        validateSettings(settings);
        const account = this.account();
        if (!account || account.status !== 'active')
            throw new Error('Log in with Deriv and select an active account first.');
        if (account.currency !== 'USD') throw new Error('This uploaded strategy uses USD. Select a USD account.');
        if (this.deps.builderRunning?.() ?? false)
            throw new Error('Stop the Bot Builder bot before running Analysis Tool.');
        this.selectAccount(account);
        if (this.state.accountId !== account.account_id) throw new Error('Resolve the previous account session first.');
        if (this.state.liveUntil > this.now() && this.state.owner && this.state.owner !== this.owner)
            throw new Error('Another trading tab is active. Stop it before continuing here.');
        if (
            (this.state.trades.length || this.state.pending) &&
            JSON.stringify(this.state.settings) !== JSON.stringify(settings)
        )
            throw new Error('Reset the stopped session before changing parameters. Pending contracts cannot be reset.');
        if (this.state.pending && !this.state.pending.contractId && !reconcileId)
            throw new Error(
                'Purchase outcome is unconfirmed. Enter its contract ID from Deriv history to reconcile; no new orders will be sent.'
            );
        const reason =
            !this.state.pending &&
            riskReason(
                settings,
                this.state.pnl,
                this.state.streak,
                this.state.trades.length ? this.state.stake : cents(settings.stake)
            );
        if (reason) throw new Error(`${reason}. Reset the stopped session to start a new one.`);
        const generation = ++this.generation;
        this.closing = false;
        this.initialized = false;
        this.busy = false;
        this.watching = undefined;
        this.markets.clear();
        this.queues.clear();
        this.attempts.clear();
        this.disabled.clear();
        this.update({
            settings: { ...settings },
            active: true,
            wantsRun: !reconcileId,
            error: '',
            phase: 'Connecting',
            stake: this.state.trades.length ? this.state.stake : cents(settings.stake),
            owner: this.owner,
            liveUntil: this.now() + 15000,
        });
        this.deps.lockChanged?.(true);
        try {
            this.persist();
            if (!this.deps.createApi) throw new Error('Trading connection is unavailable.');
            const api: Broker = await this.deps.createApi();
            this.api = api;
            if (generation !== this.generation || !this.state.active) {
                api.disconnect();
                return;
            }
            api.connection.addEventListener('close', () => {
                if (!this.closing && generation === this.generation)
                    this.halt('Connection lost. Resume to reconcile before any further trades.');
            });
            api.connection.addEventListener('error', () => {
                if (!this.closing && generation === this.generation)
                    this.halt('Trading connection failed. No purchase will be retried.');
            });
            this.subscription = api.onMessage().subscribe(({ data }) => this.onPacket(data));
            this.timer = setInterval(() => this.pulse(), 125);
            if (reconcileId && this.state.pending) {
                const pending = this.state.pending;
                const response = await this.request({ proposal_open_contract: 1, contract_id: reconcileId });
                this.validateContract(response.proposal_open_contract, pending, reconcileId);
                if (!pending.contractId)
                    this.acknowledge({
                        contract_id: reconcileId,
                        buy_price: response.proposal_open_contract.buy_price,
                        payout: response.proposal_open_contract.payout,
                    });
                else {
                    this.update({ pending: { ...pending, contractId: reconcileId } });
                    this.persist();
                }
                await this.watch(reconcileId);
                return;
            }
            if (this.state.pending?.contractId) await this.watch(this.state.pending.contractId);
            if (!this.state.active || !this.state.wantsRun) return;
            this.update({ phase: 'Discovering markets' });
            this.log('Connecting live Volatility feeds and verifying the selected digit contracts.');
            const active = await this.request({ active_symbols: 'brief' });
            const symbols = (active.active_symbols || []).filter(
                (m: Packet) =>
                    m.market === 'synthetic_index' &&
                    /Volatility/.test(m.display_name || '') &&
                    m.exchange_is_open === 1 &&
                    !m.is_trading_suspended
            );
            let cursor = 0;
            const initialize = async () => {
                while (cursor < symbols.length) {
                    const row = symbols[cursor++];
                    if (!this.state.active || !this.state.wantsRun || generation !== this.generation) break;
                    try {
                        const info = await this.request({ contracts_for: row.symbol });
                        if (generation !== this.generation || !this.state.active || !this.state.wantsRun) return;
                        const available = info.contracts_for?.available || [];
                        const required = [
                            ...(settings.strategy === 'even-odd' ? [] : ['DIGITOVER', 'DIGITUNDER']),
                            ...(settings.strategy === undefined ? ['DIGITDIFF'] : []),
                            ...(settings.recoveryMode.startsWith('parity') ? ['DIGITEVEN', 'DIGITODD'] : []),
                        ];
                        if (
                            !required.every(type =>
                                available.some((r: Packet) => {
                                    const lo = /^(\d+)(t?)$/.exec(String(r.min_contract_duration)),
                                        hi = /^(\d+)(t?)$/.exec(String(r.max_contract_duration));
                                    return (
                                        r.contract_type === type &&
                                        r.expiry_type === 'tick' &&
                                        lo &&
                                        hi &&
                                        +lo[1] <=
                                            (settings.strategy !== 'even-odd' &&
                                            settings.recoveryMode === 'parity_percentage' &&
                                            ['DIGITEVEN', 'DIGITODD'].includes(type)
                                                ? 1
                                                : settings.duration) &&
                                        +hi[1] >=
                                            (settings.strategy !== 'even-odd' &&
                                            settings.recoveryMode === 'parity_percentage' &&
                                            ['DIGITEVEN', 'DIGITODD'].includes(type)
                                                ? 1
                                                : settings.duration)
                                    );
                                })
                            )
                        )
                            continue;
                        this.queues.set(row.symbol, []);
                        const h = await this.request({
                            ticks_history: row.symbol,
                            count: 1000,
                            end: 'latest',
                            style: 'ticks',
                            subscribe: 1,
                        });
                        if (generation !== this.generation || !this.state.active || !this.state.wantsRun) return;
                        const m = new DigitMarket(row.symbol, h.pip_size, row.display_name);
                        if (!Array.isArray(h.history?.prices) || h.history.prices.length !== h.history.times?.length)
                            throw new Error('Invalid history.');
                        h.history.prices.forEach((price: number, i: number) => m.add(price, h.history.times[i]));
                        this.markets.set(row.symbol, m);
                        (this.queues.get(row.symbol) || []).forEach(tick => m.add(tick.quote, tick.epoch, this.now()));
                        this.queues.delete(row.symbol);
                        this.log(`${row.display_name}: ${m.digits.length} ticks loaded.`);
                    } catch {
                        this.queues.delete(row.symbol);
                        this.log(`${row.display_name}: unavailable, excluded.`, 'warn');
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, initialize));
            if (!this.state.wantsRun || !this.state.active) {
                if (!this.state.pending) this.finish('Stopped');
                return;
            }
            if (!this.markets.size) throw new Error('No supported digit markets were available.');
            this.initialized = true;
            this.update({ phase: 'Waiting for live ticks' });
            this.log(`${this.markets.size} markets ready. Entry and recovery rules are active.`);
        } catch (error) {
            this.halt(error instanceof Error ? error.message : 'Trading could not start.');
        }
    }
    private async request(body: Packet) {
        if (!this.api) throw new Error('No trading connection.');
        let timer: ReturnType<typeof setTimeout>;
        try {
            return await Promise.race([
                this.api.send(body),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Request timed out.')), 12000);
                }),
            ]);
        } finally {
            clearTimeout(timer!);
        }
    }
    private onPacket(data: Packet) {
        try {
            if (data.tick) {
                const t = data.tick,
                    symbol = t.symbol || t.underlying_symbol;
                if (this.queues.has(symbol)) this.queues.get(symbol)!.push(t);
                else this.markets.get(symbol)?.add(t.quote, t.epoch, this.now());
            }
            if (
                data.buy &&
                this.state.pending &&
                data.echo_req?.passthrough?.neto_order_id === this.state.pending.nonce &&
                !this.state.pending.contractId
            ) {
                this.acknowledge(data.buy);
                void this.watch(data.buy.contract_id).catch(() =>
                    this.halt('Unable to reconcile the purchased contract. Resume to check settlement.')
                );
            }
            if (
                data.proposal_open_contract &&
                this.state.pending?.contractId === data.proposal_open_contract.contract_id
            )
                this.contract(data.proposal_open_contract);
        } catch (error) {
            this.halt(error instanceof Error ? error.message : 'Invalid trading data.');
        }
    }
    private pulse() {
        if (this.now() - this.reportAt >= 1000) {
            this.reportAt = this.now();
            const markets = [...this.markets.values()].map(m => ({
                symbol: m.symbol,
                name: m.name,
                price: m.prices[m.prices.length - 1] || '',
                latest: m.digits[m.digits.length - 1],
                count: m.digits.length,
                liveTicks: m.liveTicks,
                ready: m.ready(this.now()),
                highRun:
                    [...m.digits].reverse().findIndex(d => d < 5) < 0
                        ? m.digits.length
                        : [...m.digits].reverse().findIndex(d => d < 5),
                digits: m.frequencies(),
                status: m.ready(this.now()) ? 'Live' : m.liveTicks < 3 ? 'Warming up' : 'Stale / refilling',
            }));
            this.update({ markets, liveUntil: this.state.active ? this.now() + 15000 : 0 });
            try {
                this.persist();
            } catch {
                this.halt('Session storage failed. Trading stopped.');
                return;
            }
        }
        if (!this.initialized || !this.state.active || !this.state.wantsRun || this.busy || this.state.pending) return;
        if (this.now() < this.state.batchPause || this.now() < this.state.recovery.pauseUntil) {
            this.update({ phase: 'Preparing next trading cycle' });
            return;
        }
        const reason = riskReason(this.state.settings, this.state.pnl, this.state.streak, this.state.stake);
        if (reason) {
            this.finish(reason);
            return;
        }
        const signal = chooseSignal(
            [...this.markets.values()].filter(m => (this.disabled.get(m.symbol) || 0) <= this.now()),
            this.state.recovery,
            this.state.settings,
            this.now(),
            this.deps.random
        );
        if (
            !signal ||
            (!(
                this.state.settings.strategy === 'over2-under7' &&
                this.state.recovery.lockedSymbol &&
                !(this.state.settings.hitRecovery === 'analysis' && this.state.streak)
            ) &&
                this.attempts.get(signal.symbol) === signal.epoch)
        ) {
            this.update({
                phase:
                    this.state.settings.strategy === 'over2-under7' &&
                    this.state.recovery.lockedSymbol &&
                    !(this.state.settings.hitRecovery === 'analysis' && this.state.streak)
                        ? 'Waiting for fresh data on selected market'
                        : this.state.streak ||
                            (this.state.settings.strategy === 'even-odd' && (this.state.recovery.deficit || 0) > 0)
                          ? this.state.settings.recoveryMode === 'parity_percentage'
                              ? 'Scanning recovery opportunities'
                              : 'Scanning recovery opportunities'
                          : 'Waiting for eligible digit entry',
            });
            return;
        }
        this.attempts.set(signal.symbol, signal.epoch);
        void this.execute(signal);
    }
    private current(signal: Signal) {
        const market = this.markets.get(signal.symbol);
        if (!market?.ready(this.now())) return false;
        if (
            this.state.settings.strategy === 'over2-under7' &&
            !(this.state.settings.hitRecovery === 'analysis' && signal.recovery)
        ) {
            const fresh = cycleSignal(market, this.state.recovery, this.now());
            return (
                fresh?.direction === signal.direction &&
                fresh.barrier === signal.barrier &&
                (!signal.formation || fresh.epoch === signal.epoch)
            );
        }
        if (this.state.settings.strategy === 'even-odd') {
            const fresh = chooseSignal(
                [...this.markets.values()],
                this.state.recovery,
                this.state.settings,
                this.now(),
                this.deps.random
            );
            return (
                fresh?.symbol === signal.symbol &&
                fresh.direction === signal.direction &&
                (!signal.formation || fresh.epoch === signal.epoch)
            );
        }
        if (signal.recovery) {
            const s = recoverySignal(market, this.state.recovery, this.state.settings, this.now());
            return (
                s?.direction === signal.direction &&
                s.barrier === signal.barrier &&
                (!signal.formation || s.epoch === signal.epoch)
            );
        }
        const barrier =
            signal.direction === 'DIGITDIFF' ? String(market.digits[market.digits.length - 1]) : signal.barrier!;
        const mark = market.frequencies()[Number(barrier)];
        return barrier === signal.barrier && !mark.most && !mark.least;
    }
    private async execute(signal: Signal) {
        this.busy = true;
        this.update({ selected: signal, phase: 'Quoting' });
        try {
            const parameters: Packet = {
                amount: this.state.stake / 100,
                basis: 'stake',
                contract_type: signal.direction,
                currency: 'USD',
                duration:
                    this.state.settings.strategy !== 'even-odd' &&
                    signal.recovery &&
                    this.state.settings.recoveryMode === 'parity_percentage' &&
                    (this.state.settings.strategy !== 'over2-under7' || this.state.settings.hitRecovery === 'analysis')
                        ? 1
                        : this.state.settings.duration,
                duration_unit: 't',
                symbol: signal.symbol,
                ...(signal.barrier !== undefined ? { barrier: signal.barrier } : {}),
            };
            const response = await this.request({ proposal: 1, ...parameters });
            const quote = response.proposal;
            if (
                !quote ||
                !Number.isFinite(Number(quote.ask_price)) ||
                cents(quote.ask_price) !== this.state.stake ||
                !Number.isFinite(Number(quote.payout)) ||
                cents(quote.payout) <= this.state.stake
            )
                throw new Error('Invalid price or payout quote.');
            this.update({
                quote: {
                    stake: this.state.stake,
                    payout: cents(quote.payout),
                    breakEven: (Number(quote.ask_price) / Number(quote.payout)) * 100,
                },
            });
            if (
                !this.state.wantsRun ||
                !this.state.active ||
                !this.current(signal) ||
                (signal.formation && quote.spot_time !== undefined && quote.spot_time !== signal.epoch)
            ) {
                this.log('Signal changed while quoting; skipped.');
                return;
            }
            if (this.account()?.account_id !== this.state.accountId) throw new Error('Selected account changed.');
            const reason = riskReason(this.state.settings, this.state.pnl, this.state.streak, this.state.stake);
            if (reason) {
                this.finish(reason);
                return;
            }
            const nonce = `${this.owner}-${this.now()}-${Math.random().toString(36).slice(2)}`;
            this.update({
                pending: {
                    nonce,
                    signal,
                    duration: parameters.duration,
                    stake: this.state.stake,
                    payout: cents(quote.payout),
                    sentAt: this.now(),
                },
                phase: 'Purchasing',
            });
            try {
                this.persist();
            } catch {
                this.update({ pending: undefined });
                this.halt('Unable to save purchase intent. No order was sent.');
                return;
            } // Record the intent before sending money; never retry an uncertain buy.
            this.log(
                `${signal.recovery ? 'RECOVERY' : 'ENTRY'} ${signal.symbol} ${signal.direction} ${signal.barrier ?? ''} · $${(this.state.stake / 100).toFixed(2)}`
            );
            try {
                const result = await this.request({
                    buy: 1,
                    price: Number(quote.ask_price),
                    parameters,
                    passthrough: { neto_order_id: nonce },
                });
                if (this.state.pending && !this.state.pending.contractId) this.acknowledge(result.buy);
                if (this.state.pending?.contractId) await this.watch(this.state.pending.contractId);
            } catch (error) {
                const code =
                    (error as { error?: { code?: string }; code?: string })?.error?.code ||
                    (error as { code?: string })?.code;
                if (code && definitive.has(code) && !this.state.pending?.contractId) {
                    this.update({ pending: undefined });
                    this.persist();
                    this.disabled.set(signal.symbol, this.now() + 10000);
                    this.log(`Purchase rejected (${code}); no retry.`, 'warn');
                } else {
                    this.halt(
                        'Purchase outcome is unconfirmed. No new orders. Resume the saved contract or reconcile its ID from Deriv history.'
                    );
                    return;
                }
            }
        } catch (error) {
            if (this.state.pending)
                this.halt(error instanceof Error ? error.message : 'Cannot confirm contract state.');
            else {
                this.log(error instanceof Error ? error.message : 'Quote unavailable.', 'warn');
                this.disabled.set(signal.symbol, this.now() + 10000);
            }
        } finally {
            this.busy = false;
            if (!this.state.wantsRun && !this.state.pending && this.state.active) this.finish('Stopped');
        }
    }
    private acknowledge(buy: Packet) {
        const p = this.state.pending;
        if (!p || !buy || !Number.isSafeInteger(buy.contract_id) || buy.contract_id <= 0)
            throw new Error('Missing purchase acknowledgement; outcome is uncertain.');
        this.update({
            pending: { ...p, contractId: buy.contract_id },
            phase: 'Contract open',
            highestStake: Math.max(this.state.highestStake, p.stake),
            trades: [
                ...this.state.trades,
                {
                    id: p.nonce,
                    contractId: buy.contract_id,
                    market: p.signal.symbol,
                    direction: p.signal.direction,
                    barrier: p.signal.barrier,
                    recovery: p.signal.recovery,
                    stake: p.stake,
                    payout: cents(buy.payout ?? p.payout / 100),
                    status: 'Open',
                    at: this.now(),
                },
            ].slice(-100),
        });
        if (p.signal.recovery)
            this.update({
                recovery: {
                    ...this.state.recovery,
                    lockedSymbol:
                        this.state.settings.strategy === 'even-odd'
                            ? p.signal.symbol
                            : this.state.settings.recoveryMode === 'parity' ||
                                (this.state.settings.recoveryMode === 'parity_percentage' &&
                                    (this.state.settings.strategy !== 'over2-under7' ||
                                        this.state.settings.hitRecovery === 'analysis'))
                              ? undefined
                              : p.signal.symbol,
                    lockedDirection: p.signal.direction,
                    countAfter: 0,
                },
            });
        this.persist();
        this.log(`BUY confirmed · contract ${buy.contract_id}`);
        if (cents(buy.buy_price) !== p.stake) this.stop('Purchase amount differs from the quote; settling only.');
    }
    private async watch(id: number) {
        if (this.watching === id) return;
        this.watching = id;
        try {
            const result = await this.request({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
            if (result.proposal_open_contract) this.contract(result.proposal_open_contract);
        } catch (error) {
            this.watching = undefined;
            throw error;
        }
    }
    private validateContract(c: Packet, p: Pending, id: number) {
        if (
            !c ||
            c.contract_id !== id ||
            (c.underlying || c.underlying_symbol) !== p.signal.symbol ||
            c.contract_type !== p.signal.direction ||
            c.currency !== 'USD' ||
            cents(c.buy_price) !== p.stake ||
            c.tick_count !== (p.duration ?? this.state.settings.duration)
        )
            throw new Error('Contract does not match the saved purchase.');
        if (p.signal.barrier !== undefined && String(Number(c.barrier)) !== p.signal.barrier)
            throw new Error('Contract barrier does not match the saved purchase.');
    }
    private contract(c: Packet) {
        const p = this.state.pending;
        if (!p?.contractId || c.contract_id !== p.contractId) return;
        this.validateContract(c, p, p.contractId);
        const entry =
            c.entry_tick_display_value ?? c.entry_spot_display_value ?? (c.entry_tick ?? c.entry_spot)?.toString();
        const exit = c.exit_tick_display_value ?? c.exit_spot_display_value ?? (c.exit_tick ?? c.exit_spot)?.toString();
        const closed = c.is_sold === 1;
        this.update({
            trades: this.state.trades.map(t =>
                t.id === p.nonce ? { ...t, entry, exit, status: closed ? 'Settled' : 'Open' } : t
            ),
        });
        if (!closed) return;
        if (c.profit === undefined || c.profit === null || c.profit === '' || !Number.isFinite(Number(c.profit)))
            throw new Error('Settlement profit is missing.');
        const profit = cents(c.profit),
            payout = cents(c.payout ?? p.payout / 100);
        if (profit < -p.stake || profit > payout - p.stake)
            throw new Error('Settlement profit is outside the purchased contract bounds.');
        const streak = profit < 0 ? this.state.streak + 1 : profit > 0 ? 0 : this.state.streak;
        const next =
            profit < 0
                ? nextRecoveryStake(p.stake, this.state.settings.multiplier)
                : profit > 0
                  ? cents(this.state.settings.stake)
                  : this.state.stake;
        let recovery = { ...this.state.recovery, streak },
            recoveryLosses = this.state.recoveryLosses;
        if (profit > 0 || (profit < 0 && !p.signal.recovery)) {
            recovery = {
                streak,
                previous: p.signal.recovery ? recovery.previous : p.signal.direction,
                countAfter: 0,
                pauseUntil: 0,
            };
            recoveryLosses = 0;
        }
        if (profit < 0 && this.state.settings.recoveryMode === 'parity')
            recovery.lockedDirection = p.signal.recovery
                ? p.signal.direction === 'DIGITEVEN'
                    ? 'DIGITODD'
                    : 'DIGITEVEN'
                : Math.random() < 0.5
                  ? 'DIGITEVEN'
                  : 'DIGITODD';
        if (profit < 0 && p.signal.recovery && isPaired(this.state.settings.recoveryMode)) {
            recoveryLosses++;
            if (recoveryLosses >= 2) {
                recoveryLosses = 0;
                recovery.pauseUntil = this.now() + 5000;
                recovery.countAfter = this.state.settings.recoveryMode === 'under5_plain' ? 0 : recovery.pauseUntil;
            }
        }
        if (!p.signal.recovery) recovery.previous = p.signal.direction;
        let batch = this.state.batch + 1;
        let pause = batch >= 3 && streak === 0;
        if (this.state.settings.strategy === 'over2-under7') {
            // Recovery is separate from the three normal wins that complete a batch.
            batch = profit < 0 || p.signal.recovery ? 0 : profit > 0 ? this.state.batch + 1 : this.state.batch;
            pause = batch >= 3 && streak === 0;
            const batchMarket = this.state.recovery.batchMarket || p.signal.symbol;
            const batchDirection = this.state.recovery.batchDirection || p.signal.direction;
            if (this.state.settings.hitRecovery === 'analysis' && streak > 0) {
                // Preserve the original policy's locks, formation counters and paired-loss pauses.
                recovery = { ...recovery, batchMarket, batchDirection };
            } else {
                recovery = {
                    streak,
                    countAfter: pause ? this.now() + 5000 : 0,
                    pauseUntil: pause ? this.now() + 5000 : 0,
                    ...(pause ? {} : { lockedSymbol: batchMarket, lockedDirection: batchDirection }),
                };
                recoveryLosses = 0;
            }
            if (pause) this.log('Three-win batch complete. Returning to fresh market analysis after five seconds.');
        }
        if (this.state.settings.strategy === 'even-odd') {
            const deficit = Math.max(0, (this.state.recovery.deficit || 0) - profit);
            const wasRecovering = (this.state.recovery.deficit || 0) > 0;
            recovery = {
                streak,
                deficit,
                pauseUntil: 0,
                countAfter: deficit > 0 ? (wasRecovering ? this.state.recovery.countAfter : this.now()) : this.now(),
                ...(deficit > 0
                    ? {
                          lockedSymbol: p.signal.symbol,
                          lockedDirection: p.signal.direction,
                      }
                    : {}),
            };
            // A win resets stake even when recovery still has an unpaid balance.
            // Keep the recovery lock and repay that balance across subsequent trades.
            if (deficit > 0 && profit > 0)
                this.log(`Recovery deficit $${(deficit / 100).toFixed(2)} · Next stake $${(next / 100).toFixed(2)}.`);
            batch = 0;
            pause = false;
        }
        const pnl = this.state.pnl + profit,
            peak = Math.max(this.state.peak, pnl);
        this.update({
            pnl,
            peak,
            maxDrawdown: Math.max(this.state.maxDrawdown, peak - pnl),
            streak,
            stake: next,
            recovery,
            recoveryLosses,
            wins: this.state.wins + (profit > 0 ? 1 : 0),
            losses: this.state.losses + (profit < 0 ? 1 : 0),
            voids: this.state.voids + (profit === 0 ? 1 : 0),
            batch: pause ? 0 : batch,
            batchPause: pause ? this.now() + 5000 : this.state.batchPause,
            pending: undefined,
            trades: this.state.trades.map(t =>
                t.id === p.nonce ? { ...t, profit, status: profit > 0 ? 'Won' : profit < 0 ? 'Lost' : 'Void' } : t
            ),
        });
        this.watching = undefined;
        this.persist();
        this.log(
            `SETTLED ${p.contractId} · ${profit >= 0 ? '+' : '-'}$${(Math.abs(profit) / 100).toFixed(2)} · session $${(pnl / 100).toFixed(2)}`
        );
        const reason = riskReason(this.state.settings, pnl, streak, next);
        if (!this.state.wantsRun || reason) this.finish(reason || 'Stopped after settlement');
    }
    stop(reason = 'Manual stop') {
        this.update({
            wantsRun: false,
            phase: this.state.pending ? 'Stopping after current contract settles' : 'Stopping',
        });
        this.log(reason);
        if (!this.state.pending && !this.busy) this.finish(reason);
    }
    private halt(message: string) {
        this.update({ error: message, wantsRun: false });
        this.log(message, 'error');
        if (this.state.pending) {
            this.update({ active: false, phase: 'Reconciliation required', liveUntil: 0 });
            this.cleanup();
            try {
                this.persist();
            } catch {
                /* preserve the existing intent */
            }
            this.deps.lockChanged?.(true);
        } else this.finish(message);
    }
    private finish(reason: string) {
        this.update({ active: false, wantsRun: false, phase: reason, liveUntil: 0 });
        this.cleanup();
        this.deps.lockChanged?.(!!this.state.pending);
        try {
            this.persist();
        } catch {
            this.update({ error: 'Unable to save session. Check your contract history before restarting.' });
        }
    }
    private cleanup() {
        this.initialized = false;
        this.closing = true;
        clearInterval(this.timer);
        this.timer = undefined;
        this.subscription?.unsubscribe();
        this.api?.disconnect();
        this.api = undefined;
    }
}
