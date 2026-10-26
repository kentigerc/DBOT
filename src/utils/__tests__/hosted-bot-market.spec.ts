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

describe.each(['over-punisher.xml', 'under-punisher.xml'])('XML Auto limits for %s', filename => {
    it('reads the existing profit and loss limits without executing or changing the XML', () => {
        const { hostedBotLimits } = require('../hosted-bot-market');
        const source = readFileSync(path.join(__dirname, '../../../server/bots', filename), 'utf8');
        expect(hostedBotLimits(source)).toEqual({ takeProfit: 1000, stopLoss: 10000 });
        expect(() => hostedBotLimits('<xml />')).toThrow('XML Auto requires valid');
    });
});

describe('XML Auto import coordination', () => {
    it('enables directions already present in XML recovery without changing purchase blocks', () => {
        const { hostedBotForAuto } = require('../hosted-bot-market');
        const source = readFileSync(path.join(__dirname, '../../../server/bots/over-punisher.xml'), 'utf8');
        const original = new DOMParser().parseFromString(hostedBotMarket(source, 'R_100'), 'text/xml');
        const automatic = new DOMParser().parseFromString(
            hostedBotForAuto(source, 'R_100', 'random_index'),
            'text/xml'
        );
        original.querySelector('block[type="trade_definition_contracttype"] > field[name="TYPE_LIST"]')!.textContent =
            'both';
        expect(automatic.documentElement.isEqualNode(original.documentElement)).toBe(true);
    });
    it('waits for market dropdowns and cancels if STOP invalidates the import', async () => {
        jest.useFakeTimers();
        const { waitForHostedBotReady } = require('../hosted-bot-market');
        let ready = false,
            valid = true;
        const workspace = {
            getAllBlocks: () => [
                { type: 'trade_definition_market', getFieldValue: () => (ready ? 'R_100' : 'na') },
                { type: 'trade_definition_tradetype', getFieldValue: () => (ready ? 'overunder' : 'na') },
                { type: 'purchase', getFieldValue: () => (ready ? 'DIGITOVER' : 'na') },
            ],
        };
        let done = false;
        const waiting = waitForHostedBotReady(workspace, 'R_100', () => valid).then((value: boolean) => {
            done = true;
            return value;
        });
        await Promise.resolve();
        expect(done).toBe(false);
        ready = true;
        await jest.advanceTimersByTimeAsync(100);
        expect(await waiting).toBe(true);
        ready = false;
        const cancelled = waitForHostedBotReady(workspace, 'R_100', () => valid);
        valid = false;
        await jest.advanceTimersByTimeAsync(100);
        expect(await cancelled).toBe(false);
        jest.useRealTimers();
    });
});
