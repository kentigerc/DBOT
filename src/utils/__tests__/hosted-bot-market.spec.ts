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
        original.querySelectorAll('block[type="text"] > field[name="TEXT"]').forEach(field => {
            if (/now recovering/i.test(field.textContent || '')) field.textContent = 'Executing recovery.';
        });
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
describe.each(['over-punisher.xml', 'under-punisher.xml', 'over-1-over-0.xml'])(
    'XML Auto session configuration for %s',
    filename => {
        it('applies the same stake, stop loss and multiplier without editing the source XML', () => {
            const { hostedBotForAuto, hostedBotLimits } = require('../hosted-bot-market');
            const source = readFileSync(path.join(__dirname, '../../../server/bots', filename), 'utf8');
            const settings = { stake: 1.25, stopLoss: 30, multiplier: 3 };
            const configured = hostedBotForAuto(source, '1HZ10V', 'random_index', settings);
            const document = new DOMParser().parseFromString(configured, 'text/xml');
            const initial = document.querySelector('statement[name="INITIALIZATION"]')!;
            for (const name of ['Stake', 'Win Stake', 'Stop Loss']) {
                const block = Array.from(initial.querySelectorAll('block[type="variables_set"]')).find(b =>
                    Array.from(b.children).some(f => f.localName === 'field' && f.textContent === name)
                )!;
                expect(
                    block.querySelector('value[name="VALUE"] > block[type="math_number"] > field[name="NUM"]')!
                        .textContent
                ).toBe(String(name === 'Stop Loss' ? 30 : 1.25));
            }
            const factor = Array.from(document.querySelectorAll('block[type="math_arithmetic"]')).find(b =>
                b.querySelector('block[type="read_details"]')
            )!;
            expect(factor.querySelector('block[type="math_number"] > field[name="NUM"]')!.textContent).toBe('3');
            expect(hostedBotLimits(configured)).toEqual({ ...hostedBotLimits(source), stopLoss: 3000 });
            expect(readFileSync(path.join(__dirname, '../../../server/bots', filename), 'utf8')).toBe(source);
        });
    }
);
