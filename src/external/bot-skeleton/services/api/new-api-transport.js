// Wire changes documented at developers.deriv.com/comparison.
export function toNewApiRequest(original) {
    const request = { ...original };
    delete request.loginid;
    if (request.balance) delete request.account;
    if (request.active_symbols || request.contracts_for) {
        for (const key of ['landing_company', 'landing_company_short', 'product_type', 'barrier_category'])
            delete request[key];
        if (request.contracts_for) delete request.currency;
    }
    if (request.proposal || request.parameters) {
        const parameters = request.parameters ? { ...request.parameters } : request;
        if (parameters.symbol !== undefined) {
            parameters.underlying_symbol = parameters.symbol;
            delete parameters.symbol;
        }
        for (const key of ['barrier_range', 'date_start', 'trade_risk_profile', 'trading_period_start']) {
            if (parameters[key] !== undefined)
                throw new Error(`This bot uses ${key}, which the new Deriv API does not support.`);
        }
        delete parameters.product_type;
        if (request.parameters) request.parameters = parameters;
    }
    return request;
}
export function fromNewApiResponse(data, original, accountId) {
    const response = { ...data };
    if (original) response.echo_req = original;
    if (!response.passthrough && original?.passthrough) response.passthrough = original.passthrough;
    if (Array.isArray(response.active_symbols))
        response.active_symbols = response.active_symbols.map(symbol => ({
            ...symbol,
            symbol: symbol.underlying_symbol,
            display_name: symbol.underlying_symbol_name,
            symbol_type: symbol.underlying_symbol_type,
            pip: symbol.pip_size,
            market_display_name: symbol.market?.replaceAll('_', ' '),
            submarket_display_name: symbol.submarket?.replaceAll('_', ' '),
            subgroup_display_name: symbol.subgroup?.replaceAll('_', ' '),
        }));
    if (Array.isArray(response.trading_times?.markets))
        response.trading_times = {
            ...response.trading_times,
            markets: response.trading_times.markets.map(market => ({
                ...market,
                submarkets: (market.submarkets || []).map(submarket => ({
                    ...submarket,
                    symbols: (submarket.symbols || []).map(symbol => ({
                        ...symbol,
                        symbol: symbol.underlying_symbol ?? symbol.symbol,
                        // The new API omits events when there are no market holidays.
                        events: symbol.events ?? [],
                    })),
                })),
            })),
        };
    if (response.transaction?.underlying_symbol)
        response.transaction = { ...response.transaction, symbol: response.transaction.underlying_symbol };
    if (response.balance && accountId) response.balance = { ...response.balance, loginid: accountId };
    for (const key of ['proposal', 'proposal_open_contract', 'buy', 'sell']) {
        if (!response[key]) continue;
        response[key] = { ...response[key] };
        for (const field of [
            'ask_price',
            'bid_price',
            'buy_price',
            'sell_price',
            'payout',
            'profit',
            'commission',
            'current_spot',
        ]) {
            const value = response[key][field];
            if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)))
                response[key][field] = Number(value);
        }
        if (key === 'proposal_open_contract') {
            const contract = response[key];
            for (const phase of ['entry', 'exit']) {
                const tick = `${phase}_tick`;
                const spot = `${phase}_spot`;
                const value = contract[tick] ?? contract[spot];
                if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) {
                    // New responses may omit the legacy display fields used by the transaction table.
                    // Preserve server-provided precision; do not invent a spot before Deriv supplies it.
                    const display =
                        contract[`${tick}_display_value`] ?? contract[`${spot}_display_value`] ?? String(value);
                    contract[tick] = Number(value);
                    contract[spot] ??= Number(value);
                    contract[`${tick}_display_value`] = display;
                    contract[`${spot}_display_value`] ??= display;
                }
                contract[`${tick}_time`] ??= contract[`${spot}_time`];
            }
            response[key].sell_spot = response[key].exit_spot ?? response[key].sell_spot;
            response[key].sell_spot_time = response[key].exit_spot_time ?? response[key].sell_spot_time;
        }
    }
    return response;
}
export class NewApiTransport extends EventTarget {
    constructor(url, accountId) {
        super();
        this.socket = new WebSocket(url);
        this.accountId = accountId;
        this.requests = new Map();
        this.streams = new Map();
        for (const type of ['open', 'close', 'error'])
            this.socket.addEventListener(type, event => {
                const forwarded =
                    type === 'close'
                        ? new CloseEvent(type, { code: event.code, reason: event.reason, wasClean: event.wasClean })
                        : new Event(type);
                this.dispatchEvent(forwarded);
                this[`on${type}`]?.(forwarded);
            });
        this.socket.addEventListener('message', event => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            const original = this.requests.get(data.req_id) || this.streams.get(data.subscription?.id);
            if (data.subscription?.id && original) this.streams.set(data.subscription.id, original);
            this.requests.delete(data.req_id);
            const forwarded = new MessageEvent('message', {
                data: JSON.stringify(fromNewApiResponse(data, original, accountId)),
            });
            this.dispatchEvent(forwarded);
            this.onmessage?.(forwarded);
        });
    }
    get readyState() {
        return this.socket.readyState;
    }
    get url() {
        return 'wss://api.derivws.com/trading/v1/options/ws';
    }
    send(value) {
        const original = JSON.parse(value);
        if (original.req_id !== undefined) this.requests.set(original.req_id, original);
        if (original.forget) this.streams.delete(original.forget);
        if (original.forget_all) this.streams.clear();
        this.socket.send(JSON.stringify(toNewApiRequest(original)));
    }
    close(...args) {
        this.requests.clear();
        this.streams.clear();
        this.socket.close(...args);
    }
}
