import { legResult, pairResult, HedgingLeg } from '../higher-lower-results';
const leg = (profit: number): HedgingLeg => ({ type: 'HIGHER', status: 'settled', profit });
it.each([
    [[leg(55), leg(55)], 'Both won'],
    [[leg(-35), leg(-35)], 'Both lost'],
    [[leg(55), leg(-35)], 'One won / one lost'],
    [[leg(0), leg(0)], 'Both refunded'],
    [[leg(55), leg(0)], 'Refunded leg'],
    [[leg(55), { type: 'LOWER', status: 'rejected' }], 'Partial purchase'],
    [[leg(55), { type: 'LOWER', status: 'unknown' }], 'Unconfirmed pair'],
    [[leg(55), { type: 'LOWER', status: 'open' }], 'In progress'],
] as [HedgingLeg[], string][])('reports actual leg outcomes: %s', (legs, expected) => {
    expect(pairResult(legs)).toBe(expected);
});
it('does not label a missing settlement profit as a win, loss or refund', () => {
    expect(legResult({ type: 'HIGHER', status: 'settled' })).toBe('Unconfirmed');
});
