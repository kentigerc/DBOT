import type { DemoPauseView } from '@/services/digit-strategy/engine';
import { DEMO_RECOVERY_LOSS_LIMIT } from '@/services/digit-strategy/strategy';
import { getDerivAccount, type DerivAccount } from './deriv-session';

type Contract = Record<string, unknown>;
type State = { enabled: boolean; accountId: string; demoPause?: DemoPauseView; message: string };
export class BuilderDemoPause {
    private state: State = { enabled: false, accountId: '', message: '' };
    private listeners = new Set<() => void>();
    private abort?: AbortController;
    private generation = 0;
    private losses = 0;
    private recoveryLosses = 0;
    private initialStake?: number;
    private pending?: number;
    private trigger?: number;
    private settled = new Set<number>();
    private stopBot?: () => void;
    private journal?: (text: string) => void;
    private write(text: string) {
        try {
            this.journal?.(text);
        } catch {
            /* Logging must not control purchases. */
        }
    }
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
    begin(account: DerivAccount | undefined, automatic: boolean, stop: () => void, journal: (text: string) => void) {
        this.stop();
        this.generation++;
        this.losses = this.recoveryLosses = 0;
        this.initialStake = this.pending = this.trigger = undefined;
        this.settled.clear();
        this.stopBot = stop;
        this.journal = journal;
        this.update({
            enabled: !automatic && account?.account_type === 'real',
            accountId: account?.account_id || '',
            demoPause: undefined,
            message: '',
        });
    }
    stop() {
        this.abort?.abort();
        this.update({ enabled: false });
    }
    canPurchase(accountId: string) {
        return !this.abort && (!this.state.enabled || accountId === this.state.accountId);
    }
    purchased(accountId: string, id: number, stake: number) {
        if (!this.state.enabled || accountId !== this.state.accountId || !Number.isSafeInteger(id)) return;
        this.pending = id;
        if (this.initialStake === undefined && Number.isFinite(stake) && stake > 0) this.initialStake = stake;
    }
    contract(
        accountId: string,
        contract: { contract_id?: number; profit?: number | string; is_sold?: number | boolean },
        profit: number
    ) {
        if (
            !this.state.enabled ||
            accountId !== this.state.accountId ||
            contract.contract_id !== this.pending ||
            ![1, true].includes(contract.is_sold as number) ||
            this.settled.has(this.pending!) ||
            !Number.isFinite(profit)
        )
            return;
        this.settled.add(this.pending!);
        if (this.settled.size > 1000) this.settled.delete(this.settled.values().next().value!);
        this.trigger = this.pending;
        this.pending = undefined;
        if (profit > 0) {
            this.losses = this.recoveryLosses = 0;
            this.update({ demoPause: undefined });
        } else if (profit < 0) {
            if (this.losses > 0) this.recoveryLosses++;
            this.losses++;
        }
    }
    async beforePurchase(accountId: string, parameters: Contract, heldStake: number) {
        if (!this.state.enabled) return !this.abort;
        if (accountId !== this.state.accountId || getDerivAccount()?.account_id !== accountId) return false;
        if (this.recoveryLosses < DEMO_RECOVERY_LOSS_LIMIT) return true;
        if (this.abort || !this.trigger || this.initialStake === undefined) return false;
        const controller = new AbortController();
        this.abort = controller;
        const generation = this.generation,
            trigger = this.trigger;
        const valid = () =>
            !controller.signal.aborted &&
            this.state.enabled &&
            generation === this.generation &&
            getDerivAccount()?.account_id === accountId;
        const path = `/api/analysis?account_id=${encodeURIComponent(accountId)}`;
        const progress = (demoPause: DemoPauseView) => {
            if (valid())
                this.update({
                    demoPause: { ...demoPause, heldStake: Math.round(heldStake * 100) },
                    message: 'Real purchases paused · Waiting for a demo win',
                });
        };
        progress({ triggerContractId: trigger, completed: 0, wins: 0, status: 'running' });
        this.write(
            'Bot Builder demo pause: two recovery losses. Waiting for one demo win before resuming the held real order.'
        );
        let polling = false;
        const timer = setInterval(async () => {
            if (polling || !valid()) return;
            polling = true;
            try {
                const response = await fetch(`${path}&demo_pause=${trigger}`, {
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: controller.signal,
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data.demoPause) progress(data.demoPause);
                }
            } catch {
                /* The command response must confirm a win before real trading resumes. */
            } finally {
                polling = false;
            }
        }, 1000);
        try {
            const contract: Contract = {};
            for (const key of [
                'symbol',
                'contract_type',
                'duration',
                'duration_unit',
                'date_expiry',
                'barrier',
                'barrier2',
                'selected_tick',
            ])
                if (parameters[key] !== undefined) contract[key] = parameters[key];
            for (const key of ['duration', 'date_expiry', 'selected_tick'])
                if (contract[key] !== undefined) contract[key] = Number(contract[key]);
            const response = await fetch(path, {
                method: 'POST',
                credentials: 'same-origin',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'demo-break',
                    spec: { triggerContractId: trigger, stake: this.initialStake, contract },
                }),
            });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error || 'Demo pause failed. No further real purchases are allowed.');
            if (!valid()) return false;
            if (data.demoPause?.status !== 'done' || data.demoPause?.wins !== 1 || !(data.demoPause?.completed >= 1))
                throw new Error('A demo win has not been confirmed. Real trading remains paused.');
            this.recoveryLosses = 0;
            progress(data.demoPause);
            this.write(
                'Demo win confirmed. Resuming the XML bot’s held real order; demo results did not change its real results or stake.'
            );
            return true;
        } catch (error) {
            if (!controller.signal.aborted && generation === this.generation) {
                const message =
                    error instanceof Error ? error.message : 'Demo pause failed. Real trading remains paused.';
                this.update({ message, demoPause: { ...this.state.demoPause!, status: 'blocked', error: message } });
                this.write(message);
                this.stop();
                this.stopBot?.();
            }
            return false;
        } finally {
            clearInterval(timer);
            if (this.abort === controller) this.abort = undefined;
        }
    }
}
export const builderDemoPause = new BuilderDemoPause();
