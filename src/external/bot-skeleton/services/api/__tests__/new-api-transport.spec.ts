import { fromNewApiResponse, toNewApiRequest } from '../new-api-transport';

describe('new Deriv API wire compatibility', () => {
    it('translates direct buys without mutating the bot trade options', () => {
        const original = {
            buy: 1,
            price: 10,
            parameters: { amount: 10, symbol: 'R_100', basis: 'stake', currency: 'USD', contract_type: 'DIGITEVEN' },
        };
        const request = toNewApiRequest(original);
        expect(request.parameters.underlying_symbol).toBe('R_100');
        expect(request.parameters.symbol).toBeUndefined();
        expect(original.parameters.symbol).toBe('R_100');
        expect(request.price).toBe(10);
        expect(request.parameters.contract_type).toBe('DIGITEVEN');
    });
    it('rejects unsupported trade timing instead of silently changing the strategy', () => {
        expect(() => toNewApiRequest({ proposal: 1, symbol: 'R_100', date_start: 12345 })).toThrow(/date_start/);
    });
    it('requests account-scoped balances and removes obsolete symbol filters', () => {
        expect(toNewApiRequest({ balance: 1, subscribe: 1, account: 'all', loginid: 'DOT100' })).toEqual({
            balance: 1,
            subscribe: 1,
        });
        expect(toNewApiRequest({ contracts_for: 'R_100', currency: 'USD', product_type: 'basic' })).toEqual({
            contracts_for: 'R_100',
        });
    });
    it('restores symbol identifiers for Blockly from the documented new response', () => {
        const data = fromNewApiResponse({
            active_symbols: [
                {
                    underlying_symbol: 'R_100',
                    underlying_symbol_name: 'Volatility 100 Index',
                    underlying_symbol_type: 'stockindex',
                    pip_size: 0.01,
                    market: 'synthetic_index',
                    submarket: 'random_index',
                },
            ],
        });
        expect(data.active_symbols[0]).toMatchObject({
            symbol: 'R_100',
            display_name: 'Volatility 100 Index',
            pip: 0.01,
            market_display_name: 'synthetic index',
        });
    });
    it('preserves request identity when new responses omit echo_req and passthrough', () => {
        const request = {
            proposal: 1,
            symbol: 'R_100',
            passthrough: { purchase_reference: 'a', contract_type: 'CALL' },
        };
        expect(
            fromNewApiResponse({ proposal: { id: 'quote', ask_price: '10.50' }, msg_type: 'proposal' }, request)
        ).toMatchObject({
            echo_req: request,
            passthrough: request.passthrough,
            proposal: { id: 'quote', ask_price: 10.5 },
        });
    });
    it('handles new string amounts and exit fields without inventing absent prices', () => {
        const response = fromNewApiResponse({
            proposal_open_contract: { payout: '12.50', profit: '-10.00', exit_spot: 123.45, exit_spot_time: 12345 },
        });
        expect(response.proposal_open_contract).toMatchObject({
            payout: 12.5,
            profit: -10,
            sell_spot: 123.45,
            sell_spot_time: 12345,
        });
        expect(fromNewApiResponse({ proposal: { id: 'quote' } }).proposal.ask_price).toBeUndefined();
    });
});
