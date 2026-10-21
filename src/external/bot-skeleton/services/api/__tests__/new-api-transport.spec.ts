import { fromNewApiResponse, toNewApiRequest } from '../new-api-transport';

describe('new Deriv API wire compatibility', () => {
    it('restores chart trading-time identifiers and empty holidays without changing market schedules', () => {
        const times = { open: ['00:00:00'], close: ['23:59:59'] };
        const events = [{ dates: '2026-12-25', descrip: 'Christmas Day' }];
        const original = {
            trading_times: {
                markets: [
                    {
                        name: 'Markets',
                        submarkets: [
                            {
                                symbols: [
                                    { underlying_symbol: 'R_100', times, trading_days: ['Mon', 'Tue'] },
                                    { underlying_symbol: 'frxEURUSD', times, events },
                                ],
                            },
                        ],
                    },
                ],
            },
        };
        const symbols = fromNewApiResponse(original).trading_times.markets[0].submarkets[0].symbols;
        expect(symbols[0]).toMatchObject({ symbol: 'R_100', events: [], times, trading_days: ['Mon', 'Tue'] });
        expect(symbols[1]).toMatchObject({ symbol: 'frxEURUSD', events, times });
        expect(original.trading_times.markets[0].submarkets[0].symbols[0]).not.toHaveProperty('events');
    });
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
    it('populates transaction display fields from numeric contract ticks', () => {
        const data = {
            proposal_open_contract: { entry_tick: 123.45, entry_tick_time: 100, exit_tick: 124.5, exit_tick_time: 105 },
        };
        expect(fromNewApiResponse(data).proposal_open_contract).toMatchObject({
            entry_tick_display_value: '123.45',
            entry_spot: 123.45,
            exit_tick_display_value: '124.5',
            exit_spot: 124.5,
            entry_tick_time: 100,
            exit_tick_time: 105,
        });
        expect(data.proposal_open_contract).not.toHaveProperty('entry_tick_display_value');
    });
    it('maps spot aliases to engine ticks while preserving supplied display precision', () => {
        expect(
            fromNewApiResponse({
                proposal_open_contract: {
                    entry_spot: '123.450',
                    entry_spot_time: 100,
                    exit_spot: '124.500',
                    exit_spot_time: 105,
                },
            }).proposal_open_contract
        ).toMatchObject({
            entry_tick: 123.45,
            entry_tick_display_value: '123.450',
            entry_tick_time: 100,
            exit_tick: 124.5,
            exit_tick_display_value: '124.500',
            exit_tick_time: 105,
        });
        expect(
            fromNewApiResponse({
                proposal_open_contract: {
                    entry_tick: 123.45,
                    entry_tick_display_value: '123.4500',
                },
            }).proposal_open_contract.entry_tick_display_value
        ).toBe('123.4500');
    });
    it('keeps pending entry and exit spots empty instead of using the current market price', () => {
        const contract = fromNewApiResponse({
            proposal_open_contract: { entry_tick: null, exit_spot: null, current_spot: '123.45' },
        }).proposal_open_contract;
        expect(contract.entry_tick_display_value).toBeUndefined();
        expect(contract.exit_tick_display_value).toBeUndefined();
        expect(contract.current_spot).toBe(123.45);
    });
});
