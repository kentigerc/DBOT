jest.mock('@/components/shared', () => ({
    isEmptyObject: (value: unknown) => !value || Object.keys(value as object).length === 0,
}));
jest.mock('@/external/bot-skeleton/constants', () => ({ config: () => ({}) }));
jest.mock('@/external/bot-skeleton/utils/observer', () => ({ observer: { emit: jest.fn() } }));
jest.mock('@/external/bot-skeleton/services/tradeEngine/utils/broadcast', () => ({ error: jest.fn() }));
import { tradeOptionToBuy, tradeOptionToProposal } from '@/external/bot-skeleton/services/tradeEngine/utils/helpers';
const options = {
    symbol: 'R_100',
    amount: 0.35,
    basis: 'stake',
    currency: 'USD',
    duration: 1,
    duration_unit: 't',
    prediction: 0,
};
it('sends Over 0 as a digit barrier without the unrelated selected_tick parameter', () => {
    expect(tradeOptionToBuy('DIGITOVER', options).parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: 0 });
    expect(tradeOptionToBuy('DIGITOVER', options).parameters).not.toHaveProperty('selected_tick');
    expect(tradeOptionToProposal({ ...options, contractTypes: ['DIGITOVER'] }, 'fixture')[0]).toMatchObject({
        barrier: 0,
    });
    expect(tradeOptionToProposal({ ...options, contractTypes: ['DIGITOVER'] }, 'fixture')[0]).not.toHaveProperty(
        'selected_tick'
    );
});
it('preserves tick selection for Tick High/Low contracts and omits a digit barrier', () => {
    const buy = tradeOptionToBuy('TICKHIGH', { ...options, prediction: 2 });
    expect(buy.parameters).toHaveProperty('selected_tick', 2);
    expect(buy.parameters).not.toHaveProperty('barrier');
    const proposal = tradeOptionToProposal({ ...options, prediction: 2, contractTypes: ['TICKLOW'] }, 'fixture')[0];
    expect(proposal.selected_tick).toBe(2);
    expect(proposal).not.toHaveProperty('barrier');
});
