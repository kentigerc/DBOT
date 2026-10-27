import { nextRecoveryStake } from '@/services/digit-strategy/strategy';
import { evaluateScan, type ScanSide } from '@/pages/digit-analysis/scanner';

export type XmlScannerMatch = {
    symbol: string;
    side: ScanSide;
    name: string;
    submarket: string;
    sampleSize: number;
    baselineCounts: number[];
};
type Phase =
    | 'idle'
    | 'scanning'
    | 'loading'
    | 'waiting'
    | 'running'
    | 'switching'
    | 'finishing'
    | 'cooldown'
    | 'stopped';
type State = {
    enabled: boolean;
    phase: Phase;
    generation: number;
    accountId: string;
    sampleSize: number;
    match?: XmlScannerMatch;
    wins: number;
    losses: number;
    batches: number;
    pnl: number;
    message: string;
    recoverySearch: boolean;
};

// In-memory only: reloading a page never authorizes another automated run.
export class XmlScannerCycle {
    private state: State = {
        enabled: false,
        phase: 'idle',
        generation: 0,
        accountId: '',
        sampleSize: 1000,
        wins: 0,
        losses: 0,
        batches: 0,
        pnl: 0,
        message: '',
        recoverySearch: false,
    };
    private listeners = new Set<() => void>();
    private stopBot?: (batchComplete: boolean) => void;
    private reportStop?: (message: string) => void;
    private guarded = false;
    private started = false;
    private entered = false;
    private recovery = false;
    private inFlight = false;
    private contractId?: number;
    private settled = new Set<number>();
    private waiter?: (allow: boolean) => void;
    private lastDigits: number[] = [];
    private lastEpoch = 0;
    private feedPaused = false;
    private recoveryAfterEpoch = 0;
    private nextRecoveryMarket?: XmlScannerMatch;
    private rejectedRecoveryMarkets = new Set<string>();
    private timer?: ReturnType<typeof setTimeout>;
    private takeProfit = Number.MAX_SAFE_INTEGER;
    private stopLoss = Number.MAX_SAFE_INTEGER;
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private update(patch: Partial<State>) {
        this.state = { ...this.state, ...patch };
        this.listeners.forEach(fn => fn());
    }
    start(
        accountId: string,
        sampleSize: number,
        stopBot: (batchComplete: boolean) => void,
        reportStop?: (message: string) => void
    ) {
        if (this.state.enabled) throw new Error('XML Auto is already active.');
        if (this.inFlight || this.contractId !== undefined)
            throw new Error('Settle the previous XML purchase before starting again.');
        if (!accountId || ![100, 500, 1000].includes(sampleSize))
            throw new Error('Select an active Deriv account and sample size.');
        clearTimeout(this.timer);
        this.stopBot = stopBot;
        this.reportStop = reportStop;
        this.guarded = true;
        this.started = this.entered = this.recovery = this.inFlight = false;
        this.contractId = undefined;
        this.settled.clear();
        this.recoveryAfterEpoch = 0;
        this.feedPaused = false;
        this.nextRecoveryMarket = undefined;
        this.rejectedRecoveryMarkets.clear();
        this.takeProfit = Number.MAX_SAFE_INTEGER;
        this.stopLoss = Number.MAX_SAFE_INTEGER;
        this.update({
            enabled: true,
            phase: 'scanning',
            recoverySearch: false,
            generation: this.state.generation + 1,
            accountId,
            sampleSize,
            match: undefined,
            wins: 0,
            losses: 0,
            batches: 0,
            pnl: 0,
            message: 'Scanning both directions for an XML batch.',
        });
    }
    claim(match: XmlScannerMatch) {
        if (!this.state.enabled || this.state.phase !== 'scanning' || match.sampleSize !== this.state.sampleSize)
            return;
        this.settled.clear();
        this.lastDigits = [];
        this.lastEpoch = 0;
        this.recoveryAfterEpoch = 0;
        this.entered = this.recovery = this.inFlight = false;
        this.contractId = undefined;
        this.update({
            match,
            wins: 0,
            phase: 'loading',
            generation: this.state.generation + 1,
            message: `Market found · ${match.symbol} · Loading ${match.name}`,
        });
        return this.state.generation;
    }
    valid(generation: number) {
        return this.state.enabled && this.state.generation === generation;
    }
    loaded(generation: number, limits: { takeProfit: number; stopLoss: number }) {
        if (!this.valid(generation) || this.state.phase !== 'loading') return false;
        if (![limits.takeProfit, limits.stopLoss].every(n => Number.isSafeInteger(n) && n > 0))
            throw new Error('XML risk limits are missing or invalid.');
        this.takeProfit = Math.min(this.takeProfit, limits.takeProfit);
        this.stopLoss = Math.min(this.stopLoss, limits.stopLoss);
        this.update({ phase: 'waiting', message: 'Waiting for a qualifying live entry. Even/Odd recovery enabled.' });
        return true;
    }
    canRun() {
        return this.state.enabled && !this.started && this.state.phase === 'waiting';
    }
    runStarted() {
        if (this.canRun()) this.started = true;
    }
    manualRun() {
        this.stop('Manual Builder run selected.');
        this.guarded = false;
    }
    stop(message = 'XML Auto stopped.', notifyRunner = true) {
        if (!this.state.enabled) return;
        clearTimeout(this.timer);
        this.waiter?.(false);
        this.waiter = undefined;
        this.nextRecoveryMarket = undefined;
        this.update({ enabled: false, phase: 'stopped', recoverySearch: false, message });
        try {
            this.reportStop?.(`XML Auto stopped: ${message}`);
        } catch {
            /* Logging cannot interfere with stopping. */
        }
        if (this.started) {
            this.started = false;
            if (notifyRunner) this.stopBot?.(false);
        }
    }
    pauseMarket(symbol: string) {
        if (!this.state.enabled || symbol !== this.state.match?.symbol) return;
        this.feedPaused = true;
        this.update({ message: 'Live monitoring reconnecting · New purchases paused.' });
    }
    private fresh(epoch = this.lastEpoch) {
        return epoch > 0 && Date.now() / 1000 - epoch <= 6 && epoch <= Date.now() / 1000 + 2;
    }
    market(symbol: string, digits: number[], epoch: number) {
        if (!this.state.enabled || !this.started || symbol !== this.state.match?.symbol) return;
        this.lastDigits = digits;
        this.lastEpoch = epoch;
        if (digits.length === this.state.sampleSize && this.fresh(epoch) && this.feedPaused) {
            this.feedPaused = false;
            this.update({
                message: this.recovery
                    ? 'Live monitoring restored · Continuing XML recovery.'
                    : 'Live monitoring restored.',
            });
        }
        if (this.waiter && !this.feedPaused && ((this.entered && this.fresh()) || this.ready())) {
            this.entered = true;
            const resolve = this.waiter;
            this.waiter = undefined;
            this.update({
                phase: 'running',
                recoverySearch: false,
                message: this.recovery ? 'Trading XML recovery.' : 'Trading XML batch.',
            });
            resolve(true);
        }
    }
    isRecovering() {
        return this.state.enabled && this.recovery;
    }
    recoveryStake(previousAmount: number) {
        if (!this.isRecovering()) return;
        const cents = Math.round(Number(previousAmount) * 100);
        const stake = nextRecoveryStake(cents, 2.1);
        if (
            !Number.isSafeInteger(cents) ||
            cents <= 0 ||
            !Number.isSafeInteger(stake) ||
            stake <= 0 ||
            stake > 10000 ||
            this.state.pnl - stake < -this.stopLoss
        ) {
            this.stop('Recovery stake exceeds the stake or session loss limit.');
            return;
        }
        return stake / 100;
    }
    recoveryStatus(message: string) {
        if (this.isRecovering()) this.update({ message });
    }
    recoveryTarget() {
        return this.state.enabled ? this.nextRecoveryMarket : undefined;
    }
    offerRecoveryMarket(match: XmlScannerMatch, digits: number[], epoch: number) {
        if (
            !this.state.enabled ||
            !this.recovery ||
            !this.state.recoverySearch ||
            this.state.phase !== 'waiting' ||
            !this.waiter ||
            match.side !== this.state.match?.side ||
            match.sampleSize !== this.state.sampleSize ||
            this.rejectedRecoveryMarkets.has(match.symbol) ||
            epoch <= this.recoveryAfterEpoch ||
            Date.now() / 1000 - epoch > 6 ||
            epoch > Date.now() / 1000 + 2 ||
            !evaluateScan(digits, match.side, match.sampleSize).entryReady
        )
            return false;
        if (match.symbol === this.state.match?.symbol) {
            // A scanner snapshot cannot stand in for the disconnected live guard.
            if (this.feedPaused) return false;
            this.market(match.symbol, digits, epoch);
            return true;
        }
        this.nextRecoveryMarket = match;
        const resolve = this.waiter;
        this.waiter = undefined;
        this.update({
            phase: 'switching',
            recoverySearch: false,
            message: `Recovery market found · ${match.symbol} · Updating the running XML`,
        });
        resolve(true);
        return true;
    }
    confirmRecoveryMarket(match: XmlScannerMatch) {
        if (this.nextRecoveryMarket !== match || !this.state.enabled || this.inFlight) return false;
        this.nextRecoveryMarket = undefined;
        this.lastDigits = [];
        this.lastEpoch = 0;
        this.update({
            match,
            phase: 'waiting',
            recoverySearch: true,
            message: `Verifying a fresh recovery entry on ${match.symbol}.`,
        });
        return true;
    }
    rejectRecoveryMarket(match: XmlScannerMatch) {
        if (this.nextRecoveryMarket !== match || !this.state.enabled) return;
        this.rejectedRecoveryMarkets.add(match.symbol);
        this.nextRecoveryMarket = undefined;
        this.update({
            phase: 'waiting',
            recoverySearch: true,
            message: 'Recovery candidate unavailable for this XML contract. Scanning other markets.',
        });
    }
    private ready() {
        const match = this.state.match;
        return (
            !!match &&
            this.lastEpoch > this.recoveryAfterEpoch &&
            Date.now() / 1000 - this.lastEpoch <= 6 &&
            this.lastEpoch <= Date.now() / 1000 + 2 &&
            evaluateScan(this.lastDigits, match.side, match.sampleSize).entryReady
        );
    }
    beforePurchase(symbol: string): Promise<boolean> {
        if (!this.guarded) return Promise.resolve(true);
        if (!this.state.enabled || !this.started || !['waiting', 'running'].includes(this.state.phase))
            return Promise.resolve(false);
        if (symbol !== this.state.match?.symbol) {
            this.stop('The XML market changed. Start a fresh scan.');
            return Promise.resolve(false);
        }
        if (this.entered && !this.feedPaused && this.fresh()) return Promise.resolve(true);
        if (!this.feedPaused && this.ready()) {
            this.entered = true;
            this.update({
                phase: 'running',
                recoverySearch: false,
                message: this.recovery ? 'Trading XML recovery.' : 'Trading XML batch.',
            });
            return Promise.resolve(true);
        }
        if (this.waiter) {
            this.stop('Duplicate XML entry request.');
            return Promise.resolve(false);
        }
        return new Promise(resolve => {
            this.waiter = resolve;
        });
    }
    canPurchase(accountId: string) {
        return (
            !this.guarded ||
            (this.state.enabled &&
                this.started &&
                accountId === this.state.accountId &&
                this.state.phase === 'running' &&
                !this.feedPaused &&
                this.fresh() &&
                !this.inFlight)
        );
    }
    purchase(accountId: string) {
        if (!this.canPurchase(accountId)) return false;
        if (this.guarded) this.inFlight = true;
        return true;
    }
    purchaseFailed(error?: { code?: string; message?: string }) {
        this.inFlight = false;
        const detail = [error?.code, error?.message].filter(Boolean).join(' · ');
        this.stop(`XML purchase rejected${detail ? ': ' + detail : '. Check the journal before restarting.'}`);
    }
    purchased(id: number) {
        if (this.guarded && this.inFlight) this.contractId = id;
    }
    contract(value: {
        contract_id?: number;
        is_sold?: number | boolean;
        profit?: number | string;
        exit_tick_time?: number | string;
        exit_spot_time?: number | string;
        sell_time?: number | string;
    }) {
        if (
            this.contractId === undefined ||
            value.contract_id !== this.contractId ||
            ![true, 1].includes(value.is_sold as number) ||
            this.settled.has(value.contract_id!)
        )
            return;
        if (
            value.profit === undefined ||
            value.profit === null ||
            value.profit === '' ||
            !Number.isFinite(Number(value.profit))
        ) {
            this.stop('Settlement result is unavailable. Check the open contract.');
            return;
        }
        const active = this.state.enabled && this.started;
        this.settled.add(value.contract_id!);
        this.contractId = undefined;
        this.inFlight = false;
        const profit = Math.round(Number(value.profit) * 100);
        const pnl = this.state.pnl + profit;
        const losses = profit < 0 ? this.state.losses + 1 : profit > 0 ? 0 : this.state.losses;
        const wins = profit < 0 || this.recovery ? 0 : profit > 0 ? this.state.wins + 1 : this.state.wins;
        if (profit < 0) {
            this.recovery = true;
            // Keep the selected market and original entry: XML recovery continues
            // directly, subject to live-feed freshness and the existing risk guards.
            this.entered = true;
            this.nextRecoveryMarket = undefined;
            this.rejectedRecoveryMarkets.clear();
            const lossEpoch = Number(value.exit_tick_time ?? value.exit_spot_time ?? value.sell_time);
            this.recoveryAfterEpoch = Math.max(this.lastEpoch, Number.isFinite(lossEpoch) ? lossEpoch : 0);
        } else if (profit > 0) this.recovery = false;
        this.update({
            pnl,
            losses,
            wins,
            ...(active && profit < 0 ? { phase: 'running' as const, recoverySearch: false } : {}),
            message: !active
                ? this.state.message
                : this.recovery
                  ? 'Searching recovery markets.'
                  : 'Trading XML batch.',
        });
        if (!active) return;
        if (pnl >= this.takeProfit || pnl <= -this.stopLoss || losses >= 10) {
            // Defer termination until every contract/journal listener has handled this settlement.
            this.update({ phase: 'finishing' });
            const generation = this.state.generation;
            queueMicrotask(() => {
                if (this.valid(generation))
                    this.stop(
                        pnl >= this.takeProfit
                            ? `Session take-profit reached: $${(pnl / 100).toFixed(2)}.`
                            : pnl <= -this.stopLoss
                              ? `Session stop-loss reached: $${(pnl / 100).toFixed(2)}.`
                              : `Consecutive-loss limit reached: ${losses}/10.`
                    );
            });
        } else if (wins >= 3) {
            this.update({ phase: 'finishing', message: 'Three normal wins complete. Stopping before a fresh scan.' });
            const generation = this.state.generation;
            queueMicrotask(() => {
                if (this.valid(generation)) this.stopBot?.(true);
            });
        }
    }
    runnerStopped() {
        if (!this.state.enabled || !this.started) return;
        this.started = false;
        if (this.state.phase !== 'finishing' || this.state.wins < 3) {
            this.stop('XML bot stopped. Automatic entries have been cancelled.');
            return;
        }
        this.update({
            phase: 'cooldown',
            batches: this.state.batches + 1,
            message: 'Batch complete. Analysing again in five seconds.',
        });
        const generation = this.state.generation;
        this.timer = setTimeout(() => {
            if (this.valid(generation))
                this.update({
                    phase: 'scanning',
                    match: undefined,
                    wins: 0,
                    message: 'Scanning both directions for the next XML batch.',
                });
        }, 5000);
    }
}
export const xmlScannerCycle = new XmlScannerCycle();
