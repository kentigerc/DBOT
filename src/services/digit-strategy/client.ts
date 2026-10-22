import { api_base } from '@/external/bot-skeleton';
import { type DerivAccount, getDerivAccount, sessionRequest } from '@/utils/deriv-session';
import { setAnalysisTrading } from '@/utils/trading-lock';
import { empty, type Snapshot } from './engine';
import { type Settings } from './strategy';

class ServerStrategyClient {
    private state: Snapshot & { demoOnly?: boolean } = empty();
    private listeners = new Set<() => void>();
    private account?: DerivAccount;
    private sequence = 0;
    private polling = false;
    private timer?: ReturnType<typeof setTimeout>;
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private accept(data: Snapshot & { starting?: boolean; commandError?: string }, accountId: string) {
        if (this.account?.account_id !== accountId) return;
        this.state = {
            ...data,
            active: data.active || !!data.starting,
            error: data.commandError || data.error,
            phase: data.starting && !data.active ? 'Starting on server' : data.phase,
        };
        setAnalysisTrading(this.state.active || !!this.state.pending);
        this.listeners.forEach(listener => listener());
    }
    private path() {
        if (!this.account) throw new Error('Log in and select a Deriv account.');
        return `/api/analysis?account_id=${encodeURIComponent(this.account.account_id)}`;
    }
    selectAccount(account?: DerivAccount) {
        if (account?.account_id === this.account?.account_id) return;
        this.account = account;
        this.sequence++;
        this.state = { ...empty(), accountId: account?.account_id || '' };
        setAnalysisTrading(false);
        this.listeners.forEach(listener => listener());
        clearTimeout(this.timer);
        void this.poll();
    }
    private async poll() {
        if (this.polling) {
            this.timer = setTimeout(() => void this.poll(), 250);
            return;
        }
        if (!this.account) return;
        this.polling = true;
        const accountId = this.account.account_id;
        const sequence = this.sequence;
        try {
            const data = await sessionRequest(this.path());
            if (sequence === this.sequence) this.accept(data, accountId);
        } catch (error) {
            if (sequence === this.sequence) {
                this.state = {
                    ...this.state,
                    error: `${(error as Error).message} Status may be stale; server trading may still be running.`,
                };
                this.listeners.forEach(listener => listener());
            }
        } finally {
            this.polling = false;
            if (this.account) this.timer = setTimeout(() => void this.poll(), 1000);
        }
    }
    private async command(body: object) {
        const accountId = this.account?.account_id;
        if (!accountId) throw new Error('Log in and select a Deriv account.');
        const sequence = ++this.sequence;
        const data = await sessionRequest(this.path(), body);
        if (sequence === this.sequence) this.accept(data, accountId);
    }
    async start(settings: Settings, reconcileId?: number) {
        if (api_base.is_running) throw new Error('Stop Bot Builder before running Analysis Tool.');
        this.selectAccount(getDerivAccount());
        // Preserve unresolved browser purchase intent from the previous version. Never silently discard it.
        const legacy = localStorage.getItem(`neto.digit-strategy.v1.${this.account?.account_id}`);
        if (legacy && JSON.parse(legacy).pending) {
            const saved = JSON.parse(legacy);
            await this.command({
                action: 'import-browser',
                legacy: {
                    settings: saved.settings,
                    pending: saved.pending,
                    pnl: saved.pnl,
                    streak: saved.streak,
                    stake: saved.stake,
                    wins: saved.wins,
                    losses: saved.losses,
                    voids: saved.voids,
                    maxDrawdown: saved.maxDrawdown,
                    peak: saved.peak,
                    highestStake: saved.highestStake,
                    recovery: saved.recovery,
                    recoveryLosses: saved.recoveryLosses,
                    batch: saved.batch,
                },
            });
            localStorage.removeItem(`neto.digit-strategy.v1.${this.account?.account_id}`);
            return;
        }
        await this.command({ action: 'start', settings, reconcileId });
    }
    stop = () => this.command({ action: 'stop' });
    reset = () => this.command({ action: 'reset' });
}
export const digitStrategyEngine = new ServerStrategyClient();
if (typeof window !== 'undefined') {
    window.addEventListener('neto-session', () => digitStrategyEngine.selectAccount(getDerivAccount()));
}
