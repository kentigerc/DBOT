// Override only the market fields in hosted XML; retain protection and strategy blocks.
export function hostedBotMarket(content: string, symbol?: string, submarket = 'random_index') {
    if (symbol === undefined) return content;
    if (!/^(R_\d+|1HZ\d+V)$/.test(symbol) || !/^[a-z0-9_]+$/.test(submarket))
        throw new Error('Invalid scanner market selection.');
    const document = new DOMParser().parseFromString(content, 'text/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid bot XML.');
    const markets = document.querySelectorAll('block[type="trade_definition_market"]');
    if (!markets.length) throw new Error('This bot does not support a scanner market selection.');
    markets.forEach(block => {
        const values: Record<string, string> = {
            MARKET_LIST: 'synthetic_index',
            SUBMARKET_LIST: submarket,
            SYMBOL_LIST: symbol,
        };
        Object.entries(values).forEach(([name, value]) => {
            const field = Array.from(block.children).find(
                child => child.localName === 'field' && child.getAttribute('name') === name
            );
            if (!field) throw new Error('This bot has incomplete market settings.');
            field.textContent = value;
        });
    });
    return new XMLSerializer().serializeToString(document);
}
