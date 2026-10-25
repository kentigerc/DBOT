import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import { scannerExitGuard } from '@/utils/scanner-exit-guard';
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import APIMiddleware from './api-middleware';
import { NewApiTransport } from './new-api-transport';

export const generateDerivApiInstance = async ({ publicOnly = false } = {}) => {
    const account = publicOnly ? undefined : getDerivAccount();
    const url = new URL('/api/socket', window.location.origin);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (account) url.searchParams.set('account_id', account.account_id);
    return new DerivAPIBasic({
        connection: new NewApiTransport(url.toString(), account?.account_id, account ? scannerExitGuard : undefined),
        middleware: new APIMiddleware({}),
    });
};
export const getLoginId = () => getDerivAccount()?.account_id || null;
// Legacy code uses this as a login marker. It is never sent as an authorization token.
export const V2GetActiveToken = () =>
    getDerivSession().authenticated && getDerivAccount() ? 'neto-server-session' : null;
export const V2GetActiveClientId = getLoginId;
export const getToken = () => ({ account_id: getLoginId(), token: undefined });
