import { evaluateScan, type ScanSide } from '@/pages/digit-analysis/scanner';

export type XmlScannerMatch = {
    symbol: string;
    side: ScanSide;
    name: string;
    submarket: string;
    sampleSize: number;
    baselineCounts: number[];
};
type Phase = 'idle' | 'scanning' | 'loading' | 'waiting' | 'running' | 'finishing' | 'cooldown' | 'stopped';
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
        this.takeProfit = Number.MAX_SAFE_INTEGER;
        this.stopLoss = Number.MAX_SAFE_INTEGER;
        this.update({
            enabled: true,
            phase: 'scanning',
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
        this.update({ phase: 'waiting', message: 'Waiting for a qualifying live entry. XML recovery is retained.' });
        return true;
    }
    canRun() {
        return this.state.enabled && this.state.phase === 'waiting';
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
        this.update({ enabled: false, phase: 'stopped', message });
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
    market(symbol: string, digits: number[], epoch: number) {
        if (!this.state.enabled || !this.started || symbol !== this.state.match?.symbol) return;
        this.lastDigits = digits;
        this.lastEpoch = epoch;
        if (this.waiter && this.ready()) {
            this.entered = true;
            const resolve = this.waiter;
            this.waiter = undefined;
            this.update({ phase: 'running', message: 'Trading XML batch.' });
            resolve(true);
        }
    }
    private ready() {
        const match = this.state.match;
        return (
            !!match &&
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
        if (this.entered) return Promise.resolve(true); // XML recovery and the locked batch keep their own entry logic.
        if (this.ready()) {
            this.entered = true;
            this.update({ phase: 'running', message: 'Trading XML batch.' });
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
    purchase(accountId: string) {
        if (!this.guarded) return true;
        if (
            !this.state.enabled ||
            !this.started ||
            accountId !== this.state.accountId ||
            this.state.phase !== 'running' ||
            this.inFlight
        )
            return false;
        this.inFlight = true;
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
    contract(value: { contract_id?: number; is_sold?: number | boolean; profit?: number | string }) {
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
        if (profit < 0) this.recovery = true;
        else if (profit > 0) this.recovery = false;
        this.update({
            pnl,
            losses,
            wins,
            message: !active
                ? this.state.message
                : this.recovery
                  ? 'XML recovery active; the normal batch restarts after a win.'
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
