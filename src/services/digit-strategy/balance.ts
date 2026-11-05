type Sender = (request: Record<string, unknown>) => Promise<Record<string, any>>;
export class TradingBalanceError extends Error {
    error: { code: string; message: string };
    constructor(
        public code: 'InsufficientBalance' | 'BalanceUnavailable',
        message: string
    ) {
        super(message);
        this.name = 'TradingBalanceError';
        this.error = { code, message };
    }
}
// Read Deriv's current account balance, never a cached login/menu balance.
export async function checkTradingBalance(send: Sender, currency: string, required: number) {
    if (!Number.isFinite(required) || required < 0 || !currency)
        throw new TradingBalanceError(
            'BalanceUnavailable',
            'Cannot verify the trade amount or account currency. No trade was sent.'
        );
    let response;
    try {
        response = await send({ balance: 1 });
    } catch {
        throw new TradingBalanceError(
            'BalanceUnavailable',
            'Unable to verify available balance. Reconnect before trading.'
        );
    }
    const balance = response?.balance;
    const available = balance?.balance;
    if (
        response?.error ||
        typeof available !== 'number' ||
        !Number.isFinite(available) ||
        balance.currency !== currency
    )
        throw new TradingBalanceError(
            'BalanceUnavailable',
            'Unable to verify available balance for the selected currency. No trade was sent.'
        );
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(available), required);
    if (available <= 0 || available + tolerance < required) {
        const format = (value: number) =>
            value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
        throw new TradingBalanceError(
            'InsufficientBalance',
            `Insufficient balance: available ${currency} ${format(available)}${required > 0 ? `; required ${currency} ${format(required)}` : '; a positive balance is required'}. Trading stopped.`
        );
    }
    return available;
}
