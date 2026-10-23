import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hostedBotMarket } from '../hosted-bot-market';

describe.each(['over-punisher.xml', 'under-punisher.xml'])('scanner selection for %s', filename => {
    const source = readFileSync(path.join(__dirname, '../../../server/bots', filename), 'utf8');
    it('changes only market fields and preserves hosted protection and all strategy blocks', () => {
        const xml = hostedBotMarket(source, 'R_100', 'random_index');
        const document = new DOMParser().parseFromString(xml, 'text/xml');
        expect(document.querySelector('field[name="SYMBOL_LIST"]')?.textContent).toBe('R_100');
        expect(document.documentElement.getAttribute('neto_protected')).toBe('true');
        const original = new DOMParser().parseFromString(source, 'text/xml');
        original.querySelector('field[name="SYMBOL_LIST"]')!.textContent = 'R_100';
        expect(document.documentElement.isEqualNode(original.documentElement)).toBe(true);
        expect(hostedBotMarket(source)).toBe(source);
    });
    it('rejects invalid market selections', () => {
        expect(() => hostedBotMarket(source, 'CRASH500')).toThrow('Invalid scanner market');
        expect(() => hostedBotMarket(source, 'R_100', '<bad>')).toThrow('Invalid scanner market');
    });
});
