import { getDerivAccount, getDerivSession, refreshDerivSession } from '@/utils/deriv-session';
import CommonStore from '@/stores/common-store';
import { TAuthData } from '@/types/api-types';
import { observer as globalObserver } from '../../utils/observer';
import { doUntilDone, socket_state } from '../tradeEngine/utils/helpers';
import {
    CONNECTION_STATUS,
    setAccountList,
    setAuthData,
    setConnectionStatus,
    setIsAuthorized,
    setIsAuthorizing,
} from './observables/connection-status-stream';
import ApiHelpers from './api-helpers';
import { generateDerivApiInstance, V2GetActiveClientId, V2GetActiveToken } from './appId';
import chart_api from './chart-api';

type CurrentSubscription = {
    id: string;
    unsubscribe: () => void;
};

type SubscriptionPromise = Promise<{
    subscription: CurrentSubscription;
}>;

type TApiBaseApi = {
    connection: {
        readyState: keyof typeof socket_state;
        addEventListener: (event: string, callback: () => void) => void;
        removeEventListener: (event: string, callback: () => void) => void;
    };
    send: (data: unknown) => void;
    disconnect: () => void;
    authorize: (token: string) => Promise<{ authorize: TAuthData; error: unknown }>;
    getSelfExclusion: () => Promise<unknown>;
    onMessage: () => {
        subscribe: (callback: (message: unknown) => void) => {
            unsubscribe: () => void;
        };
    };
} & Awaited<ReturnType<typeof generateDerivApiInstance>>;

class APIBase {
    api: TApiBaseApi | null = null;
    token: string = '';
    account_id: string = '';
    pip_sizes = {};
    account_info = {};
    is_running = false;
    subscriptions: CurrentSubscription[] = [];
    time_interval: ReturnType<typeof setInterval> | null = null;
    has_active_symbols = false;
    is_stopping = false;
    active_symbols = [];
    current_auth_subscriptions: SubscriptionPromise[] = [];
    is_authorized = false;
    active_symbols_promise: Promise<void> | null = null;
    common_store: CommonStore | undefined;
    landing_company: string | null = null;
    reconnect_timer: ReturnType<typeof setTimeout> | null = null;
    reconnect_delay = 1000;
    stopping = false;

    unsubscribeAllSubscriptions = () => {
        this.current_auth_subscriptions?.forEach(subscription_promise => {
            subscription_promise.then(({ subscription }) => {
                if (subscription?.id) {
                    this.api?.send({
                        forget: subscription.id,
                    });
                }
            });
        });
        this.current_auth_subscriptions = [];
    };

    onsocketopen = () => {
        this.reconnect_delay = 1000;
        setConnectionStatus(CONNECTION_STATUS.OPENED);
    };

    onsocketclose = () => {
        setConnectionStatus(CONNECTION_STATUS.CLOSED);
        setIsAuthorized(false);
        this.is_authorized = false;
        if (this.is_running) globalObserver.emit('Error', new Error('Deriv disconnected. Check your account before restarting the bot.'));
        if (!this.stopping) this.reconnectIfNotConnected();
    };

    async init(force_create_connection = false) {
        this.stopping = false;
        this.toggleRunButton(true);
        await refreshDerivSession();

        if (this.api) {
            this.unsubscribeAllSubscriptions();
        }

        if (!this.api || this.api?.connection.readyState !== 1 || force_create_connection) {
            if (this.api?.connection) {
                ApiHelpers.disposeInstance();
                setConnectionStatus(CONNECTION_STATUS.CLOSED);
                this.api.connection.removeEventListener('open', this.onsocketopen);
                this.api.connection.removeEventListener('close', this.onsocketclose);
                this.api.disconnect();
            }

            this.api = await generateDerivApiInstance();
            this.api?.connection.addEventListener('open', this.onsocketopen);
            this.api?.connection.addEventListener('close', this.onsocketclose);
        }

        if (!this.has_active_symbols && !V2GetActiveToken()) {
            this.active_symbols_promise = this.getActiveSymbols();
        }

        this.initEventListeners();

        if (this.time_interval) clearInterval(this.time_interval);
        this.time_interval = null;

        if (V2GetActiveToken()) {
            setIsAuthorizing(true);
            await this.authorizeAndSubscribe();
        }

        chart_api.init(force_create_connection);
    }

    getConnectionStatus() {
        if (this.api?.connection) {
            const ready_state = this.api.connection.readyState;
            return socket_state[ready_state as keyof typeof socket_state] || 'Unknown';
        }
        return 'Socket not initialized';
    }

    terminate() {
        this.stopping = true;
        if (this.reconnect_timer) clearTimeout(this.reconnect_timer);
        this.reconnect_timer = null;
        // eslint-disable-next-line no-console
        if (this.api) this.api.disconnect();
    }

    initEventListeners() {
        if (window) {
            window.addEventListener('online', this.reconnectIfNotConnected);
            window.addEventListener('focus', this.reconnectIfNotConnected);
        }
    }

