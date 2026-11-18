import type { TContractInfo } from '@/components/summary/summary-card.types';
import type { Snapshot } from './higher-lower-builder';

// Only confirmed contract IDs become transaction rows. Broker references remain real.
export function higherLowerTransactions(state: Snapshot, accountId?: string): TContractInfo[] {
    if (!accountId || state.accountId !== accountId) return [];
    const rows = new Map<number, TContractInfo>();
    const pairs = [...(state.history || [])].reverse();
    if (state.pending) pairs.push(state.pending as (typeof pairs)[number]);
    for (const pair of pairs)
        for (const leg of pair.legs) {
            if (!leg.id || !Number.isSafeInteger(leg.id) || !['open', 'settled'].includes(leg.status)) continue;
            const settled = leg.status === 'settled' && Number.isFinite(leg.profit);
            const row = {
                ...leg.contract,
                contract_id: leg.id,
                contract_type: ['HIGHER', 'CALL'].includes(leg.type) ? 'CALL' : 'PUT',
                underlying: pair.symbol,
                currency: 'USD',
                status: settled ? (leg.profit! > 0 ? 'won' : leg.profit! < 0 ? 'lost' : 'sold') : 'open',
                is_sold: settled ? 1 : 0,
                is_completed: settled,
                profit: settled ? leg.profit! / 100 : 0,
                buy_price: leg.buyPrice === undefined ? leg.contract?.buy_price : leg.buyPrice / 100,
                sell_price: leg.payout === undefined ? undefined : leg.payout / 100,
                payout: leg.payout === undefined ? undefined : leg.payout / 100,
                tick_count: leg.tickCount || leg.contract?.tick_count,
                run_id: `higher-lower:${pair.at || 0}:${pair.symbol}`,
            } as TContractInfo;
            const previous = rows.get(leg.id);
            if (!previous?.is_completed || settled) rows.set(leg.id, row);
        }
    return [...rows.values()];
}
