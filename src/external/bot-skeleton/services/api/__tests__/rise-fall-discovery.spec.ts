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

it('lists only the Up/Down families advertised for each market', async () => {
    const quoted = (contract_type: string) => ({
        contract_type,
        min_contract_duration: '1t',
        max_contract_duration: '10t',
    });
    (api_base.api.send as jest.Mock).mockImplementation(async ({ contracts_for }) => ({
        contracts_for: {
            available: (contracts_for === 'R_100'
                ? ['CALL', 'PUT', 'CALLE', 'PUTE', 'HIGHER', 'LOWER']
                : ['CALL', 'PUT']
            ).map(quoted),
        },
    }));
    const discovery = new ContractsFor({ ws: undefined, server_time: { unix: () => 0 } });
    const types = (symbol: string) => discovery.getTradeTypes('synthetic_index', 'random_index', symbol, 'callput');
    expect((await types('R_100')).map(([, id]) => id)).toEqual(['callput', 'callputequal', 'higherlower']);
    expect((await types('1HZ75V')).map(([, id]) => id)).toEqual(['callput']);
});

it('releases concurrent discovery requests on an error and allows a later retry', async () => {
    const send = api_base.api.send as jest.Mock;
    send.mockReset()
        .mockResolvedValueOnce({ error: { code: 'RateLimit' } })
        .mockResolvedValueOnce({
            contracts_for: { available: [{ contract_type: 'CALL' }] },
        });
    const discovery = new ContractsFor({ ws: undefined, server_time: { unix: () => 0 } });
    await expect(Promise.all([discovery.getContractsFor('R_50'), discovery.getContractsFor('R_50')])).resolves.toEqual([
        [],
        [],
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(discovery.getContractsFor('R_50')).resolves.toEqual([
        { contract_type: 'CALL', contract_category: 'callput' },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
});
