import { validateXmlAutoSettings, type XmlAutoSettings } from './xml-auto-settings';
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

// Read the hosted XML's existing limits; Auto mode carries them across reloads.
export function hostedBotLimits(content: string) {
    const document = new DOMParser().parseFromString(content, 'text/xml');
    const initialization = document.querySelector('block[type="trade_definition"] > statement[name="INITIALIZATION"]');
    const amount = (name: string) => {
        const assignment = Array.from(initialization?.querySelectorAll('block[type="variables_set"]') || []).find(
            block =>
                Array.from(block.children).some(
                    child =>
                        child.localName === 'field' &&
                        child.getAttribute('name') === 'VAR' &&
                        child.textContent === name
                )
        );
        const value = Number(
            assignment?.querySelector('value[name="VALUE"] > block[type="math_number"] > field[name="NUM"]')
                ?.textContent
        );
        if (!Number.isFinite(value) || value <= 0) throw new Error('XML Auto requires valid profit and loss limits.');
        return Math.round(value * 100);
    };
    return { takeProfit: amount('Expected Profit'), stopLoss: amount('Stop Loss') };
}

export function hostedBotForAuto(content: string, symbol: string, submarket: string, settings?: XmlAutoSettings) {
    const document = new DOMParser().parseFromString(hostedBotMarket(content, symbol, submarket), 'text/xml');
    document.querySelectorAll('block[type="text"] > field[name="TEXT"]').forEach(field => {
        if (/now recovering/i.test(field.textContent || '')) field.textContent = 'Executing recovery.';
    });
    if (settings) {
        const config = validateXmlAutoSettings(settings);
        const values: Record<string, number> = {
            Stake: config.stake,
            'Win Stake': config.stake,
            'Stop Loss': config.stopLoss,
            'Expected Profit': config.takeProfit,
        };
        const initial = document.querySelector('block[type="trade_definition"] > statement[name="INITIALIZATION"]');
        for (const [name, value] of Object.entries(values)) {
            const assignment = Array.from(initial?.querySelectorAll('block[type="variables_set"]') || []).find(block =>
                Array.from(block.children).some(
                    field =>
                        field.localName === 'field' &&
                        field.getAttribute('name') === 'VAR' &&
                        field.textContent === name
                )
            );
            const numeric = assignment?.querySelector(
                'value[name="VALUE"] > block[type="math_number"] > field[name="NUM"]'
            );
            if (!numeric) throw new Error(`The XML bot is missing its ${name} setting.`);
            numeric.textContent = String(value);
            assignment
                ?.querySelectorAll('value[name="VALUE"] > shadow[type="math_number"] > field[name="NUM"]')
                .forEach(field => {
                    field.textContent = String(value);
                });
        }
        let multipliers = 0;
        document.querySelectorAll('block[type="math_arithmetic"]').forEach(block => {
            const operation = Array.from(block.children).find(
                child => child.localName === 'field' && child.getAttribute('name') === 'OP'
            );
            if (
                operation?.textContent !== 'MULTIPLY' ||
                !block.querySelector('block[type="read_details"] > field[name="DETAIL_INDEX"]')
            )
                return;
            block
                .querySelectorAll(
                    'value > block[type="math_number"] > field[name="NUM"], value > shadow[type="math_number"] > field[name="NUM"]'
                )
                .forEach(field => {
                    field.textContent = String(config.multiplier);
                    multipliers++;
                });
        });
        if (!multipliers) throw new Error('The XML bot is missing its recovery multiplier.');
    }
    const purchases = new Set(
        Array.from(document.querySelectorAll('block[type="purchase"] > field[name="PURCHASE_LIST"]')).map(
            field => field.textContent
        )
    );
    // Enable both directions when the XML already contains them (e.g. its recovery).
    // This does not change any purchase block, prediction, stake or recovery logic.
    if (purchases.has('DIGITOVER') && purchases.has('DIGITUNDER')) {
        const field = document.querySelector('block[type="trade_definition_contracttype"] > field[name="TYPE_LIST"]');
        if (field) field.textContent = 'both';
    }
    return new XMLSerializer().serializeToString(document);
}

type ScannerWorkspace = { getAllBlocks: () => { type: string; getFieldValue: (name: string) => string }[] };
export async function waitForHostedBotReady(workspace: ScannerWorkspace, symbol: string, valid: () => boolean) {
    const deadline = Date.now() + 15000;
    while (valid()) {
        const blocks = workspace.getAllBlocks();
        const market = blocks.find(block => block.type === 'trade_definition_market');
        const trade = blocks.find(block => block.type === 'trade_definition_tradetype');
        const purchases = blocks.filter(block => block.type === 'purchase');
        if (
            market?.getFieldValue('SYMBOL_LIST') === symbol &&
            trade?.getFieldValue('TRADETYPE_LIST') === 'overunder' &&
            purchases.length &&
            purchases.every(block => ['DIGITOVER', 'DIGITUNDER'].includes(block.getFieldValue('PURCHASE_LIST')))
        )
            return true;
        if (Date.now() >= deadline)
            throw new Error('Bot market settings are not ready. Check the market connection and try again.');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

// Hosted strategies may update signal variables in Before Purchase. Evaluate their
// digit expression at the actual purchase, rather than retaining Bot.start's value.
export function hostedBotLivePrediction(content: string) {
    const document = new DOMParser().parseFromString(content, 'text/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid bot XML.');
    if (document.documentElement.getAttribute('neto_protected') !== 'true') return content;
    if (!document.querySelector('block[type="trade_definition_tradeoptions"] > value[name="PREDICTION"]'))
        return content;
    document.querySelectorAll('block[type="purchase"]').forEach(block => {
        let data = Array.from(block.children).find(child => child.localName === 'data');
        const previous = data?.textContent || '{}';
        let metadata: Record<string, unknown>;
        try {
            metadata = JSON.parse(previous);
        } catch {
            metadata = { neto_original_data: previous };
        }
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
            metadata = { neto_original_data: previous };
        if (!data) {
            data = document.createElement('data');
            block.appendChild(data);
        }
        data.textContent = JSON.stringify({ ...metadata, neto_live_prediction: true });
    });
    return new XMLSerializer().serializeToString(document);
}
