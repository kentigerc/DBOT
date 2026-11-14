import { getDerivAccount } from './deriv-session';
import { SWITCHERS, type ManualSide } from './manual-trader-markets';

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
    private recovering = false;
    private pending = false;
    private contractId?: number;
    private settled = new Set<number>();
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
        this.update({ plan, phase: plan ? 'Loaded · Ready for manual RUN' : 'Ready' });
    }
    isLoaded(workspace: Workspace | undefined) {
        const plan = this.state.plan;
        if (!plan || !workspace || getDerivAccount()?.account_id !== plan.accountId) return false;
        const blocks = workspace.getAllBlocks();
        return (
            blocks.some(block => block.data === `netoacademy:hosted-bot:${plan.fileName}`) &&
            blocks.find(block => block.type === 'trade_definition_market')?.getFieldValue('SYMBOL_LIST') === plan.symbol
        );
    }
    private bound() {
        return this.isLoaded(this.workspace);
    }
    begin(workspace: Workspace | undefined, report: (message: string) => void) {
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
        this.pending = false;
        this.contractId = undefined;
        this.settled.clear();
        this.recovering = false;
        this.update({ active: true, phase: 'Trading continuously · Press STOP to end' });
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
        // RUN is the user's entry decision. Do not re-apply scanner entry rules.
        return true;
    }
    allowsPurchase(accountId: string) {
        if (!this.state.plan) return true;
        return this.state.active && accountId === this.state.plan.accountId && this.bound() && !this.pending;
    }
    canPurchase(accountId: string) {
        const allowed = this.allowsPurchase(accountId);
        if (!this.state.plan) return allowed;
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
        this.status(this.recovering ? 'XML recovery active' : 'Trading continuously · Press STOP to end');
    }
    stop() {
        if (this.state.active) this.update({ active: false, phase: 'Stopped' });
    }
}
export const manualTraderGate = new ManualTraderGate();
