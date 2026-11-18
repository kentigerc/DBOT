import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PAIR_DEFAULTS, parsePairXml, exportPairXml } from '../xml';
const source = readFileSync(path.join(__dirname, '../../../../server/bots/higher-lower-pair.xml'), 'utf8');
it('loads the standalone hosted XML and round-trips edited stake/risk settings without executing anything', () => {
    expect(parsePairXml(source)).toEqual(PAIR_DEFAULTS);
    const settings = { stake: 1.5, duration: 10, stopLoss: 30, takeProfit: 5, maxPairs: 20 };
    expect(parsePairXml(exportPairXml(settings))).toEqual(settings);
});
it.each([
    '<!DOCTYPE xml [<!ENTITY x SYSTEM "https://example.test/private">]>' + source,
    source.replace('<field name="STAKE">0.35</field>', '<field name="STAKE">Infinity</field>'),
    source.replace('<field name="DURATION">5</field>', '<field name="DURATION">1</field>'),
    source.replace('<field name="STAKE">0.35</field>', '<field name="STAKE">0.35</field><field name="STAKE">5</field>'),
    source.replace('<field name="STOP_LOSS">10</field>', ''),
    source.replace('neto_higher_lower_pair', 'purchase'),
    'x'.repeat(16385),
])('rejects malformed, ambiguous or unsupported XML', xml => {
    expect(() => parsePairXml(xml)).toThrow();
});
