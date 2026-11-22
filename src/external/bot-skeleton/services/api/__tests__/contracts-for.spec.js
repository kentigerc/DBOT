import ContractsFor from '../contracts-for';

jest.mock('../api-base', () => ({ api_base: {} }));
jest.mock('../../../scratch/utils/multiplier-utils', () => ({ isMultipliersAvailable: () => false }));

const market = 'synthetic_index';
const submarket = 'random_index';
const symbol = '1HZ10V';
const tick_contract = {
    contract_category: 'callput',
    expiry_type: 'tick',
    min_contract_duration: '1t',
    max_contract_duration: '10t',
};

function makeContractsFor(contracts) {
    const contractsFor = new ContractsFor({ server_time: { unix: () => 0 } });
    contractsFor.contracts_for[symbol] = { contracts, timestamp: 0 };
    return contractsFor;
}

it.each([undefined, 0, 1, '1'])('offers Rise/Fall and Higher/Lower independently with barrier count %s', async barriers => {
    const contractsFor = makeContractsFor([
        { ...tick_contract, contract_type: 'CALL', barriers },
        { ...tick_contract, contract_type: 'PUT', barriers },
        { ...tick_contract, contract_type: 'HIGHER', min_contract_duration: '5t' },
        { ...tick_contract, contract_type: 'LOWER', min_contract_duration: '5t' },
    ]);

    const trade_types = await contractsFor.getTradeTypes(market, submarket, symbol, 'callput');
    expect(trade_types.map(([, value]) => value)).toEqual(['callput', 'higherlower']);
    await expect(contractsFor.getDurations(symbol, 'callput')).resolves.toMatchObject([{ unit: 't', min: 1 }]);
    await expect(contractsFor.getDurations(symbol, 'higherlower')).resolves.toMatchObject([{ unit: 't', min: 5 }]);
});

it('keeps barrier-based CALL/PUT and Rise Equals/Fall Equals out of ordinary Rise/Fall', async () => {
    const contractsFor = makeContractsFor([
        { ...tick_contract, contract_type: 'CALL', barrier: '+0.2' },
        { ...tick_contract, contract_type: 'PUT', barriers: 1, barrier_category: 'euro_non_atm' },
        { ...tick_contract, contract_type: 'CALLE', barriers: 0 },
        { ...tick_contract, contract_type: 'PUTE', barrier_category: 'euro_atm' },
    ]);

    const trade_types = await contractsFor.getTradeTypes(market, submarket, symbol, 'callput');
    expect(trade_types.map(([, value]) => value)).toEqual(['callputequal', 'higherlower']);
});
