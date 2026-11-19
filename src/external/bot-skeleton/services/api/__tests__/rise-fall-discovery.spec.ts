import ContractsFor from '../contracts-for';
import { api_base } from '../api-base';

jest.mock('../api-base', () => ({ api_base: { api: { send: jest.fn() } } }));
jest.mock('@deriv-com/translations', () => ({ localize: (value: string) => value }));

it('offers Rise/Fall for advertised CALL and PUT with sparse metadata', async () => {
    (api_base.api.send as jest.Mock).mockResolvedValue({
        contracts_for: {
            available: ['CALL', 'PUT'].map(contract_type => ({
                contract_type,
                min_contract_duration: '1t',
                max_contract_duration: '10t',
            })),
        },
    });
    const discovery = new ContractsFor({ ws: undefined, server_time: { unix: () => 0 } });
    await expect(
        discovery.getTradeTypeByTradeCategory('synthetic_index', 'random_index', '1HZ10V', 'callput')
    ).resolves.toEqual([{ name: 'Rise/Fall', value: 'callput', icon: ['CALL', 'PUT'] }]);
    expect(
        discovery.matchesBarrierCategory(
            { contract_category: 'callput', contract_type: 'CALL', barrier: '+1' },
            'euro_atm'
        )
    ).toBe(false);
});
