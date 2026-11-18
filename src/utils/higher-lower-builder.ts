import type { HedgingLeg } from './higher-lower-results';
import { getDerivAccount, sessionRequest } from './deriv-session';
export const PAIR_BLOCK = 'neto_higher_lower_pair';
type Block = { type: string; disabled?: boolean; isEnabled?: () => boolean; getParent?: () => Block | null };
export function pairedWorkspace(workspace?: { getAllBlocks?: (...args: never[]) => Block[] }) {
    const blocks = workspace?.getAllBlocks?.() || [];
    const paired = blocks.filter(b => b.type === PAIR_BLOCK && !b.disabled && b.isEnabled?.() !== false);
    if (!paired.length) return false;
    if (
        paired.length !== 1 ||
        blocks.some(b => ['purchase', 'trade_again'].includes(b.type) && !b.disabled && b.isEnabled?.() !== false)
    )
        throw new Error(
            'Use exactly one paired-purchase block without ordinary Purchase or Trade again blocks. The paired block controls the session.'
        );
    let parent = paired[0].getParent?.();
    while (parent && parent.type !== 'before_purchase') parent = parent.getParent?.();
    if (!parent) throw new Error('Put the paired-purchase block inside Purchase conditions.');
    return true;
}
type Snapshot = {
    accountId: string;
    running: boolean;
    starting?: boolean;
    busy?: boolean;
    active?: boolean;
    message: string;
    pnl: number;
    pairs: number;
    pending?: { symbol: string; legs: HedgingLeg[] };
    history?: { symbol: string; at: number; profit: number; legs: HedgingLeg[] }[];
};
export class HigherLowerBuilder {
    private state: Snapshot = { accountId: '', running: false, message: '', pnl: 0, pairs: 0 };
    private listeners = new Set<() => void>();
    private stopped = false;
    private attempt = '';
    private revision = 0;
    getSnapshot = () => this.state;
    subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    };
    private update(value: Partial<Snapshot>) {
        this.state = { ...this.state, ...value };
        this.listeners.forEach(fn => fn());
    }
    private path() {
        return `/api/higher-lower?account_id=${encodeURIComponent(this.state.accountId)}&source=xml`;
    }
    constructor(
        private request = sessionRequest,
        private wait = () => new Promise<void>(resolve => setTimeout(resolve, 1000)),
        private nonce = () => globalThis.crypto.randomUUID()
    ) {}
    async run(
        stake: number,
        duration: number,
        stopLoss: number,
        takeProfit: number,
        maxPairs: number,
        barrier = 1,
        symbol?: string
    ) {
        if (this.state.running) throw new Error('Wait for the previous paired XML session to stop.');
        const account = getDerivAccount();
        if (!account || account.account_type !== 'demo' || account.currency !== 'USD')
            throw new Error('Select an active USD demo account for paired XML.');
        if (barrier !== 1) throw new Error('Use barrier +1 for the paired XML bot.');
        this.stopped = false;
        this.attempt = this.nonce();
        this.update({
            accountId: account.account_id,
            running: true,
            starting: true,
            pending: undefined,
            message: 'Starting paired XML bot.',
            pnl: 0,
            pairs: 0,
        });
        try {
            const result = await this.request(this.path(), {
                command: 'start',
                attempt: this.attempt,
                settings: { stake, duration, stopLoss, takeProfit, maxPairs, ...(symbol ? { symbol } : {}) },
            });
            if (this.stopped) await this.stop();
            else this.update(result);
            while (true) {
                if (getDerivAccount()?.account_id !== account.account_id) {
                    await this.stop();
                    throw new Error('Account changed. Paired XML entries stopped.');
                }
                const revision = this.revision;
                const state = await this.request(this.path());
                if (revision !== this.revision) continue;
                this.update(state);
                if (!state.active && !state.starting && !state.busy) break;
                await this.wait();
            }
        } catch (error) {
            await this.stop().catch(() => {});
            this.update({ message: error instanceof Error ? error.message : 'Paired XML stopped. Check Reports.' });
            throw error;
        } finally {
            this.update({ running: false, starting: false });
        }
    }
    async stop() {
        if (!this.state.running) return;
        this.stopped = true;
        this.revision++;
        const result = await this.request(this.path(), { command: 'stop', attempt: this.attempt });
        this.update(result);
    }
    async refresh() {
        if (this.state.running || getDerivAccount()?.account_id !== this.state.accountId)
            throw new Error('Stop and select the XML account before refreshing its contracts.');
        const result = await this.request(this.path(), { command: 'refresh' });
        this.update(result);
    }
}
export const higherLowerBuilder = new HigherLowerBuilder();
