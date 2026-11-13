export type DerivAccount = {
    account_id: string;
    account_type: 'demo' | 'real';
    currency: string;
    balance: number;
    status: string;
};
export type DerivSession = {
    authenticated: boolean;
    accounts: DerivAccount[];
    termsAccepted?: boolean;
    termsVersion?: string;
    isAdmin?: boolean;
    adminAccounts?: string[];
};
let current: DerivSession = { authenticated: false, accounts: [] };
let pending: Promise<DerivSession> | undefined;
let sessionRetryUntil = 0;
class SessionRequestError extends Error {
    constructor(
        message: string,
        public status: number,
        public retryAfter = 0
    ) {
        super(message);
    }
}
export const getDerivSession = () => current;
export const getDerivAccount = () =>
    current.accounts.find(account => account.account_id === localStorage.getItem('neto.account_id'));
export const startDerivLogin = () => window.location.assign('/api/auth/login');

export async function sessionRequest(path: string, body?: unknown) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body === undefined
            ? {}
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let result;
    try {
        result = await response.json();
    } catch {
        if (response.ok) throw new Error('NetoAcademy returned an unexpected response. Please refresh and try again.');
    }
    if (!response.ok) {
        if (response.status === 401) {
            current = { authenticated: false, accounts: [] };
            window.dispatchEvent(new Event('neto-session'));
        }
        const retryHeader = response.headers?.get('Retry-After');
        const suggestedDelay =
            Number(result?.retryAfter) ||
            (retryHeader && /^\d+$/.test(retryHeader)
                ? Number(retryHeader)
                : Math.ceil((Date.parse(retryHeader || '') - Date.now()) / 1000));
        const retryAfter =
            response.status === 429
                ? Math.min(86400, Math.max(1, Number.isFinite(suggestedDelay) ? suggestedDelay : 30))
                : 0;
        throw new SessionRequestError(
            typeof result?.error === 'string'
                ? result.error
                : `NetoAcademy returned HTTP ${response.status}. Please try again shortly.`,
            response.status,
            retryAfter
        );
    }
    return result;
}
export function refreshDerivSession() {
    if (sessionRetryUntil > Date.now()) {
        const seconds = Math.max(1, Math.ceil((sessionRetryUntil - Date.now()) / 1000));
        return Promise.reject(
            new SessionRequestError(
                `Deriv has temporarily limited requests. Please wait ${seconds} seconds before trying again.`,
                429,
                seconds
            )
        );
    }
    if (!pending)
        pending = sessionRequest('/api/session')
            .then((data: DerivSession) => {
                sessionRetryUntil = 0;
                current = data;
                const available = data.accounts.filter(account => account.status === 'active');
                if (!available.some(account => account.account_id === localStorage.getItem('neto.account_id'))) {
                    const preferred = available.find(account => account.account_type === 'demo') || available[0];
                    if (preferred) localStorage.setItem('neto.account_id', preferred.account_id);
                    else localStorage.removeItem('neto.account_id');
                }
                window.dispatchEvent(new Event('neto-session'));
                return data;
            })
            .catch(reason => {
                if (reason instanceof SessionRequestError && reason.status === 429)
                    sessionRetryUntil = Date.now() + reason.retryAfter * 1000;
                throw reason;
            })
            .finally(() => {
                pending = undefined;
            });
    return pending;
}
export async function logoutDerivSession() {
    await sessionRequest('/api/auth/logout', {});
    current = { authenticated: false, accounts: [] };
    localStorage.removeItem('neto.account_id');
    for (const name of ['authToken', 'accountsList', 'clientAccounts', 'callback_token', 'active_loginid'])
        localStorage.removeItem(name);
    window.location.assign('/');
}