    async createNewInstance(account_id: string) {
        if (this.account_id !== account_id) {
            await this.init();
        }
    }

    reconnectIfNotConnected = () => {
        if (this.stopping || this.reconnect_timer) return;
        if (this.api?.connection?.readyState && this.api.connection.readyState > 1) {
            this.reconnect_timer = setTimeout(() => {
                this.reconnect_timer = null;
                this.init(true).catch(error => globalObserver.emit('Error', error));
            }, this.reconnect_delay);
            this.reconnect_delay = Math.min(this.reconnect_delay * 2, 30000);
        }
    };

    async authorizeAndSubscribe() {
        const token = V2GetActiveToken();
        if (!token || !this.api) return;
        this.token = token;
        this.account_id = V2GetActiveClientId() ?? '';
        setIsAuthorizing(true);
        setIsAuthorized(false);

        try {
            const connection = this.api.connection;
            if (connection.readyState !== 1) await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => finish(new Error('Deriv connection timed out.')), 15000);
                const finish = (error?: Error) => {
                    clearTimeout(timer);
                    connection.removeEventListener('open', opened);
                    connection.removeEventListener('error', failed);
                    connection.removeEventListener('close', failed);
                    if (error) reject(error); else resolve();
                };
                const opened = () => finish();
                const failed = () => finish(new Error('Unable to open the Deriv account connection.'));
                connection.addEventListener('open', opened);
                connection.addEventListener('error', failed);
                connection.addEventListener('close', failed);
            });
            const account = getDerivAccount();
            if (!account) throw new Error('No active Deriv account.');
            const authorize = {
                loginid: account.account_id, currency: account.currency, balance: Number(account.balance),
                account_list: getDerivSession().accounts.map(item => ({
                    loginid: item.account_id, currency: item.currency,
                    is_virtual: item.account_type === 'demo' ? 1 : 0,
                    is_disabled: item.status === 'active' ? 0 : 1,
                })),
            } as TAuthData;
            this.account_info = authorize;
            setAccountList(authorize?.account_list || []);
            setAuthData(authorize);
            setIsAuthorized(true);
            this.is_authorized = true;
            localStorage.setItem('client_account_details', JSON.stringify(authorize?.account_list));


            if (this.has_active_symbols) {
                this.toggleRunButton(false);
            } else {
                this.active_symbols_promise = this.getActiveSymbols();
            }
            await this.subscribe();
            // this.getSelfExclusion(); commented this so we dont call it from two places
        } catch (e) {
            console.error('Authorization failed:', e);
            this.is_authorized = false;

            setIsAuthorized(false);
            globalObserver.emit('Error', e);
        } finally {
            setIsAuthorizing(false);
        }
    }

    async getSelfExclusion() {
        if (!this.api || !this.is_authorized) return;
        await this.api.getSelfExclusion();
        // TODO: fix self exclusion
    }

    async subscribe() {
        const subscribeToStream = (streamName: string) => {
            return doUntilDone(
                () => {
                    const subscription = this.api?.send({
                        [streamName]: 1,
                        subscribe: 1,

                    });
                    if (subscription) {
                        this.current_auth_subscriptions.push(subscription);
                    }
                    return subscription;
                },
                [],
                this
            );
        };

        const streamsToSubscribe = ['balance', 'transaction', 'proposal_open_contract'];

        await Promise.all(streamsToSubscribe.map(subscribeToStream));
    }

    getActiveSymbols = async () => {
        await doUntilDone(() => this.api?.send({ active_symbols: 'brief' }), [], this).then(
            ({ active_symbols = [], error = {} }) => {
                const pip_sizes = {};
                if (active_symbols.length) this.has_active_symbols = true;
                active_symbols.forEach(({ symbol, pip }: { symbol: string; pip: string }) => {
                    (pip_sizes as Record<string, number>)[symbol] = +(+pip).toExponential().substring(3);
                });
                this.pip_sizes = pip_sizes as Record<string, number>;
                this.toggleRunButton(false);
                this.active_symbols = active_symbols;
                return active_symbols || error;
            }
        );
    };

    toggleRunButton = (toggle: boolean) => {
        const run_button = document.querySelector('#db-animation__run-button');
        if (!run_button) return;
        (run_button as HTMLButtonElement).disabled = toggle;
    };

    setIsRunning(toggle = false) {
        this.is_running = toggle;
    }

    pushSubscription(subscription: CurrentSubscription) {
        this.subscriptions.push(subscription);
    }

    clearSubscriptions() {
        this.subscriptions.forEach(s => s.unsubscribe());
        this.subscriptions = [];

        // Resetting timeout resolvers
        const global_timeouts = globalObserver.getState('global_timeouts') ?? [];

        global_timeouts.forEach((_: unknown, i: number) => {
            clearTimeout(i);
        });
    }
}

export const api_base = new APIBase();
