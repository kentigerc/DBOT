export type PairSettings = { stake: number; duration: number; stopLoss: number; takeProfit: number; maxPairs: number };
export const PAIR_DEFAULTS: PairSettings = { stake: 0.35, duration: 5, stopLoss: 10, takeProfit: 5, maxPairs: 10 };
const fields = {
    STAKE: 'stake',
    DURATION: 'duration',
    STOP_LOSS: 'stopLoss',
    TAKE_PROFIT: 'takeProfit',
    MAX_PAIRS: 'maxPairs',
} as const;
export function parsePairXml(xml: string): PairSettings {
    if (xml.length > 16384 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid paired-order XML.');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const block = doc.documentElement.querySelector('block[type="neto_higher_lower_pair"]');
    if (
        doc.querySelector('parsererror') ||
        doc.documentElement.localName !== 'xml' ||
        !block ||
        doc.querySelectorAll('block').length !== 1
    )
        throw new Error('This is not a NetoAcademy Higher/Lower XML bot.');
    const settings = { ...PAIR_DEFAULTS };
    for (const [field, key] of Object.entries(fields) as [keyof typeof fields, keyof PairSettings][]) {
        const matches = Array.from(block.children).filter(
            e => e.localName === 'field' && e.getAttribute('name') === field
        );
        if (matches.length !== 1 || !matches[0].textContent?.trim())
            throw new Error(`Missing or duplicate XML field: ${field}.`);
        settings[key] = Number(matches[0].textContent);
    }
    const money = (n: number) =>
        Number.isFinite(n) &&
        n > 0 &&
        Number.isSafeInteger(Math.round(n * 100)) &&
        Math.abs(n * 100 - Math.round(n * 100)) < 1e-7;
    if (
        !money(settings.stake) ||
        settings.stake < 0.35 ||
        !money(settings.stopLoss) ||
        settings.stopLoss < settings.stake * 2 ||
        !money(settings.takeProfit) ||
        !Number.isInteger(settings.duration) ||
        settings.duration < 5 ||
        settings.duration > 10 ||
        !Number.isInteger(settings.maxPairs) ||
        settings.maxPairs < 1 ||
        settings.maxPairs > 100
    )
        throw new Error('Invalid XML stake, duration or session limits.');
    return settings;
}

export function exportPairXml(settings: PairSettings): string {
    const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n<xml xmlns="https://developers.google.com/blockly/xml" neto_runtime="paired-orders-v1"><block type="neto_higher_lower_pair">' +
        Object.entries(fields)
            .map(([field, key]) => `<field name="${field}">${Number(settings[key])}</field>`)
            .join('') +
        '</block></xml>';
    parsePairXml(xml);
    return xml;
}
