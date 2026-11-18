import type { ProposalOpenContract } from '@deriv/api-types';
export type HedgingLeg = {
    type: string;
    id?: number;
    status: string;
    profit?: number;
    buyPrice?: number;
    payout?: number;
    contract?: Partial<ProposalOpenContract>;
    tickCount?: number;
    currentTick?: number;
};
export function legResult(leg: HedgingLeg) {
    if (leg.status === 'rejected') return 'Not purchased';
    if (leg.status === 'unknown') return 'Unconfirmed';
    if (leg.status === 'intent') return 'Submitting';
    if (leg.status !== 'settled') return 'Open';
    if (leg.profit === undefined || !Number.isFinite(leg.profit)) return 'Unconfirmed';
    return leg.profit > 0 ? 'Won' : leg.profit < 0 ? 'Lost' : 'Refunded';
}
export function pairResult(legs: HedgingLeg[]) {
    const results = legs.map(legResult);
    if (results.includes('Not purchased')) return 'Partial purchase';
    if (results.includes('Unconfirmed')) return 'Unconfirmed pair';
    if (results.length !== 2 || results.some(r => ['Open', 'Submitting'].includes(r))) return 'In progress';
    if (results.every(r => r === 'Won')) return 'Both won';
    if (results.every(r => r === 'Lost')) return 'Both lost';
    if (results.every(r => r === 'Refunded')) return 'Both refunded';
    if (results.includes('Refunded')) return 'Refunded leg';
    return 'One won / one lost';
}
