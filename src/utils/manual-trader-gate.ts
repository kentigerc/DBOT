import { getDerivAccount } from './deriv-session';
import {
    manualEntryReady,
    SWITCHERS,
    watchManualMarkets,
    type ManualMarket,
    type ManualSide,
} from './manual-trader-markets';

type Plan = { accountId: string; symbol: string; side: ManualSide; fileName: string; name: string };
type Workspace = { getAllBlocks: () => { type: string; data?: string; getFieldValue: (name: string) => string }[] };
const key = 'neto.manual-trader.selection';
function read(): Plan | undefined {
    try {
        const value = JSON.parse(sessionStorage.getItem(key) || 'null');
        return valid(value) ? value : undefined;
    } catch {
        return;
    }
}
function valid(plan: Plan | undefined): plan is Plan {
    return (
        !!plan &&
        typeof plan.accountId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(plan.accountId) &&
        /^(R_\d+|1HZ\d+V)$/.test(plan.symbol) &&
        ['over', 'under'].includes(plan.side) &&
        plan.fileName === SWITCHERS[plan.side].fileName &&
        plan.name === SWITCHERS[plan.side].name
    );
}
export class ManualTraderGate {
    private state: { plan?: Plan; active: boolean; phase: string } = { plan: read(), active: false, phase: 'Ready' };
    private listeners = new Set<() => void>();
    private controller?: AbortController;
    private reading?: ManualMarket;
    private recovering = false;
    private after = 0;
    private pending = false;
    private contractId?: number;
    private settled = new Set<number>();
    private waiters = new Set<(allow: boolean) => void>();
    private workspace?: Workspace;
    private report?: (message: string) => void;
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private update(change: Partial<typeof this.state>) {
        this.state = { ...this.state, ...change };
        this.listeners.forEach(listener => listener());
    }
    private status(message: string) {
        if (message === this.state.phase) return;
        this.update({ phase: message });
        try {
            this.report?.(`Manual Trader · ${message}`);
        } catch {
            // Journal rendering must not interrupt the purchase guard.
        }
    }
    configure(plan?: Plan) {
        this.stop();
        if (plan && !valid(plan)) throw new Error('Invalid Manual Trader selection.');
        try {
            if (plan) sessionStorage.setItem(key, JSON.stringify(plan));
            else sessionStorage.removeItem(key);
        } catch {}
        this.update({ plan, phase: plan ? 'Loaded · Press RUN in Bot Builder' : 'Ready' });
    }
    private bound() {
        const plan = this.state.plan;
        if (!plan || !this.workspace) return false;
        const blocks = this.workspace.getAllBlocks();
        return (
            blocks.some(block => block.data === `netoacademy:hosted-bot:${plan.fileName}`) &&
            blocks.find(block => block.type === 'trade_definition_market')?.getFieldValue('SYMBOL_LIST') === plan.symbol
        );
    }
    begin(
        workspace: Workspace | undefined,
        createApi: Parameters<typeof watchManualMarkets>[0],
        report: (message: string) => void
    ) {
        this.stop();
        if (!this.state.plan) return;
        if (
            !workspace
                ?.getAllBlocks()
                .some(block => block.data === `netoacademy:hosted-bot:${this.state.plan!.fileName}`)
        ) {
            this.configure();
            return;
        }
        this.workspace = workspace;
        if (getDerivAccount()?.account_id !== this.state.plan.accountId || !this.bound())
            throw new Error('Manual Trader selection changed. Reload the bot from Manual Trader before running.');
        this.report = report;
        this.reading = undefined;
        this.pending = false;
        this.contractId = undefined;
        this.settled.clear();
        this.recovering = false;
        this.after = Date.now();
        const controller = new AbortController();
        this.controller = controller;
        this.update({ active: true, phase: 'Waiting for a qualifying live entry' });
        void watchManualMarkets(
            createApi,
            controller.signal,
            reading => {
                if (controller.signal.aborted) return;
                this.reading = reading;
                if (this.recovering) this.status('XML recovery active');
                else if (this.ready()) {
                    this.status('Live entry qualified');
                    this.release(true);
                } else this.status('Waiting for a qualifying live entry');
            },
            message => {
                if (!controller.signal.aborted) this.status(message);
            },
            () => {
                this.reading = undefined;
            },
            this.state.plan.symbol,
            () => this.after
        );
    }
    private ready() {
        return !!this.state.plan && !!this.reading && manualEntryReady(this.reading, this.state.plan.side);
    }
    async beforePurchase(symbol: string, direction: string): Promise<boolean> {
        if (!this.state.plan) return true;
        if (
            !this.state.active ||
            !this.bound() ||
            getDerivAccount()?.account_id !== this.state.plan.accountId ||
            symbol !== this.state.plan.symbol
        )
            return false;
        if (this.recovering) return true;
        if (direction !== SWITCHERS[this.state.plan.side].direction) return false;
        if (this.ready()) return true;
        this.status('Waiting for a qualifying live entry');
        return new Promise(resolve => this.waiters.add(resolve));
    }
    canPurchase(accountId: string) {
        if (!this.state.plan) return true;
        const allowed =
            this.state.active &&
            accountId === this.state.plan.accountId &&
            this.bound() &&
            !this.pending &&
            (this.recovering || this.ready());
        if (allowed) this.pending = true;
        return allowed;
    }
    purchased(id: number) {
        if (this.state.active && this.pending) this.contractId = id;
    }
    purchaseFailed() {
        this.pending = false;
    }
    contract(value: { contract_id?: number; is_sold?: number | boolean; profit?: number | string }) {
        const id = Number(value.contract_id);
        if (!this.state.active || id !== this.contractId || ![true, 1].includes(value.is_sold!) || this.settled.has(id))
            return;
        const profit = Number(value.profit);
        if (!Number.isFinite(profit)) return;
        this.settled.add(id);
        if (this.settled.size > 1000) this.settled.delete(this.settled.values().next().value!);
        this.pending = false;
        this.contractId = undefined;
        if (profit < 0) this.recovering = true;
        else if (profit > 0) this.recovering = false;
        this.after = Date.now();
        this.reading = undefined;
        this.status(this.recovering ? 'XML recovery active' : 'Waiting for a qualifying live entry');
    }
    private release(allow: boolean) {
        this.waiters.forEach(resolve => resolve(allow));
        this.waiters.clear();
    }
    stop() {
        this.controller?.abort();
        this.controller = undefined;
        this.release(false);
        this.reading = undefined;
        if (this.state.active) this.update({ active: false, phase: 'Stopped' });
    }
}
export const manualTraderGate = new ManualTraderGate();
