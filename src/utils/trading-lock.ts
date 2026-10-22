import { getDerivAccount, sessionRequest } from './deriv-session';
let analysisLocked = false;
export const isAnalysisTrading = () => {
    if (analysisLocked) return true;
    try {
        const account = localStorage.getItem('neto.account_id');
        const saved = account && localStorage.getItem(`neto.digit-strategy.v1.${account}`);
        const state = saved ? JSON.parse(saved) : null;
        return !!state?.pending || Number(state?.liveUntil) > Date.now();
    } catch {
        return analysisLocked;
    }
};
export function setAnalysisTrading(value: boolean) {
    analysisLocked = value;
    window.dispatchEvent(new Event('neto-trading-lock'));
}

export async function checkServerAnalysis() {
    const account = getDerivAccount();
    if (!account) return false;
    const state = await sessionRequest(`/api/analysis?account_id=${encodeURIComponent(account.account_id)}`);
    const locked = !!(state.active || state.starting || state.pending);
    setAnalysisTrading(locked);
    return locked;
}
