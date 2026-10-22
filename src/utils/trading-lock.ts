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
