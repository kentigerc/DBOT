export type DerivAccount = {
    account_id: string;
    account_type: 'demo' | 'real';
    currency: string;
    balance: number;
    status: string;
};
export type DerivSession = { authenticated: boolean; accounts: DerivAccount[] };
let current: DerivSession = { authenticated: false, accounts: [] };
let pending: Promise<DerivSession> | undefined;
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
    const result = await response.json();
    if (!response.ok) {
        if (response.status === 401) {
            current = { authenticated: false, accounts: [] };
            window.dispatchEvent(new Event('neto-session'));
        }
        throw new Error(result.error || 'Unable to connect to Deriv.');
    }
    return result;
}
export function refreshDerivSession() {
    if (!pending)
        pending = sessionRequest('/api/session')
            .then((data: DerivSession) => {
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
